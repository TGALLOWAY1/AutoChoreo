// AutoChoreo — Kinematic solver (pose landmarks → choreography)
//
// Turns per-frame body landmarks (points in space) into joint rotations on the
// canonical skeleton. Landmarks alone are just dots; rotations are what a
// character rig actually consumes, and what makes a dance editable.
//
// Phase 1 approach: a direct, per-frame geometric solve followed by temporal
// smoothing. Each bone is turned to point where the landmarks say it points,
// and the twist a single direction cannot reveal is recovered from neighbouring
// landmarks (the elbow/knee bend plane, the hip and shoulder lines, the face).
// The numerical optimiser on the roadmap (pose + smoothness + contact + rhythm
// terms) can later refine this same output — this is its initial guess.

import * as THREE from 'three';
import { Choreography } from './choreography.js';
import { JOINT_NAMES, JOINT_PARENT_INDEX, JOINT_BY_NAME, LM, LANDMARK_COUNT, LANDMARK_BONES } from './skeleton.js';

export const DEFAULT_SOLVER_OPTIONS = {
    /** Gaussian sigma (seconds) applied to landmark positions before solving. */
    positionSmoothing: 0.06,
    /** Gaussian sigma (seconds) applied to the solved joint rotations. */
    rotationSmoothing: 0.03,
    /** Gaussian sigma (seconds) applied to the root trajectory. */
    rootSmoothing: 0.08,
    /**
     * Estimate movement toward/away from the camera from the dancer's apparent
     * size. Assumes a fixed, non-zooming camera; turn off if the footage zooms.
     */
    estimateDepth: true,
    /** Assumed vertical field of view (degrees) of the camera, used by estimateDepth. */
    cameraFovY: 50,
    /** Share (0–1) of the wrist's roll carried by the forearm (pronation/supination). */
    forearmTwistShare: 0.5,
    /** How far (0–1) to trust the index/pinky knuckle landmarks for the roll of the hand. */
    handRollTrust: 0.7,
    /**
     * A limb's twist is read from its bend plane only once it is bent enough for
     * that plane to be reliable: fades in between these two values of sin(bend angle).
     */
    bendPlaneFade: [0.3, 0.7],
};

// Standing hip height as a multiple of thigh + shin length (adds the ankle-to-sole height).
const HIP_HEIGHT_PER_LEG_LENGTH = 1.087;

const X = new THREE.Vector3(1, 0, 0);
const NEG_X = new THREE.Vector3(-1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const NEG_Y = new THREE.Vector3(0, -1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const NEG_Z = new THREE.Vector3(0, 0, -1);
const FOOT_REST = new THREE.Vector3().fromArray(JOINT_BY_NAME.leftFoot.restDir).normalize();
// Which way a hinge folds in the T-pose. With palms down the elbow folds the
// forearm forward and slightly downward; the knee folds the shin backward.
const ELBOW_FOLD = new THREE.Vector3(0, -0.29, 0.957);
const KNEE_FOLD = NEG_Z;

// ── Small math helpers ──────────────────────────────────────────────

const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _e3 = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();

function smoothstep(lo, hi, x) {
    const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
    return t * t * (3 - 2 * t);
}

/**
 * Orientation of the frame whose first axis is `primary` and whose first two
 * axes span the plane of `primary` and `secondary`. Returns false when the two
 * are (nearly) parallel and no plane is defined.
 */
function basisQuat(primary, secondary, out) {
    const pLen = primary.length();
    const sLen = secondary.length();
    if (pLen < 1e-9 || sLen < 1e-9) return false;
    _e1.copy(primary).divideScalar(pLen);
    _e3.crossVectors(_e1, secondary);
    const cLen = _e3.length();
    if (cLen < 1e-4 * sLen) return false;
    _e3.divideScalar(cLen);
    _e2.crossVectors(_e3, _e1);
    _mat.makeBasis(_e1, _e2, _e3);
    out.setFromRotationMatrix(_mat);
    return true;
}

/** Rotation that carries the rest frame (a0, b0) onto the observed frame (a, b). */
function alignFrames(a0, b0, a, b, out) {
    if (!basisQuat(a, b, _qa)) return false;
    if (!basisQuat(a0, b0, _qb)) return false;
    out.copy(_qa).multiply(_qb.invert());
    return true;
}

/**
 * Start from the parent's rotation and add the smallest extra turn that makes
 * `restDir` point along `dir`. The bone inherits its parent's twist.
 */
function swingOver(parentQ, restDir, dir, out) {
    _va.copy(restDir).applyQuaternion(parentQ).normalize();
    _vb.copy(dir);
    if (_vb.lengthSq() < 1e-12) return out.copy(parentQ);
    _vb.normalize();
    _qa.setFromUnitVectors(_va, _vb);
    return out.copy(_qa).multiply(parentQ);
}

/** Keep q within maxAngle (radians) of parentQ — a crude joint limit against bad landmarks. */
function limitRelative(parentQ, q, maxAngle) {
    _qa.copy(parentQ).invert().multiply(q);
    const angle = 2 * Math.acos(Math.min(1, Math.abs(_qa.w)));
    if (angle <= maxAngle) return q;
    _qb.identity().slerp(_qa, maxAngle / angle);
    return q.copy(parentQ).multiply(_qb);
}

/**
 * Solve a two-bone limb (arm or leg).
 * The upper bone's direction is observed directly. Its twist comes from the
 * bend plane: an elbow or knee is a hinge, so the lower bone must lie in the
 * plane the hinge allows. When the limb is nearly straight that plane is
 * undefined, so we fade to inheriting the parent's twist instead.
 */
const _qSwing = new THREE.Quaternion();
const _qPlane = new THREE.Quaternion();
const _u = new THREE.Vector3();
const _l = new THREE.Vector3();
function solveLimb(parentQ, restDir, restBend, upperDir, lowerDir, fade, outUpper, outLower) {
    swingOver(parentQ, restDir, upperDir, _qSwing);
    _u.copy(upperDir).normalize();
    _l.copy(lowerDir).normalize();
    const bend = _va.crossVectors(_u, _l).length(); // sine of the bend angle
    const w = smoothstep(fade[0], fade[1], bend);
    outUpper.copy(_qSwing);
    if (w > 0 && alignFrames(restDir, restBend, upperDir, lowerDir, _qPlane)) {
        outUpper.slerp(_qPlane, w);
    }
    swingOver(outUpper, restDir, lowerDir, outLower);
}

/**
 * Move the part of the child's rotation that is a roll about `axis` (the bone's
 * rest direction) from the child joint into the parent bone. The child's world
 * rotation is unchanged; the parent now carries `share` of the twist.
 */
function shareTwist(parentQ, childQ, axis, share, maxAngle) {
    _qa.copy(parentQ).invert().multiply(childQ); // child relative to parent
    const d = _qa.x * axis.x + _qa.y * axis.y + _qa.z * axis.z;
    let angle = 2 * Math.atan2(d, _qa.w);
    if (angle > Math.PI) angle -= 2 * Math.PI;
    if (angle < -Math.PI) angle += 2 * Math.PI;
    angle = Math.max(-maxAngle, Math.min(maxAngle, angle)) * share;
    _qb.setFromAxisAngle(axis, angle);
    return parentQ.multiply(_qb);
}

/** Gaussian blur along time for `channels` interleaved values per frame, optionally weighted per sample. */
function smoothSeries(data, frameCount, channels, sigmaFrames, weights = null, weightChannels = 1) {
    if (!(sigmaFrames > 0.05) || frameCount < 3) return data;
    const radius = Math.max(1, Math.ceil(sigmaFrames * 3));
    const kernel = new Float32Array(radius * 2 + 1);
    for (let k = -radius; k <= radius; k++) kernel[k + radius] = Math.exp(-0.5 * (k / sigmaFrames) ** 2);
    const out = new Float32Array(data.length);
    const perWeight = channels / weightChannels; // channels sharing one weight (e.g. xyz share one visibility)
    for (let f = 0; f < frameCount; f++) {
        for (let c = 0; c < channels; c++) {
            let sum = 0;
            let wSum = 0;
            for (let k = -radius; k <= radius; k++) {
                const g = f + k;
                if (g < 0 || g >= frameCount) continue;
                let w = kernel[k + radius];
                if (weights) w *= weights[g * weightChannels + Math.floor(c / perWeight)];
                sum += w * data[g * channels + c];
                wSum += w;
            }
            out[f * channels + c] = wSum > 0 ? sum / wSum : data[f * channels + c];
        }
    }
    return out;
}

/** Make consecutive quaternions share a hemisphere, blur, renormalise. */
function smoothQuaternions(q, frameCount, sigmaFrames) {
    for (let f = 1; f < frameCount; f++) {
        const a = (f - 1) * 4;
        const b = f * 4;
        const dot = q[a] * q[b] + q[a + 1] * q[b + 1] + q[a + 2] * q[b + 2] + q[a + 3] * q[b + 3];
        if (dot < 0) { q[b] = -q[b]; q[b + 1] = -q[b + 1]; q[b + 2] = -q[b + 2]; q[b + 3] = -q[b + 3]; }
    }
    const out = smoothSeries(q, frameCount, 4, sigmaFrames);
    for (let f = 0; f < frameCount; f++) {
        const i = f * 4;
        const len = Math.hypot(out[i], out[i + 1], out[i + 2], out[i + 3]) || 1;
        out[i] /= len; out[i + 1] /= len; out[i + 2] /= len; out[i + 3] /= len;
    }
    return out;
}

function median(values) {
    const sorted = Array.from(values).filter(Number.isFinite).sort((a, b) => a - b);
    if (sorted.length === 0) return NaN;
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ── Landmark preparation ────────────────────────────────────────────

/**
 * Convert a capture into dense canonical arrays, filling frames where no pose
 * was detected by interpolating between the nearest frames that have one.
 *
 * MediaPipe world landmarks: metres, origin at the hips, x → image right,
 * y → down, z → away from the camera. Canonical: Y up, +Z toward the camera
 * (the way a camera-facing dancer faces), +X the dancer's left. That is a
 * 180° turn about X: (x, y, z) → (x, -y, -z).
 */
function prepareLandmarks(capture) {
    const N = capture.frameCount;
    const pos = new Float32Array(N * LANDMARK_COUNT * 3);
    const vis = new Float32Array(N * LANDMARK_COUNT);
    const img = new Float32Array(N * LANDMARK_COUNT * 2); // pixels
    const valid = [];
    for (let f = 0; f < N; f++) {
        const w = capture.world[f];
        if (!w) continue;
        valid.push(f);
        const im = capture.image ? capture.image[f] : null;
        for (let i = 0; i < LANDMARK_COUNT; i++) {
            const p = (f * LANDMARK_COUNT + i) * 3;
            pos[p] = w[i * 4];
            pos[p + 1] = -w[i * 4 + 1];
            pos[p + 2] = -w[i * 4 + 2];
            vis[f * LANDMARK_COUNT + i] = Math.max(0.05, w[i * 4 + 3]);
            if (im) {
                img[(f * LANDMARK_COUNT + i) * 2] = im[i * 4] * capture.width;
                img[(f * LANDMARK_COUNT + i) * 2 + 1] = im[i * 4 + 1] * capture.height;
            }
        }
    }
    if (valid.length === 0) throw new Error('No person was detected in the video');
    const detectedFrames = valid.length;

    // Reject frames where the pose model briefly swapped left and right (it happens
    // on ambiguous frames): the shoulder line points the opposite way to the frames
    // on both sides of it. A real turn can never reverse within a few frames.
    const shoulderLine = (f, out) => {
        const l = (f * LANDMARK_COUNT + LM.LEFT_SHOULDER) * 3;
        const r = (f * LANDMARK_COUNT + LM.RIGHT_SHOULDER) * 3;
        return out.set(pos[l] - pos[r], pos[l + 1] - pos[r + 1], pos[l + 2] - pos[r + 2]).normalize();
    };
    const isValid = new Uint8Array(N);
    for (const f of valid) isValid[f] = 1;
    const flipped = [];
    for (const f of valid) {
        shoulderLine(f, _va);
        let agree = 0;
        let oppose = 0;
        for (let k = -4; k <= 4; k++) {
            const g = f + k;
            if (k === 0 || g < 0 || g >= N || !isValid[g]) continue;
            const dot = _va.dot(shoulderLine(g, _vb));
            if (dot > 0.3) agree++;
            else if (dot < -0.3) oppose++;
        }
        if (oppose >= 2 && oppose > agree) flipped.push(f);
    }
    for (const f of flipped) isValid[f] = 0;
    const usable = valid.filter((f) => isValid[f]);

    // Fill gaps (undetected or rejected frames) from the nearest usable frames
    let vi = 0;
    for (let f = 0; f < N; f++) {
        if (isValid[f]) continue;
        while (vi + 1 < usable.length && usable[vi + 1] < f) vi++;
        const prev = usable[vi] < f ? usable[vi] : -1;
        const next = usable.find((v) => v > f) ?? -1;
        const a = prev >= 0 ? prev : next;
        const b = next >= 0 ? next : prev;
        const t = a === b ? 0 : (f - a) / (b - a);
        for (let i = 0; i < LANDMARK_COUNT; i++) {
            for (let c = 0; c < 3; c++) {
                const k = i * 3 + c;
                pos[f * LANDMARK_COUNT * 3 + k] =
                    pos[a * LANDMARK_COUNT * 3 + k] * (1 - t) + pos[b * LANDMARK_COUNT * 3 + k] * t;
            }
            for (let c = 0; c < 2; c++) {
                const k = i * 2 + c;
                img[f * LANDMARK_COUNT * 2 + k] =
                    img[a * LANDMARK_COUNT * 2 + k] * (1 - t) + img[b * LANDMARK_COUNT * 2 + k] * t;
            }
            vis[f * LANDMARK_COUNT + i] = 0.05; // interpolated: trust it very little when smoothing
        }
    }
    return { pos, vis, img, detectedFrames, rejectedFrames: flipped.length };
}

// ── Solver ──────────────────────────────────────────────────────────

/**
 * @param {object} capture  Output of extractPoseFromVideo():
 *   { fps, frameCount, width, height, world: (Float32Array|null)[], image: (Float32Array|null)[] }
 *   where each per-frame array holds 33 landmarks × (x, y, z, visibility).
 * @param {object} [options]  See DEFAULT_SOLVER_OPTIONS.
 * @returns {Choreography}
 */
export function solveChoreography(capture, options = {}) {
    const opt = { ...DEFAULT_SOLVER_OPTIONS, ...options };
    const N = capture.frameCount;
    const fps = capture.fps;
    const prepared = prepareLandmarks(capture);
    const vis = prepared.vis;
    const pos = smoothSeries(prepared.pos, N, LANDMARK_COUNT * 3, opt.positionSmoothing * fps, vis, LANDMARK_COUNT);

    // Landmark accessors for the current frame
    let frame = 0;
    const P = (i, out) => out.fromArray(pos, (frame * LANDMARK_COUNT + i) * 3);
    const V = (...ids) => {
        let m = 1;
        for (const i of ids) m = Math.min(m, vis[frame * LANDMARK_COUNT + i]);
        return m;
    };
    const dir = (from, to, out) => {
        P(to, out);
        return out.sub(P(from, _dirTmp));
    };
    const mid = (a, b, out) => P(a, out).add(P(b, _dirTmp)).multiplyScalar(0.5);
    const _dirTmp = new THREE.Vector3();

    // World-space rotation of every joint, measured from the T-pose
    const world = {};
    for (const name of JOINT_NAMES) world[name] = new Float32Array(N * 4);
    const q = Object.fromEntries(JOINT_NAMES.map((n) => [n, new THREE.Quaternion()]));

    const hipLine = new THREE.Vector3();
    const shoulderLine = new THREE.Vector3();
    const torsoUp = new THREE.Vector3();
    const midLine = new THREE.Vector3();
    const hipMid = new THREE.Vector3();
    const shoulderMid = new THREE.Vector3();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const qObs = new THREE.Quaternion();
    const qSwing = new THREE.Quaternion();

    const sides = [
        {
            arm: ['leftUpperArm', 'leftLowerArm', 'leftHand'], leg: ['leftUpperLeg', 'leftLowerLeg', 'leftFoot'],
            armRest: X, shoulder: LM.LEFT_SHOULDER, elbow: LM.LEFT_ELBOW, wrist: LM.LEFT_WRIST,
            index: LM.LEFT_INDEX, pinky: LM.LEFT_PINKY,
            hip: LM.LEFT_HIP, knee: LM.LEFT_KNEE, ankle: LM.LEFT_ANKLE, toe: LM.LEFT_FOOT_INDEX,
        },
        {
            arm: ['rightUpperArm', 'rightLowerArm', 'rightHand'], leg: ['rightUpperLeg', 'rightLowerLeg', 'rightFoot'],
            armRest: NEG_X, shoulder: LM.RIGHT_SHOULDER, elbow: LM.RIGHT_ELBOW, wrist: LM.RIGHT_WRIST,
            index: LM.RIGHT_INDEX, pinky: LM.RIGHT_PINKY,
            hip: LM.RIGHT_HIP, knee: LM.RIGHT_KNEE, ankle: LM.RIGHT_ANKLE, toe: LM.RIGHT_FOOT_INDEX,
        },
    ];

    for (frame = 0; frame < N; frame++) {
        // ── Torso: the hip line, shoulder line and spine direction give full frames ──
        dir(LM.RIGHT_HIP, LM.LEFT_HIP, hipLine);
        dir(LM.RIGHT_SHOULDER, LM.LEFT_SHOULDER, shoulderLine);
        mid(LM.LEFT_HIP, LM.RIGHT_HIP, hipMid);
        mid(LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, shoulderMid);
        torsoUp.subVectors(shoulderMid, hipMid);
        midLine.copy(hipLine).normalize().add(a.copy(shoulderLine).normalize());

        if (!alignFrames(X, Y, hipLine, torsoUp, q.hips)) q.hips.identity();
        if (!alignFrames(X, Y, shoulderLine, torsoUp, q.chest)) q.chest.copy(q.hips);
        // The spine follows the hip→shoulder direction so side bends land the shoulders correctly
        if (!alignFrames(Y, X, torsoUp, midLine, q.spine)) q.spine.copy(q.hips).slerp(q.chest, 0.5);

        // ── Head: ear line + face plane, trusted only as far as the face is visible ──
        dir(LM.RIGHT_EAR, LM.LEFT_EAR, a);
        mid(LM.LEFT_EYE, LM.RIGHT_EYE, b);
        b.sub(mid(LM.MOUTH_LEFT, LM.MOUTH_RIGHT, c));
        q.head.copy(q.chest);
        if (alignFrames(X, Y, a, b, qObs)) {
            const faceVis = V(LM.NOSE, LM.LEFT_EYE, LM.RIGHT_EYE, LM.MOUTH_LEFT, LM.MOUTH_RIGHT);
            q.head.slerp(qObs, smoothstep(0.2, 0.6, faceVis));
            limitRelative(q.chest, q.head, THREE.MathUtils.degToRad(70));
        }
        q.neck.copy(q.chest).slerp(q.head, 0.5);

        for (const s of sides) {
            // ── Arm ──
            dir(s.shoulder, s.elbow, a);
            dir(s.elbow, s.wrist, b);
            solveLimb(q.chest, s.armRest, ELBOW_FOLD, a, b, opt.bendPlaneFade, q[s.arm[0]], q[s.arm[1]]);

            // Hand: point along wrist → knuckles; roll from the index/pinky line when visible
            P(s.index, a).add(P(s.pinky, c)).multiplyScalar(0.5).sub(P(s.wrist, c));
            dir(s.pinky, s.index, b);
            const qHand = q[s.arm[2]];
            swingOver(q[s.arm[1]], s.armRest, a, qSwing);
            qHand.copy(qSwing);
            if (alignFrames(s.armRest, Z, a, b, qObs)) {
                qHand.slerp(qObs, opt.handRollTrust * smoothstep(0.3, 0.8, V(s.wrist, s.index, s.pinky)));
            }
            // A rolling wrist is really the forearm twisting, so let the forearm carry it
            shareTwist(q[s.arm[1]], qHand, s.armRest, opt.forearmTwistShare, THREE.MathUtils.degToRad(90));
            limitRelative(q[s.arm[1]], qHand, THREE.MathUtils.degToRad(80));

            // ── Leg ──
            dir(s.hip, s.knee, a);
            dir(s.knee, s.ankle, b);
            solveLimb(q.hips, NEG_Y, KNEE_FOLD, a, b, opt.bendPlaneFade, q[s.leg[0]], q[s.leg[1]]);

            // Foot: point along ankle → toe, and keep the sole square to the shin
            // (ankles pitch and turn far more than they roll).
            dir(s.ankle, s.toe, a);
            b.negate(); // ankle → knee
            if (!alignFrames(FOOT_REST, Y, a, b, q[s.leg[2]])) swingOver(q[s.leg[1]], FOOT_REST, a, q[s.leg[2]]);
            limitRelative(q[s.leg[1]], q[s.leg[2]], THREE.MathUtils.degToRad(75));
        }

        for (const name of JOINT_NAMES) q[name].toArray(world[name], frame * 4);
    }

    // ── Temporal smoothing, then convert world rotations to parent-relative ──
    for (const name of JOINT_NAMES) {
        world[name] = smoothQuaternions(world[name], N, opt.rotationSmoothing * fps);
    }
    const rotations = {};
    const qParent = new THREE.Quaternion();
    const qJoint = new THREE.Quaternion();
    JOINT_NAMES.forEach((name, j) => {
        const parentIndex = JOINT_PARENT_INDEX[j];
        if (parentIndex < 0) {
            rotations[name] = world[name];
            return;
        }
        const parentWorld = world[JOINT_NAMES[parentIndex]];
        const local = new Float32Array(N * 4);
        for (let f = 0; f < N; f++) {
            qParent.fromArray(parentWorld, f * 4).invert();
            qJoint.fromArray(world[name], f * 4);
            qParent.multiply(qJoint).toArray(local, f * 4);
        }
        rotations[name] = local;
    });

    const { rootPositions, hipHeight, contacts } = solveRoot(capture, prepared, pos, opt);

    return new Choreography({
        name: capture.name || 'Video dance',
        fps,
        frameCount: N,
        rotations,
        rootPositions,
        contacts,
        source: {
            type: 'video',
            name: capture.name || null,
            width: capture.width,
            height: capture.height,
            detectedFrames: prepared.detectedFrames,
            rejectedFrames: prepared.rejectedFrames,
            estimatedHipHeightMeters: Number(hipHeight.toFixed(3)),
            solver: 'direct-ik-v1',
        },
    });
}

/**
 * Root trajectory in units of standing hip height, plus foot-contact flags.
 *
 *   y  — the lowest foot point is assumed to rest on the floor, so the hips sit
 *        that far above it. (Jumps are therefore flattened in Phase 1.)
 *   x  — sideways travel, from where the hips sit in the image divided by the
 *        dancer's apparent size (pixels per metre).
 *   z  — travel toward the camera, from changes in apparent size (optional).
 */
function solveRoot(capture, prepared, pos, opt) {
    const N = capture.frameCount;
    const fps = capture.fps;
    const at = (f, i, c) => pos[(f * LANDMARK_COUNT + i) * 3 + c];
    const dist = (f, i, j) => Math.hypot(at(f, i, 0) - at(f, j, 0), at(f, i, 1) - at(f, j, 1), at(f, i, 2) - at(f, j, 2));

    // Standing hip height in metres, from the median leg length
    const legLengths = [];
    for (let f = 0; f < N; f++) {
        legLengths.push(
            (dist(f, LM.LEFT_HIP, LM.LEFT_KNEE) + dist(f, LM.LEFT_KNEE, LM.LEFT_ANKLE) +
             dist(f, LM.RIGHT_HIP, LM.RIGHT_KNEE) + dist(f, LM.RIGHT_KNEE, LM.RIGHT_ANKLE)) / 2
        );
    }
    const hipHeight = median(legLengths) * HIP_HEIGHT_PER_LEG_LENGTH;

    const feet = [
        [LM.LEFT_HEEL, LM.LEFT_FOOT_INDEX, LM.LEFT_ANKLE],
        [LM.RIGHT_HEEL, LM.RIGHT_FOOT_INDEX, LM.RIGHT_ANKLE],
    ];
    const footHeight = [new Float32Array(N), new Float32Array(N)]; // lowest point of each foot, relative to hips
    let root = new Float32Array(N * 3);
    for (let f = 0; f < N; f++) {
        const hipY = (at(f, LM.LEFT_HIP, 1) + at(f, LM.RIGHT_HIP, 1)) / 2;
        for (let s = 0; s < 2; s++) {
            footHeight[s][f] = Math.min(at(f, feet[s][0], 1), at(f, feet[s][1], 1)) - hipY;
        }
        root[f * 3 + 1] = -Math.min(footHeight[0][f], footHeight[1][f]) / hipHeight;
    }

    // Sideways / depth travel from the image
    const img = prepared.img;
    const hasImage = !!capture.image && capture.width > 0 && capture.height > 0;
    if (hasImage) {
        let scale = new Float32Array(N); // pixels per metre
        for (let f = 0; f < N; f++) {
            let px = 0;
            let metres = 0;
            for (const [i, j] of LANDMARK_BONES) {
                const a = (f * LANDMARK_COUNT + i) * 2;
                const b = (f * LANDMARK_COUNT + j) * 2;
                px += Math.hypot(img[a] - img[b], img[a + 1] - img[b + 1]);
                metres += Math.hypot(at(f, i, 0) - at(f, j, 0), at(f, i, 1) - at(f, j, 1));
            }
            scale[f] = metres > 1e-6 ? px / metres : NaN;
        }
        const fallback = median(scale);
        if (Number.isFinite(fallback) && fallback > 0) {
            for (let f = 0; f < N; f++) if (!Number.isFinite(scale[f]) || scale[f] <= 0) scale[f] = fallback;
            scale = smoothSeries(scale, N, 1, 0.2 * fps);

            const xs = new Float32Array(N);
            for (let f = 0; f < N; f++) {
                const u = (img[(f * LANDMARK_COUNT + LM.LEFT_HIP) * 2] + img[(f * LANDMARK_COUNT + LM.RIGHT_HIP) * 2]) / 2;
                xs[f] = (u - capture.width / 2) / scale[f];
            }
            const xCentre = median(xs);
            for (let f = 0; f < N; f++) root[f * 3] = (xs[f] - xCentre) / hipHeight;

            if (opt.estimateDepth) {
                const focalPx = capture.height / 2 / Math.tan(THREE.MathUtils.degToRad(opt.cameraFovY) / 2);
                const depths = Array.from(scale, (s) => focalPx / s);
                const depthCentre = median(depths);
                let zs = Float32Array.from(depths, (d) => -(d - depthCentre) / hipHeight);
                zs = smoothSeries(zs, N, 1, 0.25 * fps);
                for (let f = 0; f < N; f++) root[f * 3 + 2] = zs[f];
            }
        }
    }
    root = smoothSeries(root, N, 3, opt.rootSmoothing * fps);

    // Foot contacts: a foot counts as planted while it is near the floor and nearly still
    const contacts = { leftFoot: new Uint8Array(N), rightFoot: new Uint8Array(N) };
    const keys = ['leftFoot', 'rightFoot'];
    const anklePos = (f, s, c) => {
        const hipC = (at(f, LM.LEFT_HIP, c) + at(f, LM.RIGHT_HIP, c)) / 2;
        return root[f * 3 + c] + (at(f, feet[s][2], c) - hipC) / hipHeight;
    };
    for (let s = 0; s < 2; s++) {
        for (let f = 0; f < N; f++) {
            const floor = Math.min(footHeight[0][f], footHeight[1][f]);
            const height = (footHeight[s][f] - floor) / hipHeight;
            const g = Math.min(N - 1, f + 1);
            const h = Math.max(0, f - 1);
            const dt = Math.max(1, g - h) / fps;
            const speed = Math.hypot(
                anklePos(g, s, 0) - anklePos(h, s, 0),
                anklePos(g, s, 1) - anklePos(h, s, 1),
                anklePos(g, s, 2) - anklePos(h, s, 2)
            ) / dt;
            contacts[keys[s]][f] = height < 0.04 && speed < 0.6 ? 1 : 0;
        }
    }

    return { rootPositions: root, hipHeight, contacts };
}
