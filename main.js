// AutoChoreo — Main Module (Phase 1 + Rigging Selection)

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { TransportController } from './sync.js';

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
let currentClip = null;      // AnimationClip extracted from current dance
let riggingMode = 'skeleton'; // 'skeleton' | 'default' | preset key | 'custom'
let showSkeleton = true;     // Skeleton overlay visibility

const riggingCache = new Map(); // url → THREE.Group (cached downloaded riggings)
const fbxLoader = new FBXLoader();
const gltfLoader = new GLTFLoader();

// ── Loading overlay helpers ─────────────────────────────────────────
function showLoading(msg) {
    loadingOverlay.textContent = msg || 'Loading...';
    loadingOverlay.style.display = 'block';
}
function hideLoading() {
    loadingOverlay.style.display = 'none';
}

// ── Load a dance FBX from URL ───────────────────────────────────────
function loadDanceFromUrl(url) {
    teardownDisplay();
    showLoading('Loading dance...');

    fbxLoader.load(
        url,
        (fbx) => {
            hideLoading();
            onDanceLoaded(fbx);
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
    teardownDisplay();

    const reader = new FileReader();
    reader.onload = (e) => {
        const loader = new FBXLoader();
        const fbx = loader.parse(e.target.result, '');
        onDanceLoaded(fbx);
    };
    reader.readAsArrayBuffer(file);
}

// ── Handle a newly loaded dance FBX ─────────────────────────────────
function onDanceLoaded(fbx) {
    danceModel = fbx;

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
    const box = new THREE.Box3().setFromObject(cloned);
    const height = box.max.y - box.min.y;
    if (height < 10) {
        cloned.scale.setScalar(100); // meters → centimeters
    }

    displayModel(cloned, false);

    // Apply the current dance animation to this rigging
    if (currentClip) {
        const mixer = new THREE.AnimationMixer(model);
        const action = mixer.clipAction(currentClip);
        action.play();

        transport.setAnimation(mixer, action, currentClip.duration);
        transport.play();
    }
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
    if (targetModel === danceModel && currentClip) {
        const mixer = new THREE.AnimationMixer(model);
        const action = mixer.clipAction(currentClip);
        action.play();

        transport.setAnimation(mixer, action, currentClip.duration);
        transport.play();
    }
}

// ── Frame camera on a model ─────────────────────────────────────────
function frameCameraOnModel(targetModel) {
    const box = new THREE.Box3().setFromObject(targetModel);
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
});

transport.on('pause', () => {
    playPauseButton.textContent = 'Play';
});

transport.on('ended', () => {
    playPauseButton.textContent = 'Play';
});

transport.on('speedchange', ({ speed }) => {
    speedValue.textContent = `${speed.toFixed(2)}x`;
    speedSlider.value = speed;
});

transport.on('timeupdate', ({ currentTime, duration }) => {
    if (!isScrubbing) {
        timeDisplay.textContent = `${fmtTime(currentTime)} / ${fmtTime(duration)}`;
        if (duration > 0) {
            scrubber.value = currentTime / duration;
        }
    }
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

// Load FBX button → trigger hidden file input
loadFbxButton.addEventListener('click', () => fbxFileInput.click());
fbxFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) loadDanceFromFile(file);
    fbxFileInput.value = '';
});

// Load Audio button → trigger hidden file input
loadAudioButton.addEventListener('click', () => audioFileInput.click());
audioFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
        await transport.loadAudio(file);
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
            if (currentClip) {
                // Animation is set up in displayModel
            }
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
    controls.update();
    renderer.render(scene, camera);
}

animate();

// ── Load default FBX on startup ─────────────────────────────────────
loadDanceFromUrl(DEFAULT_FBX);
fbxPresetSelect.value = DEFAULT_FBX;

console.log('AutoChoreo initialized (with rigging selection)');
