// AutoChoreo — Main Module (Phase 1)

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { TransportController } from './sync.js';

// ── Default FBX to load on startup ──────────────────────────────────
const DEFAULT_FBX = './TEST_DATA/DancingMedium_mixamo.fbx';

// ── Transport controller (single source of truth) ───────────────────
const transport = new TransportController();

// ── DOM references ──────────────────────────────────────────────────
const playPauseButton  = document.getElementById('playPauseButton');
const speedSlider      = document.getElementById('speedSlider');
const speedValue       = document.getElementById('speedValue');
const distanceSlider   = document.getElementById('distanceSlider');
const distanceValue    = document.getElementById('distanceValue');
const fbxPresetSelect  = document.getElementById('fbxPresetSelect');
const loadFbxButton    = document.getElementById('loadFbxButton');
const loadAudioButton  = document.getElementById('loadAudioButton');
const audioFileInput   = document.getElementById('audioFileInput');
const fbxFileInput     = document.getElementById('fbxFileInput');
const trackName        = document.getElementById('trackName');
const scrubber         = document.getElementById('scrubber');
const timeDisplay      = document.getElementById('timeDisplay');

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

// Lights
scene.add(new THREE.AmbientLight(0x404040, 0.6));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
dirLight.position.set(200, 400, 300);
dirLight.castShadow = true;
scene.add(dirLight);

// Ground grid (sized for cm-scale Mixamo models)
const grid = new THREE.GridHelper(1000, 20, 0x222222, 0x111111);
scene.add(grid);

// ── Model state ─────────────────────────────────────────────────────
let model = null;
let skeletonHelper = null;
let modelCenter = new THREE.Vector3(0, 0, 0);
let currentDistance = 5;
const fbxLoader = new FBXLoader();

// ── Load an FBX from URL ────────────────────────────────────────────
function loadFbxFromUrl(url) {
    // Tear down previous model
    teardownModel();

    fbxLoader.load(
        url,
        (fbx) => setupModel(fbx),
        undefined,
        (err) => console.error('Error loading FBX:', err)
    );
}

// ── Load an FBX from a File object ──────────────────────────────────
function loadFbxFromFile(file) {
    teardownModel();

    const reader = new FileReader();
    reader.onload = (e) => {
        const loader = new FBXLoader();
        const fbx = loader.parse(e.target.result, '');
        setupModel(fbx);
    };
    reader.readAsArrayBuffer(file);
}

// ── Tear down current model/skeleton/mixer ──────────────────────────
function teardownModel() {
    if (skeletonHelper) {
        scene.remove(skeletonHelper);
        skeletonHelper = null;
    }
    if (model) {
        scene.remove(model);
        model = null;
    }
    // Unset animation on transport (but keep audio)
    transport.setAnimation(null, null, 0);
}

// ── Set up a loaded FBX object ──────────────────────────────────────
function setupModel(fbx) {
    model = fbx;
    // Mixamo FBX files are in centimeters (~180 units tall). No manual scale.
    // Bounding box and camera setup adapt to whatever units the file uses.

    skeletonHelper = new THREE.SkeletonHelper(model);
    skeletonHelper.material.color.set(0x00d9ff);

    scene.add(model);
    scene.add(skeletonHelper);

    // Compute bounding box from model geometry
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    modelCenter.copy(center);

    const maxDim = Math.max(size.x, size.y, size.z);
    const baseDistance = maxDim * 3;
    currentDistance = baseDistance;

    // Position camera in front of model, centered
    camera.position.set(center.x, center.y, center.z + baseDistance);
    camera.lookAt(center);
    controls.target.copy(center);
    controls.update();

    // Distance slider range
    distanceSlider.min = baseDistance * 0.3;
    distanceSlider.max = baseDistance * 4;
    distanceSlider.value = baseDistance;
    updateDistanceDisplay();

    // Animation
    if (fbx.animations && fbx.animations.length > 0) {
        const mixer = new THREE.AnimationMixer(model);
        const action = mixer.clipAction(fbx.animations[0]);
        action.play();

        const clipDuration = fbx.animations[0].duration;
        transport.setAnimation(mixer, action, clipDuration);

        // Auto-play
        transport.play();
        console.log('Animation loaded:', fbx.animations[0].name, `(${clipDuration.toFixed(1)}s)`);
    } else {
        console.warn('No animations found in FBX file');
    }
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

// FBX preset dropdown
fbxPresetSelect.addEventListener('change', (e) => {
    const url = e.target.value;
    if (url) {
        loadFbxFromUrl(url);
    }
});

// Load FBX button → trigger hidden file input
loadFbxButton.addEventListener('click', () => fbxFileInput.click());
fbxFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) loadFbxFromFile(file);
    fbxFileInput.value = ''; // reset so same file can be reloaded
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
loadFbxFromUrl(DEFAULT_FBX);
fbxPresetSelect.value = DEFAULT_FBX;

console.log('AutoChoreo initialized');
