// AutoChoreo — Single poses on the canonical skeleton
//
// A pose is one moment of a choreography: every joint's parent-relative
// rotation, the root (hip midpoint) position in hip heights, and how planted
// each foot is. These helpers read poses out of a choreography at any time
// (not just on whole frames), blend between them, and compare them — the
// building blocks for stitching separate dances together (./sequence.js).

import * as THREE from 'three';
import { JOINTS, JOINT_NAMES } from './skeleton.js';

export const JOINT_COUNT = JOINTS.length;
const HIPS = JOINT_NAMES.indexOf('hips');
export const FOOT_KEYS = ['leftFoot', 'rightFoot'];

export function createPose() {
    return {
        rot: new Float32Array(JOINT_COUNT * 4),   // joint-major quaternions (x, y, z, w)
        root: new Float32Array(3),                 // hip-joint midpoint, in standing hip heights
        contacts: { leftFoot: 0, rightFoot: 0 },   // 0–1: how planted each foot is
    };
}

export function copyPose(src, out = createPose()) {
    out.rot.set(src.rot);
    out.root.set(src.root);
    for (const k of FOOT_KEYS) out.contacts[k] = src.contacts[k];
    return out;
}

/**
 * The pose of a choreography at any time in seconds. Rotations are slerped and
 * the root interpolated between the neighbouring frames, so slowed-down
 * playback stays smooth instead of stepping from frame to frame.
 * Times outside the dance hold its first / last frame.
 */
export function samplePose(choreo, time, out = createPose()) {
    const last = choreo.frameCount - 1;
    const f = Math.max(0, Math.min(last, time * choreo.fps));
    const f0 = Math.floor(f);
    const f1 = Math.min(f0 + 1, last);
    const a = f - f0;
    for (let j = 0; j < JOINT_COUNT; j++) {
        const src = choreo.rotations[JOINT_NAMES[j]];
        THREE.Quaternion.slerpFlat(out.rot, j * 4, src, f0 * 4, src, f1 * 4, a);
    }
    const r = choreo.rootPositions;
    for (let c = 0; c < 3; c++) out.root[c] = r[f0 * 3 + c] + (r[f1 * 3 + c] - r[f0 * 3 + c]) * a;
    const nearest = a < 0.5 ? f0 : f1;
    for (const k of FOOT_KEYS) {
        const track = choreo.contacts && choreo.contacts[k];
        out.contacts[k] = track ? track[nearest] : 0;
    }
    return out;
}

/** Blend two poses: w = 0 gives `a`, w = 1 gives `b`. `out` may be `a` or `b`. */
export function blendPoses(a, b, w, out = createPose()) {
    for (let j = 0; j < JOINT_COUNT; j++) {
        THREE.Quaternion.slerpFlat(out.rot, j * 4, a.rot, j * 4, b.rot, j * 4, w);
    }
    for (let c = 0; c < 3; c++) out.root[c] = a.root[c] + (b.root[c] - a.root[c]) * w;
    for (const k of FOOT_KEYS) out.contacts[k] = a.contacts[k] + (b.contacts[k] - a.contacts[k]) * w;
    return out;
}

// ── Heading (which way the dancer faces, about the vertical axis) ───

const _q = new THREE.Quaternion();
const _yawQ = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/** Facing angle in radians about +Y; 0 = facing +Z (the default "front"). */
export function headingOf(pose) {
    _q.fromArray(pose.rot, HIPS * 4);
    _fwd.set(0, 0, 1).applyQuaternion(_q);
    if (_fwd.x * _fwd.x + _fwd.z * _fwd.z < 1e-8) return 0; // lying flat: no defined heading
    return Math.atan2(_fwd.x, _fwd.z);
}

/**
 * Turn a pose by `yaw` radians about the vertical axis through the origin, then
 * move it by (dx, dz) along the floor. Used to make one dance start where (and,
 * optionally, facing the way) the previous one ended.
 */
export function transformPose(pose, yaw, dx, dz) {
    if (yaw) {
        const c = Math.cos(yaw);
        const s = Math.sin(yaw);
        const x = pose.root[0];
        const z = pose.root[2];
        pose.root[0] = x * c + z * s;
        pose.root[2] = -x * s + z * c;
        _yawQ.setFromAxisAngle(_up, yaw);
        _q.fromArray(pose.rot, HIPS * 4).premultiply(_yawQ).toArray(pose.rot, HIPS * 4);
    }
    pose.root[0] += dx;
    pose.root[2] += dz;
    return pose;
}

/** Remove the dancer's heading so the pose faces front (+Z), keeping its tilt. */
export function faceFront(pose) {
    return transformPose(pose, -headingOf(pose), 0, 0);
}

// ── Neutral poses ───────────────────────────────────────────────────

/**
 * A relaxed standing pose: legs straight, arms hanging at the sides with the
 * elbows slightly bent, facing front. A dance can pass through it to get from
 * any ending pose to any starting pose without the limbs crossing awkwardly.
 */
export function standingPose() {
    const pose = createPose();
    for (let j = 0; j < JOINT_COUNT; j++) pose.rot[j * 4 + 3] = 1; // identity = T-pose
    const set = (name, q) => q.toArray(pose.rot, JOINT_NAMES.indexOf(name) * 4);
    const down = new THREE.Vector3(0, -1, 0);
    // Which way an elbow folds in the T-pose (palms down): forward and slightly down
    const elbowFold = new THREE.Vector3(0, -0.29, 0.957).normalize();
    for (const [side, sign] of [['left', 1], ['right', -1]]) {
        const rest = new THREE.Vector3(sign, 0, 0);
        const shoulderAxis = new THREE.Vector3().crossVectors(rest, down).normalize();
        set(`${side}UpperArm`, new THREE.Quaternion().setFromAxisAngle(shoulderAxis, THREE.MathUtils.degToRad(78)));
        // The upper arm's own frame turned with it, so the fold axis is expressed in T-pose terms
        const elbowAxis = new THREE.Vector3().crossVectors(rest, elbowFold).normalize();
        set(`${side}LowerArm`, new THREE.Quaternion().setFromAxisAngle(elbowAxis, THREE.MathUtils.degToRad(12)));
    }
    pose.root.set([0, 1, 0]);
    pose.contacts.leftFoot = 1;
    pose.contacts.rightFoot = 1;
    return pose;
}

/**
 * Capture a choreography's pose at a time as a neutral pose: faced front and
 * placed at the origin, so it can be reused anywhere in a sequence.
 */
export function capturePose(choreo, time) {
    const pose = faceFront(samplePose(choreo, time));
    pose.root[0] = 0;
    pose.root[2] = 0;
    return pose;
}

// ── Comparing poses ─────────────────────────────────────────────────

// How much each joint matters when judging whether two poses look alike
const JOINT_WEIGHT = {
    hips: 1, spine: 0.6, chest: 0.6, neck: 0.2, head: 0.3,
    leftUpperArm: 1, leftLowerArm: 0.8, leftHand: 0.2,
    rightUpperArm: 1, rightLowerArm: 0.8, rightHand: 0.2,
    leftUpperLeg: 1.2, leftLowerLeg: 1, leftFoot: 0.3,
    rightUpperLeg: 1.2, rightLowerLeg: 1, rightFoot: 0.3,
};
const WEIGHTS = JOINT_NAMES.map((n) => JOINT_WEIGHT[n] ?? 0.5);

const _pa = createPose();
const _pb = createPose();

/**
 * How different two poses look, ignoring where the dancer stands and which way
 * they face (both are aligned when dances are stitched). 0 = identical.
 * Roughly: the weighted sum of each joint's rotation difference (in radians, for
 * small differences) plus the difference in hip height.
 */
export function poseDistance(a, b) {
    faceFront(copyPose(a, _pa));
    faceFront(copyPose(b, _pb));
    let d = 0;
    for (let j = 0; j < JOINT_COUNT; j++) {
        const o = j * 4;
        const dot = Math.abs(_pa.rot[o] * _pb.rot[o] + _pa.rot[o + 1] * _pb.rot[o + 1] +
            _pa.rot[o + 2] * _pb.rot[o + 2] + _pa.rot[o + 3] * _pb.rot[o + 3]);
        d += WEIGHTS[j] * 2 * Math.acos(Math.min(1, dot));
    }
    return d + 2 * Math.abs(_pa.root[1] - _pb.root[1]);
}
