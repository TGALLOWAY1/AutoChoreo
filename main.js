// AutoChoreo MVP - Main Module

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

// Configuration: Change this to load a different FBX file from TEST_DATA/
const FBX_FILE = './TEST_DATA/DancingMedium_mixamo.fbx';

let isPlaying = false;
let currentSpeed = 1.0;

// Initialize UI controls
const playPauseButton = document.getElementById('playPauseButton');
const speedSlider = document.getElementById('speedSlider');
const speedValue = document.getElementById('speedValue');

// Three.js scene setup
const scene = new THREE.Scene();

// Camera
const camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
);
camera.position.set(0, 5, 10);

// Renderer
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

// OrbitControls with damping
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.target.set(0, 2, 0);

// Lights
const ambientLight = new THREE.AmbientLight(0x404040, 0.6);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 1.1);
directionalLight.position.set(5, 10, 5);
directionalLight.castShadow = true;
scene.add(directionalLight);

// Ground grid (dimmed to make dancer stand out)
const gridHelper = new THREE.GridHelper(20, 20, 0x222222, 0x111111);
gridHelper.position.y = 0;
scene.add(gridHelper);

// Animation system
const clock = new THREE.Clock();
let mixer = null;
let action = null;

// FBX Loader
const fbxLoader = new FBXLoader();
let model = null;
let skeletonHelper = null;

// Load FBX mocap file
fbxLoader.load(
    FBX_FILE,
    (fbx) => {
        model = fbx;
        model.scale.setScalar(0.01); // Mixamo FBX files are in centimeters, scale to meters
        
        skeletonHelper = new THREE.SkeletonHelper(model);
        skeletonHelper.material.color.set(0x00d9ff);
        
        scene.add(model);
        scene.add(skeletonHelper);
        
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const distance = maxDim * 2;
        
        camera.position.set(center.x, center.y + size.y * 0.3, center.z + distance);
        camera.lookAt(center);
        controls.target.copy(center);
        controls.update();
        
        mixer = new THREE.AnimationMixer(model);
        
        if (fbx.animations && fbx.animations.length > 0) {
            action = mixer.clipAction(fbx.animations[0]);
            action.play();
            action.setEffectiveTimeScale(currentSpeed);
            isPlaying = true;
            playPauseButton.textContent = 'Pause';
            console.log('Animation loaded:', fbx.animations[0].name);
        } else {
            console.warn('No animations found in FBX file');
        }
    },
    undefined,
    (error) => {
        console.error('Error loading FBX file:', error);
    }
);

// Resize handler
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Animation loop
function animate() {
    requestAnimationFrame(animate);
    
    // Update animation mixer
    if (mixer) {
        mixer.update(clock.getDelta());
    }
    
    controls.update();
    renderer.render(scene, camera);
}

// Start animation loop
animate();

// Log initialization
console.log('AutoChoreo MVP initialized');
console.log('Loading FBX from:', FBX_FILE);

playPauseButton.addEventListener('click', () => {
    if (action) {
        isPlaying = !isPlaying;
        action.paused = !isPlaying;
        playPauseButton.textContent = isPlaying ? 'Pause' : 'Play';
    }
});

speedSlider.addEventListener('input', (e) => {
    currentSpeed = parseFloat(e.target.value);
    speedValue.textContent = `${currentSpeed.toFixed(2)}x`;
    if (action) {
        action.setEffectiveTimeScale(currentSpeed);
    }
});

speedValue.textContent = `${currentSpeed.toFixed(2)}x`;

