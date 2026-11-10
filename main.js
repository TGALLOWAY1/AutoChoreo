// AutoChoreo — Main Module
// Dances come from mocap (FBX), from a video (pose estimation → choreography),
// or from a saved choreography file, and can be performed by any loaded rig.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { TransportController } from './sync.js';
import { Choreography } from './choreo/choreography.js';
import { prepareRig, bakeClip, choreographyFromClip } from './choreo/retarget.js';
import { solveChoreography } from './choreo/solver.js';
import { extractPoseFromVideo } from './choreo/poseExtractor.js';
import { LANDMARK_BONES, LANDMARK_COUNT } from './choreo/skeleton.js';

// ── Default FBX to load on startup ──────────────────────────────────
const DEFAULT_FBX = './TEST_DATA/DancingMedium_mixamo.fbx';

// ── Rigging presets (downloadable from web) ─────────────────────────
const RIGGING_PRESETS = {
    xbot: {
        name: 'X-Bot',
        url: 'https://threejs.org/examples/models/gltf/Xbot.glb',
    },
};

// ── Transport controller (single source of truth) ───────────────────
const transport = new TransportController();

// ── DOM references ──────────────────────────────────────────────────
const playPauseButton  = document.getElementById('playPauseButton');
const speedSlider      = document.getElementById('speedSlider');
const speedValue       = document.getElementById('speedValue');
const distanceSlider   = document.getElementById('distanceSlider');
const distanceValue    = document.getElementById('distanceValue');
const fbxPresetSelect  = document.getElementById('fbxPresetSelect');
const riggingSelect    = document.getElementById('riggingSelect');
const skeletonToggle   = document.getElementById('skeletonToggle');
const loadFbxButton    = document.getElementById('loadFbxButton');
const saveChoreoButton = document.getElementById('saveChoreoButton');
const videoPanel       = document.getElementById('videoPanel');
const refVideo         = document.getElementById('refVideo');
const refOverlay       = document.getElementById('refOverlay');
const loadAudioButton  = document.getElementById('loadAudioButton');
const audioFileInput   = document.getElementById('audioFileInput');
const fbxFileInput     = document.getElementById('fbxFileInput');
const glbFileInput     = document.getElementById('glbFileInput');
const trackName        = document.getElementById('trackName');
const scrubber         = document.getElementById('scrubber');
const timeDisplay      = document.getElementById('timeDisplay');
const loadingOverlay   = document.getElementById('loadingOverlay');

// ── Three.js scene setup ────────────────────────────────────────────
const scene    = new THREE.Scene();
const camera   = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, 10000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
const clock    = new THREE.Clock();

camera.position.set(0, 100, 400);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

// OrbitControls
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.target.set(0, 90, 0);

// Lights — enhanced for character visibility
scene.add(new THREE.AmbientLight(0x404040, 0.8));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(200, 400, 300);
dirLight.castShadow = true;
scene.add(dirLight);
// Fill light from below-left to reduce dark shadows on characters
const fillLight = new THREE.DirectionalLight(0x8888ff, 0.4);
fillLight.position.set(-200, 50, -100);
scene.add(fillLight);

// Ground grid (sized for cm-scale Mixamo models)
const grid = new THREE.GridHelper(1000, 20, 0x222222, 0x111111);
scene.add(grid);

// ── Model & rigging state ───────────────────────────────────────────
let model = null;            // Currently displayed model in scene
let skeletonHelper = null;
let modelCenter = new THREE.Vector3(0, 0, 0);
let currentDistance = 5;

let danceModel = null;       // FBX model from loaded dance (contains bones, maybe mesh)
let currentClip = null;      // Native AnimationClip of the current dance (mocap dances)
let currentChoreo = null;    // Character-independent Choreography (video / imported dances)
let mocapChoreo = null;      // Choreography derived from the current mocap clip (built on demand)
let currentDanceName = 'dance';
let videoReference = null;   // { url, capture } while the current dance came from a video
let audioFromVideo = false;  // The loaded audio is the soundtrack of a dance video
let videoJob = null;         // AbortController while a video is being analysed
let riggingMode = 'skeleton'; // 'skeleton' | 'default' | preset key | 'custom'
let showSkeleton = true;     // Skeleton overlay visibility

const riggingCache = new Map(); // url → THREE.Group (cached downloaded riggings)
const fbxLoader = new FBXLoader();
const gltfLoader = new GLTFLoader();

// ── Loading overlay helpers ─────────────────────────────────────────
let messageTimer = null;
function showLoading(msg) {
    clearTimeout(messageTimer);
    loadingOverlay.textContent = msg || 'Loading...';
    loadingOverlay.style.display = 'block';
}
function hideLoading() {
    clearTimeout(messageTimer);
    loadingOverlay.style.display = 'none';
}
// Show a message that dismisses itself
function showMessage(msg, ms = 5000) {
    showLoading(msg);
    messageTimer = setTimeout(hideLoading, ms);
}

function fileBaseName(name) {
    return String(name || 'dance').split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
}

// ── Current dance → clip for a specific model ───────────────────────
function hasDance() {
    return currentChoreo !== null || currentClip !== null;
}

// A mocap dance plays its native clip. A choreography is character-independent,
// so it is baked for whichever rig is about to perform it.
function clipForModel(targetModel) {
    if (currentChoreo) return bakeClip(currentChoreo, targetModel);
    // A mocap clip carries the bone lengths of the body it was recorded on, which
    // distorts any other character. For other rigs, go through the choreography.
    if (targetModel !== danceModel) {
        try {
            return bakeClip(getMocapChoreography(), targetModel);
        } catch (err) {
            console.warn('Retargeting unavailable, playing the raw clip:', err.message);
        }
    }
    return currentClip;
}

function getMocapChoreography() {
    if (!mocapChoreo) {
        if (!currentClip || !danceModel) throw new Error('Load a dance first.');
        mocapChoreo = choreographyFromClip(currentClip, danceModel, { name: currentDanceName });
    }
    return mocapChoreo;
}

// Bounding box of a model's skeleton in world space. Skinned meshes report
// unreliable bounds (their geometry lives in bind space), bones do not.
function modelBounds(targetModel) {
    targetModel.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const p = new THREE.Vector3();
    targetModel.traverse((child) => {
        if (child.isBone) box.expandByPoint(child.getWorldPosition(p));
    });
    if (box.isEmpty()) box.setFromObject(targetModel);
    return box;
}

function startAnimation(targetModel) {
    if (!hasDance()) return;
    let clip;
    try {
        clip = clipForModel(targetModel);
    } catch (err) {
        console.error(err);
        showMessage(err.message);
        return;
    }
    const mixer = new THREE.AnimationMixer(targetModel);
    const action = mixer.clipAction(clip);
    action.play();
    transport.setAnimation(mixer, action, clip.duration);
    transport.play();
}

// Called whenever a different dance (from any source) becomes current
function beginNewDance(name) {
    currentDanceName = name || 'dance';
    setVideoReference(null);
    if (audioFromVideo) {
        transport.clearAudio();
        audioFromVideo = false;
    }
    transport.seek(0);
}

// A video analysis still in flight must not overwrite a dance chosen after it
// started. Called whenever another dance is selected.
function supersedeVideoJob() {
    if (!videoJob) return;
    videoJob.superseded = true;
    videoJob.abort();
    videoJob = null;
    hideLoading(); // drop its progress message; the new dance shows its own
}

// ── Load a dance FBX from URL ───────────────────────────────────────
function loadDanceFromUrl(url) {
    supersedeVideoJob();
    teardownDisplay();
    showLoading('Loading dance...');

    fbxLoader.load(
        url,
        (fbx) => {
            hideLoading();
            onDanceLoaded(fbx, fileBaseName(url));
        },
        undefined,
        (err) => {
            hideLoading();
            console.error('Error loading FBX:', err);
        }
    );
}

// ── Load a dance FBX from a File object ─────────────────────────────
function loadDanceFromFile(file) {
    supersedeVideoJob();
    teardownDisplay();

    const reader = new FileReader();
    reader.onload = (e) => {
        const loader = new FBXLoader();
        const fbx = loader.parse(e.target.result, '');
        onDanceLoaded(fbx, fileBaseName(file.name));
    };
    reader.readAsArrayBuffer(file);
}

// ── Handle a newly loaded dance FBX ─────────────────────────────────
function onDanceLoaded(fbx, name) {
    danceModel = fbx;
    currentChoreo = null;
    mocapChoreo = null;
    beginNewDance(name);

    // Record the rest pose now, before any animation touches the skeleton
    try {
        prepareRig(fbx);
    } catch (err) {
        console.warn('This FBX cannot perform choreographies:', err.message);
    }

    // Extract animation clip
    if (fbx.animations && fbx.animations.length > 0) {
        currentClip = fbx.animations[0];
        console.log('Dance loaded:', currentClip.name, `(${currentClip.duration.toFixed(1)}s)`);
    } else {
        currentClip = null;
        console.warn('No animations found in FBX file');
    }

    // Display based on current rigging mode
    applyCurrentRigging();
}

// ── Make a choreography (from video or file) the current dance ──────
async function setChoreography(choreo) {
    // A choreography needs a body to perform it: fall back to the default character
    if (!danceModel) {
        danceModel = await fbxLoader.loadAsync(DEFAULT_FBX);
        prepareRig(danceModel);
    }
    currentChoreo = choreo;
    currentClip = null;
    fbxPresetSelect.value = '';
    beginNewDance(choreo.name);
    applyCurrentRigging();
}

// ── Load a dance from a video: landmarks → joint rotations → choreography ──
async function loadDanceFromVideo(file) {
    if (videoJob) return;
    const job = new AbortController();
    videoJob = job;
    // Stop if cancelled (Esc) or superseded by another dance while we were waiting
    const checkCurrent = () => {
        if (job.signal.aborted) throw new DOMException('Video analysis cancelled', 'AbortError');
    };
    transport.pause();
    try {
        showLoading('Loading pose model… (Esc to cancel)');
        const capture = await extractPoseFromVideo(file, {
            signal: job.signal,
            onProgress: ({ stage, fraction }) => {
                if (job.signal.aborted) return;
                showLoading(`${stage}… ${Math.round(fraction * 100)}% (Esc to cancel)`);
            },
        });
        checkCurrent();
        showLoading('Solving joint rotations…');
        await new Promise((resolve) => setTimeout(resolve, 0)); // let the message paint
        checkCurrent();
        const choreo = solveChoreography(capture);
        await setChoreography(choreo);
        checkCurrent();
        setVideoReference({ url: URL.createObjectURL(file), capture });

        // Use the video's own soundtrack when it has one
        try {
            await transport.loadAudio(file);
            audioFromVideo = true;
        } catch (_) {
            // Silent video (or undecodable audio): keep whatever audio is already loaded
        }
        if (job.signal.aborted) {
            // Another dance was chosen while the soundtrack decoded: it must not keep this audio
            if (audioFromVideo) {
                transport.clearAudio();
                audioFromVideo = false;
            }
            checkCurrent();
        }
        transport.seek(0);
        transport.play();

        const missed = capture.frameCount - choreo.source.detectedFrames;
        if (missed > capture.frameCount * 0.2) {
            showMessage(`No dancer was found in ${missed} of ${capture.frameCount} frames — the motion there is interpolated.`);
        } else {
            hideLoading();
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            // When superseded, the overlay now belongs to the dance that replaced this one
            if (!job.superseded) hideLoading();
        } else {
            console.error('Error analysing video:', err);
            showMessage(`Could not learn a dance from this video: ${err.message}`);
        }
        if (!job.superseded && !transport.hasAnimation && danceModel) applyCurrentRigging();
    } finally {
        if (videoJob === job) videoJob = null;
    }
}

// ── Load a saved choreography (.json) ───────────────────────────────
async function loadChoreographyFromFile(file) {
    supersedeVideoJob();
    try {
        const choreo = Choreography.fromJSON(await file.text());
        await setChoreography(choreo);
    } catch (err) {
        console.error('Error loading choreography:', err);
        showMessage(`Could not load choreography: ${err.message}`);
    }
}

// ── Save the current dance as a character-independent choreography ──
function saveChoreography() {
    let choreo = currentChoreo;
    try {
        if (!choreo) choreo = getMocapChoreography();
    } catch (err) {
        showMessage(err.message, 3000);
        return;
    }
    const blob = new Blob([JSON.stringify(choreo)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${fileBaseName(choreo.name)}.choreo.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// ── Pick the right loader for a dropped/selected dance file ─────────
function loadDanceFile(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.fbx')) {
        loadDanceFromFile(file);
    } else if (name.endsWith('.json')) {
        loadChoreographyFromFile(file);
    } else if (file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv)$/.test(name)) {
        loadDanceFromVideo(file);
    } else {
        showMessage('Unsupported file. Choose an FBX, a video, or a choreography .json.');
    }
}

// ── Reference video panel (the source video with tracked landmarks) ─
function setVideoReference(ref) {
    if (videoReference) URL.revokeObjectURL(videoReference.url);
    videoReference = ref;
    if (!ref) {
        videoPanel.style.display = 'none';
        refVideo.pause();
        refVideo.removeAttribute('src');
        refVideo.load();
        return;
    }
    refVideo.src = ref.url;
    refVideo.playbackRate = transport.speed;
    refOverlay.width = ref.capture.width;
    refOverlay.height = ref.capture.height;
    videoPanel.style.display = 'block';
}

// Where the reference video should be for a given transport time (it loops with the dance)
function referenceTime(t) {
    const d = videoReference.capture.duration;
    return d > 0 && t >= d ? (transport.duration <= d + 1e-6 ? d : t % d) : t;
}

function syncReferenceVideo(force) {
    if (!videoReference) return;
    const target = referenceTime(transport.currentTime);
    if (force || Math.abs(refVideo.currentTime - target) > 0.1) refVideo.currentTime = target;
    if (transport.playing && refVideo.paused) refVideo.play().catch(() => {});
    if (!transport.playing && !refVideo.paused) refVideo.pause();
}

// Draw the tracked stick figure for the frame the reference video is showing
function drawReferenceOverlay() {
    if (!videoReference) return;
    const { capture } = videoReference;
    const ctx = refOverlay.getContext('2d');
    ctx.clearRect(0, 0, refOverlay.width, refOverlay.height);
    const frame = Math.max(0, Math.min(capture.frameCount - 1, Math.floor(refVideo.currentTime * capture.fps)));
    const lm = capture.image[frame];
    if (!lm) return;
    const px = (i) => [lm[i * 4] * capture.width, lm[i * 4 + 1] * capture.height];
    const unit = Math.max(capture.width, capture.height) / 160;
    ctx.lineWidth = unit;
    ctx.strokeStyle = '#00d9ff';
    ctx.beginPath();
    for (const [a, b] of LANDMARK_BONES) {
        ctx.moveTo(...px(a));
        ctx.lineTo(...px(b));
    }
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    for (let i = 11; i < LANDMARK_COUNT; i++) {
        const [x, y] = px(i);
        ctx.beginPath();
        ctx.arc(x, y, unit * 0.9, 0, Math.PI * 2);
        ctx.fill();
    }
}

// ── Apply the current rigging mode ──────────────────────────────────
function applyCurrentRigging() {
    if (riggingMode === 'skeleton' || riggingMode === 'default') {
        // Use the dance model directly
        if (danceModel) {
            displayModel(danceModel, riggingMode === 'skeleton');
        }
    } else if (riggingMode === 'custom' && riggingCache.has('__custom__')) {
        // Use custom-loaded rigging
        displayRiggingWithAnimation(riggingCache.get('__custom__'));
    } else if (RIGGING_PRESETS[riggingMode]) {
        // Use a preset rigging — load if not cached
        const preset = RIGGING_PRESETS[riggingMode];
        if (riggingCache.has(preset.url)) {
            displayRiggingWithAnimation(riggingCache.get(preset.url));
        } else {
            loadRiggingFromUrl(preset.url);
        }
    } else {
        // Fallback to dance model
        if (danceModel) {
            displayModel(danceModel, true);
        }
    }
}

// ── Load a rigging model from URL (GLB/GLTF) ───────────────────────
function loadRiggingFromUrl(url) {
    // Check cache first
    if (riggingCache.has(url)) {
        displayRiggingWithAnimation(riggingCache.get(url));
        return;
    }

    teardownDisplay();
    showLoading('Downloading rigging...');

    gltfLoader.load(
        url,
        (gltf) => {
            hideLoading();
            const rigModel = gltf.scene;
            riggingCache.set(url, rigModel);
            displayRiggingWithAnimation(rigModel);
        },
        (progress) => {
            if (progress.total > 0) {
                const pct = Math.round((progress.loaded / progress.total) * 100);
                loadingOverlay.textContent = `Downloading rigging... ${pct}%`;
            }
        },
        (err) => {
            hideLoading();
            console.error('Error loading rigging:', err);
            // Fall back to skeleton mode
            riggingMode = 'skeleton';
            riggingSelect.value = 'skeleton';
            if (danceModel) displayModel(danceModel, true);
        }
    );
}

// ── Load a rigging from a local File (GLB/GLTF/FBX) ────────────────
function loadRiggingFromFile(file) {
    teardownDisplay();

    const reader = new FileReader();
    reader.onload = (e) => {
        const ext = file.name.toLowerCase().split('.').pop();
        let rigModel;

        if (ext === 'fbx') {
            const loader = new FBXLoader();
            rigModel = loader.parse(e.target.result, '');
        } else {
            // GLB/GLTF
            const loader = new GLTFLoader();
            loader.parse(e.target.result, '', (gltf) => {
                rigModel = gltf.scene;
                riggingCache.set('__custom__', rigModel);
                displayRiggingWithAnimation(rigModel);
            }, (err) => {
                console.error('Error parsing rigging file:', err);
            });
            return; // async parse
        }

        riggingCache.set('__custom__', rigModel);
        displayRiggingWithAnimation(rigModel);
    };
    reader.readAsArrayBuffer(file);
}

// ── Display a rigging model with the current animation applied ──────
function displayRiggingWithAnimation(sourceModel) {
    teardownDisplay();

    // Clone so the cached original stays clean
    const cloned = SkeletonUtils.clone(sourceModel);

    // Scale GLB models to match Mixamo scale (GLB is meters, Mixamo FBX is cm)
    // Detect by checking bounding box — if model is < 10 units tall, scale up
    const box = modelBounds(cloned);
    const height = box.max.y - box.min.y;
    if (height < 10) {
        cloned.scale.setScalar(100); // meters → centimeters
    }

    // Record the rest pose (after scaling) so choreographies can be baked for this rig
    try {
        prepareRig(cloned);
    } catch (err) {
        console.warn('Rigging cannot perform choreographies:', err.message);
    }

    displayModel(cloned, false);

    // Apply the current dance animation to this rigging
    startAnimation(model);
}

// ── Display a model in the scene ────────────────────────────────────
function displayModel(targetModel, hideAllMeshes) {
    teardownDisplay();

    model = targetModel;

    // Control mesh visibility
    model.traverse((child) => {
        if (child.isMesh || child.isSkinnedMesh) {
            child.visible = !hideAllMeshes;
            child.castShadow = true;
            child.receiveShadow = true;
            // Ensure materials are double-sided for visibility
            if (child.material) {
                const mats = Array.isArray(child.material) ? child.material : [child.material];
                mats.forEach(mat => { mat.side = THREE.DoubleSide; });
            }
        }
    });

    scene.add(model);

    // Skeleton helper
    skeletonHelper = new THREE.SkeletonHelper(model);
    skeletonHelper.material.color.set(0x00d9ff);
    skeletonHelper.visible = showSkeleton;
    scene.add(skeletonHelper);

    // Compute bounding box and frame camera
    frameCameraOnModel(model);

    // If using the dance model directly (skeleton/default mode), set up animation
    if (targetModel === danceModel) {
        startAnimation(model);
    }
}

// ── Frame camera on a model ─────────────────────────────────────────
function frameCameraOnModel(targetModel) {
    const box = modelBounds(targetModel);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    modelCenter.copy(center);

    const maxDim = Math.max(size.x, size.y, size.z);
    const baseDistance = maxDim * 3;
    currentDistance = baseDistance;

    camera.position.set(center.x, center.y, center.z + baseDistance);
    camera.lookAt(center);
    controls.target.copy(center);
    controls.update();

    distanceSlider.min = baseDistance * 0.3;
    distanceSlider.max = baseDistance * 4;
    distanceSlider.value = baseDistance;
    updateDistanceDisplay();
}

// ── Tear down displayed model ───────────────────────────────────────
function teardownDisplay() {
    if (skeletonHelper) {
        scene.remove(skeletonHelper);
        skeletonHelper = null;
    }
    if (model) {
        scene.remove(model);
        model = null;
    }
    transport.setAnimation(null, null, 0);
}

// ── Set mesh visibility on a model ──────────────────────────────────
function setMeshVisibility(targetModel, visible) {
    if (!targetModel) return;
    targetModel.traverse((child) => {
        if (child.isMesh || child.isSkinnedMesh) {
            child.visible = visible;
        }
    });
}

// ── Camera distance helper ──────────────────────────────────────────
function updateCameraDistance() {
    if (!model) return;
    const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
    dir.multiplyScalar(currentDistance);
    camera.position.copy(controls.target).add(dir);
    controls.update();
}

function updateDistanceDisplay() {
    const min = parseFloat(distanceSlider.min);
    const max = parseFloat(distanceSlider.max);
    const pct = ((currentDistance - min) / (max - min)) * 100;
    distanceValue.textContent = `${pct.toFixed(0)}%`;
}

// ── Time formatting ─────────────────────────────────────────────────
function fmtTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── Transport event listeners ───────────────────────────────────────
let isScrubbing = false;

transport.on('play', () => {
    playPauseButton.textContent = 'Pause';
    syncReferenceVideo(true);
});

transport.on('pause', () => {
    playPauseButton.textContent = 'Play';
    syncReferenceVideo(true);
});

transport.on('seek', () => syncReferenceVideo(true));

transport.on('ended', () => {
    playPauseButton.textContent = 'Play';
});

transport.on('speedchange', ({ speed }) => {
    speedValue.textContent = `${speed.toFixed(2)}x`;
    speedSlider.value = speed;
    refVideo.playbackRate = speed;
});

transport.on('timeupdate', ({ currentTime, duration }) => {
    if (!isScrubbing) {
        timeDisplay.textContent = `${fmtTime(currentTime)} / ${fmtTime(duration)}`;
        if (duration > 0) {
            scrubber.value = currentTime / duration;
        }
    }
    syncReferenceVideo(false);
});

transport.on('durationchange', ({ duration }) => {
    timeDisplay.textContent = `${fmtTime(transport.currentTime)} / ${fmtTime(duration)}`;
});

transport.on('audioloaded', ({ name }) => {
    trackName.textContent = name;
});

// ── UI event handlers ───────────────────────────────────────────────

// Play / Pause
playPauseButton.addEventListener('click', () => transport.togglePlayPause());

// Speed slider
speedSlider.addEventListener('input', (e) => {
    transport.setSpeed(parseFloat(e.target.value));
});
speedValue.textContent = `${transport.speed.toFixed(2)}x`;

// Distance slider
distanceSlider.addEventListener('input', (e) => {
    currentDistance = parseFloat(e.target.value);
    updateCameraDistance();
    updateDistanceDisplay();
});

// Scrubber
scrubber.addEventListener('mousedown', () => { isScrubbing = true; });
scrubber.addEventListener('touchstart', () => { isScrubbing = true; }, { passive: true });

scrubber.addEventListener('input', () => {
    const t = parseFloat(scrubber.value) * transport.duration;
    timeDisplay.textContent = `${fmtTime(t)} / ${fmtTime(transport.duration)}`;
});

function endScrub() {
    if (!isScrubbing) return;
    isScrubbing = false;
    const t = parseFloat(scrubber.value) * transport.duration;
    transport.seek(t);
}
scrubber.addEventListener('mouseup', endScrub);
scrubber.addEventListener('touchend', endScrub);
scrubber.addEventListener('change', endScrub); // fallback

// FBX preset dropdown (dance selection)
fbxPresetSelect.addEventListener('change', (e) => {
    const url = e.target.value;
    if (url) {
        loadDanceFromUrl(url);
    }
});

// Load Dance button → trigger hidden file input (FBX, video, or choreography JSON)
loadFbxButton.addEventListener('click', () => fbxFileInput.click());
fbxFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) loadDanceFile(file);
    fbxFileInput.value = '';
});

// Save the current dance as a reusable choreography file
saveChoreoButton.addEventListener('click', saveChoreography);

// Esc cancels a video analysis in progress
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && videoJob) videoJob.abort();
});

// Load Audio button → trigger hidden file input
loadAudioButton.addEventListener('click', () => audioFileInput.click());
audioFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
        await transport.loadAudio(file);
        audioFromVideo = false;
    }
    audioFileInput.value = '';
});

// ── Rigging selection ───────────────────────────────────────────────
riggingSelect.addEventListener('change', (e) => {
    const value = e.target.value;

    if (value === 'custom') {
        // Open file picker for custom GLB
        glbFileInput.click();
        return;
    }

    riggingMode = value;

    if (value === 'skeleton') {
        // Show skeleton only from dance model
        if (danceModel) {
            showSkeleton = true;
            skeletonToggle.checked = true;
            displayModel(danceModel, true);
        }
    } else if (value === 'default') {
        // Show mesh from dance model
        if (danceModel) {
            displayModel(danceModel, false);
        }
    } else if (RIGGING_PRESETS[value]) {
        // Download and display preset rigging
        const preset = RIGGING_PRESETS[value];
        if (riggingCache.has(preset.url)) {
            displayRiggingWithAnimation(riggingCache.get(preset.url));
        } else {
            loadRiggingFromUrl(preset.url);
        }
    }
});

// Custom GLB file input
glbFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        riggingMode = 'custom';
        loadRiggingFromFile(file);
    } else {
        // User cancelled — revert dropdown to previous value
        riggingSelect.value = riggingMode;
    }
    glbFileInput.value = '';
});

// Skeleton toggle
skeletonToggle.addEventListener('change', (e) => {
    showSkeleton = e.target.checked;
    if (skeletonHelper) {
        skeletonHelper.visible = showSkeleton;
    }
});

// ── Resize handler ──────────────────────────────────────────────────
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// ── Animation loop ──────────────────────────────────────────────────
function animate() {
    requestAnimationFrame(animate);

    const delta = clock.getDelta();
    transport.tick(delta);
    drawReferenceOverlay();
    controls.update();
    renderer.render(scene, camera);
}

animate();

// ── Load default FBX on startup ─────────────────────────────────────
loadDanceFromUrl(DEFAULT_FBX);
fbxPresetSelect.value = DEFAULT_FBX;

console.log('AutoChoreo initialized');
