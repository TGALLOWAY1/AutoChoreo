// AutoChoreo — Reference stage: a 3D dancer performing a routine
//
// Renders a choreography on a character with the app's own retargeting
// (./choreo/retarget.js), driven by the shared transport so it stays on the
// musical timeline, and draws the tracked joints over it like the overlay on
// the dancer's camera view.

import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { prepareRig, bakeClip } from '../choreo/retarget.js';
import { JOINT_NAMES, JOINT_BY_NAME, normalizeBoneName } from '../choreo/skeleton.js';
import { KEYPOINTS, KP_COUNT, keypointsFromPose } from '../choreo/compare.js';
import { createPose, samplePose } from '../choreo/pose.js';
import { drawSkeleton2D, prepareCanvas, COLORS } from './overlay.js';

// Which rig joint stands in for each comparison keypoint
const KEYPOINT_JOINT = {
    nose: 'head',
    leftShoulder: 'leftUpperArm', rightShoulder: 'rightUpperArm',
    leftElbow: 'leftLowerArm', rightElbow: 'rightLowerArm',
    leftWrist: 'leftHand', rightWrist: 'rightHand',
    leftHip: 'leftUpperLeg', rightHip: 'rightUpperLeg',
    leftKnee: 'leftLowerLeg', rightKnee: 'rightLowerLeg',
    leftAnkle: 'leftFoot', rightAnkle: 'rightFoot',
};

export class Stage {
    /**
     * @param {HTMLElement} container
     * @param {object} [o]
     * @param {import('../sync.js').TransportController} [o.transport]  Drives the animation when given.
     */
    constructor(container, { transport = null } = {}) {
        this.container = container;
        this.transport = transport;
        this.mode = 'character';
        this.showJoints = true;
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.domElement.className = 'stage-gl';
        container.appendChild(this.renderer.domElement);
        this.overlay = document.createElement('canvas');
        this.overlay.className = 'stage-overlay';
        container.appendChild(this.overlay);

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(30, 1, 1, 10000);
        this.scene.add(new THREE.HemisphereLight(0xd9ccff, 0x1a1030, 1.4));
        const key = new THREE.DirectionalLight(0xffffff, 1.6);
        key.position.set(150, 400, 400);
        this.scene.add(key);
        const rim = new THREE.DirectionalLight(0xa855f7, 1.6);
        rim.position.set(-300, 200, -300);
        this.scene.add(rim);
        const floor = new THREE.Mesh(
            new THREE.CircleGeometry(1, 64),
            new THREE.MeshBasicMaterial({ color: 0x7c3aed, transparent: true, opacity: 0.12 })
        );
        floor.rotation.x = -Math.PI / 2;
        this.floor = floor;
        this.scene.add(floor);

        this.model = null;
        this.rig = null;
        this.mixer = null;
        this.helper = null;
        this.choreo = null;
        this._points = new Array(KEYPOINTS.length).fill(null);
        this._v = new THREE.Vector3();
        this._resize = new ResizeObserver(() => this.resize());
        this._resize.observe(container);
    }

    /** Use a loaded FBX (in its rest pose) as the dancer's body. */
    setBody(fbx) {
        if (this.model) this.scene.remove(this.model);
        if (this.helper) this.scene.remove(this.helper);
        const model = SkeletonUtils.clone(fbx);
        this.rig = prepareRig(model);
        model.traverse((o) => {
            if (o.isMesh || o.isSkinnedMesh) {
                o.frustumCulled = false;
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                mats.forEach((m) => { if (m) m.side = THREE.DoubleSide; });
            }
        });
        this.model = model;
        this.scene.add(model);
        this.helper = new THREE.SkeletonHelper(model);
        this.helper.material.color.set(0xb57bff);
        this.helper.material.linewidth = 2;
        this.scene.add(this.helper);
        this._mapJoints();
        this.setMode(this.mode);
        if (this.choreo) this.setChoreography(this.choreo);
    }

    _mapJoints() {
        const rig = this.rig;
        this._bones = KEYPOINTS.map(([name]) => {
            const joint = KEYPOINT_JOINT[name];
            if (joint) {
                const i = rig.jointBone[JOINT_NAMES.indexOf(joint)];
                return i >= 0 ? rig.bones[i] : null;
            }
            // Toes: the bone at the far end of the foot
            const side = name.startsWith('left') ? 'left' : 'right';
            const aliases = (JOINT_BY_NAME[`${side}Foot`].tailBones || []).map(normalizeBoneName);
            return rig.bones.find((b) => aliases.includes(normalizeBoneName(b.name))) || null;
        });
    }

    /** 'character' (the mesh) or 'skeleton' (bones only). */
    setMode(mode) {
        this.mode = mode;
        if (!this.model) return;
        this.model.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) o.visible = mode === 'character'; });
        this.helper.visible = mode === 'skeleton';
    }

    /** Perform a choreography (baked for this body). */
    setChoreography(choreo) {
        this.choreo = choreo;
        if (!this.model) return;
        const clip = bakeClip(choreo, this.model);
        this.mixer = new THREE.AnimationMixer(this.model);
        const action = this.mixer.clipAction(clip);
        action.play();
        if (this.transport) {
            this.transport.setAnimation(this.mixer, action, clip.duration);
        } else {
            this._action = action;
            action.paused = false;
            action.setEffectiveTimeScale(0);
            this.setTime(0);
        }
        this.frame();
    }

    /** Pose the dancer at a time (only when not driven by a transport). */
    setTime(t) {
        if (!this._action || !this.mixer) return;
        this._action.time = Math.max(0, Math.min(t, this._action.getClip().duration));
        this.mixer.update(0);
    }

    /**
     * Where the dance reaches, in hip heights (arms, jumps and travel
     * included), sampled from the choreography by forward kinematics.
     */
    _danceBounds() {
        if (this._bounds && this._bounds.choreo === this.choreo) return this._bounds;
        const pose = createPose();
        const kp = new Float32Array(KP_COUNT * 3);
        const b = { choreo: this.choreo, minX: Infinity, maxX: -Infinity, maxY: 0, minZ: Infinity, maxZ: -Infinity };
        const n = Math.min(240, this.choreo.frameCount);
        for (let i = 0; i < n; i++) {
            samplePose(this.choreo, (i / Math.max(1, n - 1)) * this.choreo.duration, pose);
            keypointsFromPose(pose, kp);
            for (let k = 0; k < KP_COUNT; k++) {
                b.minX = Math.min(b.minX, kp[k * 3]); b.maxX = Math.max(b.maxX, kp[k * 3]);
                b.maxY = Math.max(b.maxY, kp[k * 3 + 1]);
                b.minZ = Math.min(b.minZ, kp[k * 3 + 2]); b.maxZ = Math.max(b.maxZ, kp[k * 3 + 2]);
            }
        }
        this._bounds = b;
        return b;
    }

    /** Point the camera at the whole performance area (reach and travel included), from the front. */
    frame() {
        if (!this.rig || !this.choreo) return;
        const { hipHeight, restLegMid } = this.rig;
        const b = this._danceBounds();
        const height = (b.maxY + 0.25) * hipHeight;      // top of the head / raised hands, plus headroom
        const width = (b.maxX - b.minX + 0.35) * hipHeight;
        const cx = restLegMid.x + ((b.minX + b.maxX) / 2) * hipHeight;
        const cy = height * 0.5 - 0.05 * hipHeight;
        const cz = restLegMid.z + ((b.minZ + b.maxZ) / 2) * hipHeight;
        const aspect = this.camera.aspect || 1;
        const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
        const dist = Math.max(height / 2 / tan, width / 2 / (tan * aspect)) * 1.05 + ((b.maxZ - b.minZ) / 2) * hipHeight;
        this.camera.position.set(cx, cy + hipHeight * 0.08, cz + dist);
        this.camera.lookAt(cx, cy, cz);
        this.camera.near = Math.max(1, dist / 50);
        this.camera.far = dist * 10;
        this.camera.updateProjectionMatrix();
        this.floor.position.set(cx, 0.5, cz);
        this.floor.scale.setScalar(Math.max(width * 0.55, hipHeight));
    }

    resize() {
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        if (!w || !h) return;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.frame();
        this.camera.updateProjectionMatrix();
    }

    /** Screen positions (CSS pixels) of the keypoints, from the posed bones. */
    projectKeypoints() {
        const w = this.overlay.clientWidth;
        const h = this.overlay.clientHeight;
        if (!this._bones) return this._points;
        this.model.updateMatrixWorld(true);
        this._bones.forEach((bone, k) => {
            if (!bone) { this._points[k] = null; return; }
            bone.getWorldPosition(this._v).project(this.camera);
            this._points[k] = [(this._v.x + 1) / 2 * w, (1 - this._v.y) / 2 * h];
        });
        return this._points;
    }

    /**
     * Render a frame. `segmentScores` (optional) colours the joint overlay by
     * how well the dancer matches each body part.
     */
    render({ segmentScores = null } = {}) {
        if (!this.renderer.domElement.width) this.resize();
        this.renderer.render(this.scene, this.camera);
        const { ctx } = prepareCanvas(this.overlay);
        if (!this.model || !this.showJoints) return;
        const points = this.projectKeypoints();
        const lineWidth = Math.max(2, this.overlay.clientHeight / 160);
        drawSkeleton2D(ctx, points, { color: COLORS.reference, glow: COLORS.referenceGlow, lineWidth, segmentScores });
    }

    dispose() {
        this._resize.disconnect();
        this.renderer.dispose();
        this.container.innerHTML = '';
    }
}
