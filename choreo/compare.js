// AutoChoreo — Pose comparison (reference dance ↔ a person dancing it)
//
// Compares two bodies that differ in everything except the dance: different
// proportions, standing in different places, filmed from different angles, one
// of them maybe a 3D character and the other a webcam image. Both are reduced
// to the same small set of body keypoints, and from those to *directions*:
//
//   keypoints ──► body frame (from the hips + torso) ──► unit bone directions
//
//   - Bone directions are unit vectors, so limb lengths (body proportions) and
//     overall size (distance from the camera) drop out.
//   - They are differences of keypoints, so where the dancer stands drops out.
//   - Limbs are expressed in the dancer's own body frame, so the camera's
//     viewing angle (yaw, pitch and roll) drops out too.
//   - Two "global" features are kept on purpose, because they are part of the
//     dance: the torso's lean relative to gravity and the facing direction.
//
// The reference keypoints come from a Choreography by forward kinematics on the
// canonical skeleton (./skeleton.js), or from the pose landmarks of the video it
// was learned from. A person's keypoints come from MediaPipe Pose landmarks,
// live from a camera or from an uploaded recording. Scoring over time (timing,
// lag search, attempts) lives in ./scoring.js.

import * as THREE from 'three';
import { JOINT_NAMES, JOINT_PARENT_INDEX, JOINT_BY_NAME, LM } from './skeleton.js';
import { JOINT_COUNT, createPose, samplePose, standingPose } from './pose.js';

// ── Keypoints ───────────────────────────────────────────────────────

/** The body points both sides are reduced to, with their MediaPipe landmark index. */
export const KEYPOINTS = [
    ['nose', LM.NOSE],
    ['leftShoulder', LM.LEFT_SHOULDER], ['rightShoulder', LM.RIGHT_SHOULDER],
    ['leftElbow', LM.LEFT_ELBOW], ['rightElbow', LM.RIGHT_ELBOW],
    ['leftWrist', LM.LEFT_WRIST], ['rightWrist', LM.RIGHT_WRIST],
    ['leftHip', LM.LEFT_HIP], ['rightHip', LM.RIGHT_HIP],
    ['leftKnee', LM.LEFT_KNEE], ['rightKnee', LM.RIGHT_KNEE],
    ['leftAnkle', LM.LEFT_ANKLE], ['rightAnkle', LM.RIGHT_ANKLE],
    ['leftToe', LM.LEFT_FOOT_INDEX], ['rightToe', LM.RIGHT_FOOT_INDEX],
];
export const KP_COUNT = KEYPOINTS.length;
export const KP = Object.fromEntries(KEYPOINTS.map(([name], i) => [name, i]));

/** Keypoint index of the same point on the other side of the body. */
export const KP_MIRROR = KEYPOINTS.map(([name]) => {
    const other = name.startsWith('left') ? `right${name.slice(4)}` : name.startsWith('right') ? `left${name.slice(5)}` : name;
    return KP[other];
});

/** Keypoint pairs drawn as the stick figure. */
export const KP_BONES = [
    [KP.leftShoulder, KP.rightShoulder], [KP.leftHip, KP.rightHip],
    [KP.leftShoulder, KP.leftHip], [KP.rightShoulder, KP.rightHip],
    [KP.leftShoulder, KP.leftElbow], [KP.leftElbow, KP.leftWrist],
    [KP.rightShoulder, KP.rightElbow], [KP.rightElbow, KP.rightWrist],
    [KP.leftHip, KP.leftKnee], [KP.leftKnee, KP.leftAnkle], [KP.leftAnkle, KP.leftToe],
    [KP.rightHip, KP.rightKnee], [KP.rightKnee, KP.rightAnkle], [KP.rightAnkle, KP.rightToe],
];

// ── Features: what is compared ──────────────────────────────────────

/**
 * Every feature is a unit 3-vector, so every comparison is an angle.
 *   frame 'yaw'     — expressed in a frame that only removes which way the dancer faces
 *                     (keeps the lean relative to gravity)
 *   frame 'heading' — the facing direction itself, relative to the camera / audience
 *   frame 'body'    — expressed in the dancer's own body frame
 * weight: how much the feature counts toward the pose score.
 */
export const SEGMENTS = [
    { name: 'torso', label: 'torso', frame: 'yaw', weight: 0.8, kps: [KP.leftShoulder, KP.rightShoulder, KP.leftHip, KP.rightHip] },
    { name: 'facing', label: 'facing direction', frame: 'heading', weight: 0.5, kps: [KP.leftShoulder, KP.rightShoulder, KP.leftHip, KP.rightHip] },
    { name: 'shoulders', label: 'shoulders', frame: 'body', from: KP.rightShoulder, to: KP.leftShoulder, weight: 0.5 },
    { name: 'leftUpperArm', label: 'left upper arm', frame: 'body', from: KP.leftShoulder, to: KP.leftElbow, side: 'left', limb: 'arm', part: 'upper', weight: 1 },
    { name: 'leftForearm', label: 'left forearm', frame: 'body', from: KP.leftElbow, to: KP.leftWrist, side: 'left', limb: 'arm', part: 'lower', weight: 0.8 },
    { name: 'rightUpperArm', label: 'right upper arm', frame: 'body', from: KP.rightShoulder, to: KP.rightElbow, side: 'right', limb: 'arm', part: 'upper', weight: 1 },
    { name: 'rightForearm', label: 'right forearm', frame: 'body', from: KP.rightElbow, to: KP.rightWrist, side: 'right', limb: 'arm', part: 'lower', weight: 0.8 },
    { name: 'leftThigh', label: 'left thigh', frame: 'body', from: KP.leftHip, to: KP.leftKnee, side: 'left', limb: 'leg', part: 'upper', weight: 1 },
    { name: 'leftShin', label: 'left shin', frame: 'body', from: KP.leftKnee, to: KP.leftAnkle, side: 'left', limb: 'leg', part: 'lower', weight: 0.8 },
    { name: 'rightThigh', label: 'right thigh', frame: 'body', from: KP.rightHip, to: KP.rightKnee, side: 'right', limb: 'leg', part: 'upper', weight: 1 },
    { name: 'rightShin', label: 'right shin', frame: 'body', from: KP.rightKnee, to: KP.rightAnkle, side: 'right', limb: 'leg', part: 'lower', weight: 0.8 },
    { name: 'leftFoot', label: 'left foot', frame: 'body', from: KP.leftAnkle, to: KP.leftToe, side: 'left', limb: 'foot', weight: 0.3 },
    { name: 'rightFoot', label: 'right foot', frame: 'body', from: KP.rightAnkle, to: KP.rightToe, side: 'right', limb: 'foot', weight: 0.3 },
];
export const SEG_COUNT = SEGMENTS.length;
export const FEATURE_SIZE = SEG_COUNT * 3;
export const SEG = Object.fromEntries(SEGMENTS.map((s, i) => [s.name, i]));
export const SEGMENT_WEIGHTS = Float32Array.from(SEGMENTS.map((s) => s.weight));

/** Keypoints each segment is measured from (for visibility and overlay colouring). */
export const SEGMENT_KEYPOINTS = SEGMENTS.map((s) => s.kps || [s.from, s.to]);

/**
 * How an angle between two directions turns into a 0–1 match. Small errors are
 * pose-estimation noise and count as a full match; beyond `zeroDeg` it is a
 * different movement. Calibrated on MediaPipe tracking of rendered dances:
 * a perfect performance is still tracked ~20° off on average (arms ~30°), so
 * a tighter full-credit zone would mostly be scoring the tracker.
 */
export const ANGLE_SCORE = { fullDeg: 18, zeroDeg: 75 };

export function angleScore(angle) {
    const full = ANGLE_SCORE.fullDeg * (Math.PI / 180);
    const zero = ANGLE_SCORE.zeroDeg * (Math.PI / 180);
    if (angle <= full) return 1;
    if (angle >= zero) return 0;
    return (zero - angle) / (zero - full);
}

/** Angle (radians) between two unit vectors stored at offsets in two arrays. */
export function unitAngle(a, ai, b, bi) {
    const d = a[ai] * b[bi] + a[ai + 1] * b[bi + 1] + a[ai + 2] * b[bi + 2];
    return Math.acos(Math.max(-1, Math.min(1, d)));
}

// ── Keypoints from a person (MediaPipe Pose landmarks) ──────────────

/**
 * MediaPipe world landmarks (33 × x, y, z, visibility; metres, hip-centred,
 * x → image right, y → down, z → away from the camera) → keypoints in canonical
 * axes (Y up, +Z toward the camera, +X the person's left), as in ./solver.js.
 *
 * @param {Float32Array} world   33 × 4 values.
 * @param {Float32Array} [out]   KP_COUNT × 3.
 * @param {Float32Array} [vis]   KP_COUNT visibilities, filled if given.
 */
export function keypointsFromLandmarks(world, out = new Float32Array(KP_COUNT * 3), vis = null) {
    for (let k = 0; k < KP_COUNT; k++) {
        const i = KEYPOINTS[k][1] * 4;
        out[k * 3] = world[i];
        out[k * 3 + 1] = -world[i + 1];
        out[k * 3 + 2] = -world[i + 2];
        if (vis) vis[k] = world[i + 3] ?? 1;
    }
    return out;
}

// ── Keypoints from a choreography (forward kinematics) ──────────────

/**
 * Average adult proportions in units of standing hip height (the unit
 * choreographies use). Only directions are compared, so these matter just for
 * the few features that combine several joints (e.g. hip → shoulder midpoint)
 * and for drawing.
 */
export const BODY_PROPORTIONS = {
    hipHalfWidth: 0.1, thigh: 0.46, shin: 0.46, foot: 0.17,
    spine: 0.12, chest: 0.2, shoulderRise: 0.22, shoulderHalfWidth: 0.19,
    upperArm: 0.31, forearm: 0.27, neck: 0.1, noseUp: 0.07, noseForward: 0.1,
};

const J = Object.fromEntries(JOINT_NAMES.map((n, i) => [n, i]));
const FOOT_DIR = new THREE.Vector3().fromArray(JOINT_BY_NAME.leftFoot.restDir).normalize();
const _world = Array.from({ length: JOINT_COUNT }, () => new THREE.Quaternion());
const _local = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _p = Array.from({ length: 8 }, () => new THREE.Vector3());

/**
 * Keypoints of a pose (see ./pose.js) on a body with average proportions.
 * Positions are in hip heights; the hip-joint midpoint sits at the pose's root
 * position (so travel and jumps are kept, for drawing).
 */
export function keypointsFromPose(pose, out = new Float32Array(KP_COUNT * 3)) {
    for (let j = 0; j < JOINT_COUNT; j++) {
        _local.fromArray(pose.rot, j * 4);
        const p = JOINT_PARENT_INDEX[j];
        if (p < 0) _world[j].copy(_local);
        else _world[j].copy(_world[p]).multiply(_local);
    }
    const B = BODY_PROPORTIONS;
    const set = (k, v) => v.toArray(out, k * 3);
    const root = _p[0].fromArray(pose.root);
    const offset = (joint, x, y, z) => _v.set(x, y, z).applyQuaternion(_world[J[joint]]);

    // Legs
    for (const [side, sign] of [['left', 1], ['right', -1]]) {
        const hip = _p[1].copy(root).add(offset('hips', sign * B.hipHalfWidth, 0, 0));
        const knee = _p[2].copy(hip).add(offset(`${side}UpperLeg`, 0, -B.thigh, 0));
        const ankle = _p[3].copy(knee).add(offset(`${side}LowerLeg`, 0, -B.shin, 0));
        const toe = _p[4].copy(ankle).add(_v.copy(FOOT_DIR).multiplyScalar(B.foot).applyQuaternion(_world[J[`${side}Foot`]]));
        set(KP[`${side}Hip`], hip);
        set(KP[`${side}Knee`], knee);
        set(KP[`${side}Ankle`], ankle);
        set(KP[`${side}Toe`], toe);
    }

    // Spine and arms
    const spine = _p[1].copy(root).add(offset('hips', 0, B.spine, 0));
    const chest = _p[2].copy(spine).add(offset('spine', 0, B.chest, 0));
    for (const [side, sign] of [['left', 1], ['right', -1]]) {
        const shoulder = _p[3].copy(chest).add(offset('chest', sign * B.shoulderHalfWidth, B.shoulderRise, 0));
        const elbow = _p[4].copy(shoulder).add(offset(`${side}UpperArm`, sign * B.upperArm, 0, 0));
        const wrist = _p[5].copy(elbow).add(offset(`${side}LowerArm`, sign * B.forearm, 0, 0));
        set(KP[`${side}Shoulder`], shoulder);
        set(KP[`${side}Elbow`], elbow);
        set(KP[`${side}Wrist`], wrist);
    }
    const neck = _p[3].copy(chest).add(offset('chest', 0, B.shoulderRise, 0));
    const head = _p[4].copy(neck).add(offset('neck', 0, B.neck, 0));
    set(KP.nose, _p[5].copy(head).add(offset('head', 0, B.noseUp, B.noseForward)));
    return out;
}

/** Mirror a body across its own left/right: x → −x and left ↔ right labels. `out` may not be `kp`. */
export function mirrorKeypoints(kp, out = new Float32Array(KP_COUNT * 3)) {
    for (let k = 0; k < KP_COUNT; k++) {
        const m = KP_MIRROR[k] * 3;
        out[k * 3] = -kp[m];
        out[k * 3 + 1] = kp[m + 1];
        out[k * 3 + 2] = kp[m + 2];
    }
    return out;
}

/** Mirror per-keypoint values (e.g. visibilities) by swapping left and right. */
export function mirrorKeypointValues(values, out = new Float32Array(KP_COUNT)) {
    for (let k = 0; k < KP_COUNT; k++) out[k] = values[KP_MIRROR[k]];
    return out;
}

// ── Front/back confusion ────────────────────────────────────────────
//
// From a single camera, a body seen from the front and the same body seen from
// behind project to nearly the same image, and the pose model regularly picks
// the wrong one — for single frames and for long runs (measured on rendered
// dances: a third to a half of the frames). The wrong reading swaps left and
// right and mirrors depth. The image alone cannot settle it, so we settle it
// with the one thing that is known: which way the dancer is supposed to face
// at that moment (the reference's facing, or the camera when nothing else is
// known). Only the facing decides — never the limbs — so a dancer who really
// uses the wrong arm still shows up as using the wrong arm.

/** Re-read keypoints as seen from the other side: left ↔ right labels swapped, depth mirrored. In place. */
export function flipFrontBack(kp, values = null) {
    for (let k = 0; k < KP_COUNT; k++) {
        const m = KP_MIRROR[k];
        if (m <= k) continue;
        for (let c = 0; c < 3; c++) {
            const t = kp[k * 3 + c];
            kp[k * 3 + c] = kp[m * 3 + c];
            kp[m * 3 + c] = t;
        }
        if (values) { const t = values[k]; values[k] = values[m]; values[m] = t; }
    }
    for (let k = 0; k < KP_COUNT; k++) kp[k * 3 + 2] = -kp[k * 3 + 2];
    return kp;
}

/** Toward-the-camera component of the facing direction of keypoints (+ faces the camera). */
function facingTowardCamera(kp) {
    // Facing = across-the-body × up; its z component is the across line's x
    let z = 0;
    for (const [l, r] of [[KP.leftHip, KP.rightHip], [KP.leftShoulder, KP.rightShoulder]]) {
        const dx = kp[l * 3] - kp[r * 3];
        const len = Math.hypot(dx, kp[l * 3 + 1] - kp[r * 3 + 1], kp[l * 3 + 2] - kp[r * 3 + 2]);
        if (len > 1e-9) z += dx / len;
    }
    return z / 2;
}

/**
 * Settle the front/back reading of a person's keypoints (in place).
 * @param {number} expectedTowardCamera  The reference's facing toward the camera
 *        (its facing feature's z, −1…1), or 1 when the dancer should face the camera.
 * @returns {boolean} whether the keypoints were re-read the other way round.
 *        The two readings face opposite ways along the camera axis, so the one
 *        on the expected side is kept; when the expectation is side-on (|z| small)
 *        the reading is left as it is.
 */
export function resolveFrontBack(kp, values, expectedTowardCamera = 1) {
    if (Math.abs(expectedTowardCamera) < 0.2) return false;
    const z = facingTowardCamera(kp);
    if (z * expectedTowardCamera >= 0) return false;
    flipFrontBack(kp, values);
    return true;
}

/** The reference's facing toward the camera at a time (for resolveFrontBack). */
export function trackFacingTowardCamera(track, time) {
    const f = Math.max(0, Math.min(track.frameCount - 1, Math.round(time * track.rate)));
    return track.features[f * FEATURE_SIZE + SEG.facing * 3 + 2];
}

// ── Keypoints → features ────────────────────────────────────────────

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _hipLine = new THREE.Vector3();
const _shoulderLine = new THREE.Vector3();
const _torso = new THREE.Vector3();
const _bx = new THREE.Vector3();
const _by = new THREE.Vector3();
const _bz = new THREE.Vector3();
const _yx = new THREE.Vector3();
const _yz = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

const kpVec = (kp, k, out) => out.set(kp[k * 3], kp[k * 3 + 1], kp[k * 3 + 2]);
const mid = (kp, i, j, out) => out.set(
    (kp[i * 3] + kp[j * 3]) / 2, (kp[i * 3 + 1] + kp[j * 3 + 1]) / 2, (kp[i * 3 + 2] + kp[j * 3 + 2]) / 2);

function writeUnit(out, o, v) {
    const len = v.length();
    if (len < 1e-9) { out[o] = 0; out[o + 1] = 1; out[o + 2] = 0; return; }
    out[o] = v.x / len; out[o + 1] = v.y / len; out[o + 2] = v.z / len;
}

/**
 * The body frame: X across the body (towards the dancer's left, from the hip
 * and shoulder lines together — shoulders are tracked more reliably than hips),
 * Y up the torso, Z the way the chest faces. Returns false if undefined.
 */
function bodyFrame(kp) {
    kpVec(kp, KP.leftHip, _hipLine).sub(kpVec(kp, KP.rightHip, _a));
    kpVec(kp, KP.leftShoulder, _shoulderLine).sub(kpVec(kp, KP.rightShoulder, _a));
    mid(kp, KP.leftShoulder, KP.rightShoulder, _torso).sub(mid(kp, KP.leftHip, KP.rightHip, _a));
    const h = _hipLine.length();
    const s = _shoulderLine.length();
    if (h < 1e-9 && s < 1e-9) return false;
    _bx.set(0, 0, 0);
    if (h > 1e-9) _bx.addScaledVector(_hipLine, 1 / h);
    if (s > 1e-9) _bx.addScaledVector(_shoulderLine, 1 / s);
    if (_bx.lengthSq() < 1e-12) _bx.copy(_shoulderLine);
    _bx.normalize();
    _by.copy(_torso).addScaledVector(_bx, -_torso.dot(_bx));
    if (_by.lengthSq() < 1e-12) _by.copy(UP).addScaledVector(_bx, -_bx.y);
    if (_by.lengthSq() < 1e-12) return false;
    _by.normalize();
    _bz.crossVectors(_bx, _by);

    // Yaw-only frame: across-the-body direction flattened onto the floor
    _yx.set(_bx.x, 0, _bx.z);
    if (_yx.lengthSq() < 1e-8) _yx.set(1, 0, 0); // lying across the camera axis: no defined heading
    _yx.normalize();
    _yz.crossVectors(_yx, UP);
    return true;
}

/**
 * Feature vector (FEATURE_SIZE floats: one unit vector per segment) of a set of
 * keypoints. See SEGMENTS for what each one measures.
 */
export function featuresFromKeypoints(kp, out = new Float32Array(FEATURE_SIZE)) {
    if (!bodyFrame(kp)) {
        for (let s = 0; s < SEG_COUNT; s++) { out[s * 3] = 0; out[s * 3 + 1] = 1; out[s * 3 + 2] = 0; }
        return out;
    }
    for (let s = 0; s < SEG_COUNT; s++) {
        const seg = SEGMENTS[s];
        const o = s * 3;
        if (seg.frame === 'yaw') {
            _a.set(_torso.dot(_yx), _torso.y, _torso.dot(_yz));
            writeUnit(out, o, _a);
        } else if (seg.frame === 'heading') {
            out[o] = _yz.x; out[o + 1] = 0; out[o + 2] = _yz.z;
        } else {
            kpVec(kp, seg.to, _b).sub(kpVec(kp, seg.from, _a));
            _a.set(_b.dot(_bx), _b.dot(_by), _b.dot(_bz));
            writeUnit(out, o, _a);
        }
    }
    return out;
}

/** Per-segment visibility (0–1) from per-keypoint visibilities: a segment is as visible as its least visible point. */
export function segmentVisibility(kpVis, out = new Float32Array(SEG_COUNT)) {
    for (let s = 0; s < SEG_COUNT; s++) {
        let v = 1;
        for (const k of SEGMENT_KEYPOINTS[s]) v = Math.min(v, kpVis[k]);
        out[s] = v;
    }
    return out;
}

/**
 * Compare two feature vectors.
 * @returns {number} weighted 0–1 match; per-segment matches go to `perSegment` if given.
 */
export function compareFeatures(a, b, weights = SEGMENT_WEIGHTS, perSegment = null) {
    let sum = 0;
    let wSum = 0;
    for (let s = 0; s < SEG_COUNT; s++) {
        const score = angleScore(unitAngle(a, s * 3, b, s * 3));
        if (perSegment) perSegment[s] = score;
        sum += weights[s] * score;
        wSum += weights[s];
    }
    return wSum > 0 ? sum / wSum : 0;
}

/** Angle (radians) at a hinge — elbow or knee — from the two segment directions (0 = straight). */
export function bendAngle(features, upperSeg, lowerSeg) {
    return unitAngle(features, upperSeg * 3, features, lowerSeg * 3);
}

// ── Which body parts matter at each moment ──────────────────────────

/**
 * Features of a relaxed standing pose. A body part held near this pose is not
 * "doing" anything, so matching it is easy — standing still would match it.
 */
export const NEUTRAL_FEATURES = featuresFromKeypoints(keypointsFromPose(standingPose()));

/** Body parts count fully once this far (degrees) from neutral, and at least `floor` of their weight. */
export const EMPHASIS = { fullDeg: 45, floor: 0.1, window: 0.3 };

/**
 * Per-sample, per-segment weights for a track: each segment's base weight,
 * scaled by how far the reference takes it from the neutral pose around that
 * moment. A teacher watches what is moving, not the parts standing still — and
 * without this, someone standing still would earn credit for every part the
 * dance does not use.
 */
function computeTrackWeights(track) {
    const N = track.frameCount;
    const F = track.features;
    const dev = new Float32Array(N * SEG_COUNT);
    for (let f = 0; f < N; f++) {
        for (let s = 0; s < SEG_COUNT; s++) dev[f * SEG_COUNT + s] = unitAngle(F, f * FEATURE_SIZE + s * 3, NEUTRAL_FEATURES, s * 3);
    }
    const full = (EMPHASIS.fullDeg * Math.PI) / 180;
    const radius = Math.max(0, Math.round(EMPHASIS.window * track.rate));
    const weights = new Float32Array(N * SEG_COUNT);
    for (let f = 0; f < N; f++) {
        for (let s = 0; s < SEG_COUNT; s++) {
            let d = 0;
            for (let g = Math.max(0, f - radius); g <= Math.min(N - 1, f + radius); g++) d = Math.max(d, dev[g * SEG_COUNT + s]);
            const emphasis = EMPHASIS.floor + (1 - EMPHASIS.floor) * Math.min(1, d / full);
            weights[f * SEG_COUNT + s] = SEGMENT_WEIGHTS[s] * emphasis;
        }
    }
    track.weights = weights;
    return track;
}

/** Segment weights of a track at a time (nearest sample). */
export function trackWeightsAt(track, time) {
    const f = Math.max(0, Math.min(track.frameCount - 1, Math.round(time * track.rate)));
    return track.weights.subarray(f * SEG_COUNT, (f + 1) * SEG_COUNT);
}

// ── Tracks: features sampled over time ──────────────────────────────

/**
 * A motion as features (and keypoints, for drawing) sampled at a fixed rate.
 *   { rate, frameCount, duration, keypoints: Float32Array, features: Float32Array,
 *     weights: Float32Array (per sample × segment, see computeTrackWeights), mirror }
 */
function createTrack(rate, frameCount, duration, mirror) {
    return {
        rate,
        frameCount,
        duration,
        mirror,
        keypoints: new Float32Array(frameCount * KP_COUNT * 3),
        features: new Float32Array(frameCount * FEATURE_SIZE),
    };
}

/** Reference track of a choreography, by forward kinematics. */
export function referenceTrackFromChoreography(choreo, { rate = 30, mirror = false } = {}) {
    const N = Math.max(2, Math.floor(choreo.duration * rate) + 1);
    const track = createTrack(rate, N, choreo.duration, mirror);
    const pose = createPose();
    const kp = new Float32Array(KP_COUNT * 3);
    const mkp = new Float32Array(KP_COUNT * 3);
    for (let f = 0; f < N; f++) {
        samplePose(choreo, Math.min(f / rate, choreo.duration), pose);
        keypointsFromPose(pose, kp);
        const use = mirror ? mirrorKeypoints(kp, mkp) : kp;
        track.keypoints.set(use, f * KP_COUNT * 3);
        featuresFromKeypoints(use, track.features.subarray(f * FEATURE_SIZE, (f + 1) * FEATURE_SIZE));
    }
    return computeTrackWeights(track);
}

/**
 * Dense per-frame keypoints from a pose capture (see ./poseExtractor.js), with
 * frames where nobody was detected filled in from their neighbours, and each
 * frame's front/back reading settled by `expectedFacing(time)` (default: facing the camera).
 * Returns { keypoints: Float32Array(N × KP × 3), visibility: Float32Array(N × KP), valid: Uint8Array(N) } or null.
 */
export function keypointsFromCapture(capture, { expectedFacing = null } = {}) {
    const N = capture.frameCount;
    const keypoints = new Float32Array(N * KP_COUNT * 3);
    const visibility = new Float32Array(N * KP_COUNT);
    const valid = new Uint8Array(N);
    const kp = new Float32Array(KP_COUNT * 3);
    const vis = new Float32Array(KP_COUNT);
    const usable = [];
    for (let f = 0; f < N; f++) {
        const w = capture.world[f];
        if (!w) continue;
        keypointsFromLandmarks(w, kp, vis);
        resolveFrontBack(kp, vis, expectedFacing ? expectedFacing((f + 0.5) / capture.fps) : 1);
        keypoints.set(kp, f * KP_COUNT * 3);
        visibility.set(vis, f * KP_COUNT);
        valid[f] = 1;
        usable.push(f);
    }
    if (!usable.length) return null;
    let u = 0;
    for (let f = 0; f < N; f++) {
        if (valid[f]) continue;
        while (u + 1 < usable.length && usable[u + 1] < f) u++;
        const prev = usable[u] < f ? usable[u] : -1;
        const next = usable.find((g) => g > f) ?? -1;
        const a = prev >= 0 ? prev : next;
        const b = next >= 0 ? next : prev;
        const t = a === b ? 0 : (f - a) / (b - a);
        const S = KP_COUNT * 3;
        for (let i = 0; i < S; i++) keypoints[f * S + i] = keypoints[a * S + i] * (1 - t) + keypoints[b * S + i] * t;
        // visibility stays 0: these frames were not seen
    }
    return { keypoints, visibility, valid };
}

/**
 * Reference track from the pose landmarks of the video a dance was learned
 * from. Comparing landmarks with landmarks lets the pose model's own biases
 * cancel out, so this is preferred over the solved choreography when available.
 *
 * Front/back readings are settled as facing the camera, the same rule the
 * dancer's own frames are settled against (by this reference's facing), so both
 * sides are always read the same way round.
 *
 * `root` (the choreography solved from the same video) puts the keypoints in
 * the same units as a choreography track — standing hip heights, with the
 * dancer's travel — so they draw like any other track.
 */
export function referenceTrackFromCapture(capture, { rate = 30, mirror = false, root = null } = {}) {
    const dense = keypointsFromCapture(capture);
    if (!dense) return null;
    const S = KP_COUNT * 3;
    const smoothed = smoothKeypoints(dense.keypoints, capture.frameCount, 0.04 * capture.fps);
    const duration = capture.frameCount / capture.fps;
    const N = Math.max(2, Math.floor(duration * rate) + 1);
    const track = createTrack(rate, N, duration, mirror);
    const hipHeight = (root && root.source && root.source.estimatedHipHeightMeters) || estimateHipHeight(smoothed, capture.frameCount);
    const kp = new Float32Array(S);
    const mkp = new Float32Array(S);
    for (let f = 0; f < N; f++) {
        const time = f / rate;
        // Capture frame g covers [g, g+1) / fps; its landmarks describe its middle
        const x = Math.max(0, Math.min(capture.frameCount - 1, time * capture.fps - 0.5));
        const g0 = Math.floor(x);
        const g1 = Math.min(g0 + 1, capture.frameCount - 1);
        const t = x - g0;
        let rx = 0;
        let ry = 1;
        let rz = 0;
        if (root) {
            const r = root.rootPositions;
            const y = Math.max(0, Math.min(root.frameCount - 1, time * root.fps));
            const r0 = Math.floor(y);
            const r1 = Math.min(r0 + 1, root.frameCount - 1);
            const u = y - r0;
            rx = r[r0 * 3] + (r[r1 * 3] - r[r0 * 3]) * u;
            ry = r[r0 * 3 + 1] + (r[r1 * 3 + 1] - r[r0 * 3 + 1]) * u;
            rz = r[r0 * 3 + 2] + (r[r1 * 3 + 2] - r[r0 * 3 + 2]) * u;
        }
        for (let k = 0; k < KP_COUNT; k++) {
            for (let c = 0; c < 3; c++) {
                const i = k * 3 + c;
                kp[i] = (smoothed[g0 * S + i] * (1 - t) + smoothed[g1 * S + i] * t) / hipHeight + (c === 0 ? rx : c === 1 ? ry : rz);
            }
        }
        const use = mirror ? mirrorKeypoints(kp, mkp) : kp;
        track.keypoints.set(use, f * S);
        featuresFromKeypoints(use, track.features.subarray(f * FEATURE_SIZE, (f + 1) * FEATURE_SIZE));
    }
    return computeTrackWeights(track);
}

/** Standing hip height (metres) from tracked keypoints: thigh + shin, plus the ankle-to-floor height. */
function estimateHipHeight(keypoints, frameCount) {
    const S = KP_COUNT * 3;
    const legs = [];
    const d = (f, a, b) => Math.hypot(
        keypoints[f * S + a * 3] - keypoints[f * S + b * 3],
        keypoints[f * S + a * 3 + 1] - keypoints[f * S + b * 3 + 1],
        keypoints[f * S + a * 3 + 2] - keypoints[f * S + b * 3 + 2]);
    for (let f = 0; f < frameCount; f++) {
        legs.push((d(f, KP.leftHip, KP.leftKnee) + d(f, KP.leftKnee, KP.leftAnkle) + d(f, KP.rightHip, KP.rightKnee) + d(f, KP.rightKnee, KP.rightAnkle)) / 2);
    }
    legs.sort((a, b) => a - b);
    return (legs[legs.length >> 1] || 0.85) * 1.087;
}

function smoothKeypoints(data, frameCount, sigmaFrames) {
    if (!(sigmaFrames > 0.3) || frameCount < 3) return data;
    const S = KP_COUNT * 3;
    const radius = Math.ceil(sigmaFrames * 3);
    const kernel = Array.from({ length: radius * 2 + 1 }, (_, i) => Math.exp(-0.5 * ((i - radius) / sigmaFrames) ** 2));
    const out = new Float32Array(data.length);
    for (let f = 0; f < frameCount; f++) {
        let wSum = 0;
        for (let k = -radius; k <= radius; k++) {
            const g = f + k;
            if (g < 0 || g >= frameCount) continue;
            const w = kernel[k + radius];
            wSum += w;
            for (let i = 0; i < S; i++) out[f * S + i] += w * data[g * S + i];
        }
        for (let i = 0; i < S; i++) out[f * S + i] /= wSum;
    }
    return out;
}

/**
 * Features of a track at any time, interpolated between samples and
 * renormalised. Times outside the track hold its first / last sample.
 */
export function sampleTrackFeatures(track, time, out = new Float32Array(FEATURE_SIZE)) {
    const x = Math.max(0, Math.min(track.frameCount - 1, time * track.rate));
    const f0 = Math.floor(x);
    const f1 = Math.min(f0 + 1, track.frameCount - 1);
    const t = x - f0;
    const F = track.features;
    const a = f0 * FEATURE_SIZE;
    const b = f1 * FEATURE_SIZE;
    for (let s = 0; s < SEG_COUNT; s++) {
        const o = s * 3;
        const x0 = F[a + o] + (F[b + o] - F[a + o]) * t;
        const y0 = F[a + o + 1] + (F[b + o + 1] - F[a + o + 1]) * t;
        const z0 = F[a + o + 2] + (F[b + o + 2] - F[a + o + 2]) * t;
        const len = Math.hypot(x0, y0, z0) || 1;
        out[o] = x0 / len; out[o + 1] = y0 / len; out[o + 2] = z0 / len;
    }
    return out;
}

/** Keypoints of a track at any time (linear interpolation), for drawing. */
export function sampleTrackKeypoints(track, time, out = new Float32Array(KP_COUNT * 3)) {
    const x = Math.max(0, Math.min(track.frameCount - 1, time * track.rate));
    const f0 = Math.floor(x);
    const f1 = Math.min(f0 + 1, track.frameCount - 1);
    const t = x - f0;
    const S = KP_COUNT * 3;
    const K = track.keypoints;
    for (let i = 0; i < S; i++) out[i] = K[f0 * S + i] + (K[f1 * S + i] - K[f0 * S + i]) * t;
    return out;
}

/** How much the reference moves at each sample: mean weighted segment turn per second. */
export function trackMotionEnergy(track) {
    const N = track.frameCount;
    const energy = new Float32Array(N);
    const F = track.features;
    let wSum = 0;
    for (let s = 0; s < SEG_COUNT; s++) wSum += SEGMENT_WEIGHTS[s];
    for (let f = 1; f < N; f++) {
        let e = 0;
        for (let s = 0; s < SEG_COUNT; s++) {
            e += SEGMENT_WEIGHTS[s] * unitAngle(F, (f - 1) * FEATURE_SIZE + s * 3, F, f * FEATURE_SIZE + s * 3);
        }
        energy[f] = (e / wSum) * track.rate;
    }
    energy[0] = energy[1] || 0;
    return energy;
}

// ── Aligning a recording with the reference by movement ─────────────

const _ref = new Float32Array(FEATURE_SIZE);

/**
 * How well a recording matches the reference when placed at `offset`
 * (reference time = recording time + offset).
 * @param {object} user  { times, features, weights } (see alignByMovement)
 * @param {number[]} [indices]  Samples to use (default: all).
 * @returns {{ score: number, overlap: number }}  overlap = samples that fell on the reference
 */
export function movementMatchAt(user, track, offset, indices = null) {
    let sum = 0;
    let wSum = 0;
    let overlap = 0;
    const n = indices ? indices.length : user.times.length;
    for (let j = 0; j < n; j++) {
        const i = indices ? indices[j] : j;
        const t = user.times[i] + offset;
        if (t < 0 || t > track.duration) continue;
        overlap++;
        sampleTrackFeatures(track, t, _ref);
        const tw = trackWeightsAt(track, t);
        for (let s = 0; s < SEG_COUNT; s++) {
            const w = tw[s] * user.weights[i * SEG_COUNT + s];
            sum += w * angleScore(unitAngle(user.features, i * FEATURE_SIZE + s * 3, _ref, s * 3));
            wSum += w;
        }
    }
    return { score: wSum > 0 ? sum / wSum : 0, overlap };
}

/**
 * Find where a recording of someone dancing sits on the reference's timeline,
 * by sliding it along and keeping the offset where the poses agree best.
 * Used when a recording's start can't be lined up by its soundtrack.
 *
 * @param {object} user  { times: Float32Array, features: Float32Array, weights: Float32Array (per sample × segment) }
 * @param {object} track Reference track.
 * @returns {{ offset: number, score: number, contrast: number }}  reference time = recording time + offset
 */
export function alignByMovement(user, track, { minOverlap = 3, coarseStep = 0.1 } = {}) {
    const n = user.times.length;
    if (!n) return null;
    const recStart = user.times[0];
    const recEnd = user.times[n - 1];
    // Subsample the recording to about 10 Hz for the coarse search
    const pick = [];
    let next = -Infinity;
    for (let i = 0; i < n; i++) if (user.times[i] >= next) { pick.push(i); next = user.times[i] + 0.1; }

    const scoreAt = (offset, indices) => movementMatchAt(user, track, offset, indices);

    const lo = -recEnd + minOverlap;
    const hi = track.duration - recStart - minOverlap;
    const step = coarseStep;
    // Dances repeat their phrases, so a shift that only overlaps the best-matching
    // part of a recording can outscore the true one. When the whole recording can
    // lie on the reference, only such shifts are considered; and between equally
    // good repeats, a recording is assumed to start near the start of the song.
    const span = recEnd - recStart;
    const canCoverAll = span <= track.duration + 1e-6;
    const objective = (score, o) => score - 0.002 * Math.abs(o);
    let best = { offset: 0, score: -1, value: -Infinity };
    const scores = [];
    for (let o = Math.min(lo, hi); o <= Math.max(lo, hi) + 1e-9; o += step) {
        const { score, overlap } = scoreAt(o, pick);
        const covered = overlap / pick.length;
        if (canCoverAll ? covered < 0.9 : overlap * 0.1 < Math.min(minOverlap, span * 0.8)) continue;
        scores.push(score);
        if (objective(score, o) > best.value) best = { offset: o, score, value: objective(score, o) };
    }
    if (best.score < 0) return null;
    // Refine around the best coarse offset using every sample
    const fine = 1 / track.rate;
    let refined = { offset: best.offset, score: -1 };
    for (let o = best.offset - step; o <= best.offset + step + 1e-9; o += fine) {
        const { score } = scoreAt(o, null);
        if (score > refined.score) refined = { offset: o, score };
    }
    const sorted = scores.sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1] ?? 0;
    return { offset: refined.offset, score: refined.score, contrast: refined.score - median };
}
