// Comparison engine: normalisation, mirroring, timing vs. pose separation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Choreography } from '../choreo/choreography.js';
import { JOINT_NAMES } from '../choreo/skeleton.js';
import { createPose, samplePose } from '../choreo/pose.js';
import {
    KP, KP_COUNT, SEG, SEG_COUNT, FEATURE_SIZE, KEYPOINTS, keypointsFromPose, keypointsFromLandmarks,
    featuresFromKeypoints, mirrorKeypoints, compareFeatures, referenceTrackFromChoreography,
    sampleTrackFeatures, sampleTrackKeypoints, alignByMovement, segmentVisibility, unitAngle,
} from '../choreo/compare.js';
import { SyncScorer, AttemptAccumulator } from '../choreo/scoring.js';

const FPS = 30;
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} expected ${b}, got ${a}`);

/**
 * A synthetic dance: arms and legs swing on several incommensurate rhythms, so
 * no two moments look alike (lag search and alignment have a unique answer).
 */
function makeDance(name, seconds, { phase = 0, armBias = 0, armCenter = -1.1 } = {}) {
    const N = Math.round(seconds * FPS);
    const rotations = Object.fromEntries(JOINT_NAMES.map((n) => [n, new Float32Array(N * 4)]));
    const rootPositions = new Float32Array(N * 3);
    const q = new THREE.Quaternion();
    const set = (joint, f, axis, angle) => q.setFromAxisAngle(axis, angle).toArray(rotations[joint], f * 4);
    const X = new THREE.Vector3(1, 0, 0);
    const Y = new THREE.Vector3(0, 1, 0);
    const Z = new THREE.Vector3(0, 0, 1);
    for (let f = 0; f < N; f++) {
        const t = f / FPS + phase;
        for (const n of JOINT_NAMES) rotations[n][f * 4 + 3] = 1;
        set('leftUpperArm', f, Z, armCenter + armBias + 0.9 * Math.sin(2.1 * t));
        set('rightUpperArm', f, Z, 1.1 - 0.8 * Math.sin(1.7 * t + 1));
        set('leftLowerArm', f, Y, 0.9 + 0.7 * Math.sin(3.1 * t));
        set('rightLowerArm', f, Y, -0.8 - 0.6 * Math.sin(2.6 * t + 0.4));
        set('leftUpperLeg', f, X, -0.5 * Math.max(0, Math.sin(1.3 * t)));
        set('leftLowerLeg', f, X, 0.8 * Math.max(0, Math.sin(1.3 * t)));
        set('rightUpperLeg', f, X, -0.4 * Math.max(0, Math.sin(1.9 * t + 2)));
        set('rightLowerLeg', f, X, 0.7 * Math.max(0, Math.sin(1.9 * t + 2)));
        set('hips', f, Y, 0.3 * Math.sin(0.7 * t));
        set('spine', f, X, 0.15 * Math.sin(1.1 * t));
        rootPositions[f * 3 + 1] = 1;
    }
    return new Choreography({ name, fps: FPS, frameCount: N, rotations, rootPositions });
}

/** A different routine: arms raised forward and overhead, knees deep in a squat. */
function makeOtherDance(name, seconds) {
    const N = Math.round(seconds * FPS);
    const rotations = Object.fromEntries(JOINT_NAMES.map((n) => [n, new Float32Array(N * 4)]));
    const rootPositions = new Float32Array(N * 3);
    const q = new THREE.Quaternion();
    const set = (joint, f, axis, angle) => q.setFromAxisAngle(axis, angle).toArray(rotations[joint], f * 4);
    const Y = new THREE.Vector3(0, 1, 0);
    const X = new THREE.Vector3(1, 0, 0);
    for (let f = 0; f < N; f++) {
        const t = f / FPS;
        for (const n of JOINT_NAMES) rotations[n][f * 4 + 3] = 1;
        set('leftUpperArm', f, Y, -1.2 - 0.3 * Math.sin(2.4 * t));
        set('rightUpperArm', f, Y, 1.2 + 0.3 * Math.sin(1.9 * t));
        set('leftUpperLeg', f, X, -1.1);
        set('leftLowerLeg', f, X, 1.6);
        set('rightUpperLeg', f, X, -1.1);
        set('rightLowerLeg', f, X, 1.6);
        set('hips', f, Y, 1.2 + 0.2 * Math.sin(t));
        rootPositions[f * 3 + 1] = 0.7;
    }
    return new Choreography({ name, fps: FPS, frameCount: N, rotations, rootPositions });
}

/** A still dance: one held pose. */
function makeStill(seconds) {
    const N = Math.round(seconds * FPS);
    const rotations = Object.fromEntries(JOINT_NAMES.map((n) => [n, new Float32Array(N * 4)]));
    for (const n of JOINT_NAMES) for (let f = 0; f < N; f++) rotations[n][f * 4 + 3] = 1;
    return new Choreography({ name: 'still', fps: FPS, frameCount: N, rotations, rootPositions: new Float32Array(N * 3).fill(1) });
}

/** Pretend to be a webcam: different body, standing somewhere else, filmed from an angle, in MediaPipe's format. */
function asSeenByCamera(kp, { yaw = 0, pitch = 0, roll = 0, scale = 1, shift = [0, 0, 0], limbScale = 1 } = {}) {
    const p = Array.from({ length: KP_COUNT }, (_, k) => new THREE.Vector3(kp[k * 3], kp[k * 3 + 1], kp[k * 3 + 2]));
    // Different proportions: lengthen forearms and shins, widen the shoulders (keeps directions)
    const lengthen = (from, to, children, s) => {
        const d = p[to].clone().sub(p[from]).multiplyScalar(s - 1);
        for (const c of [to, ...children]) p[c].add(d);
    };
    lengthen(KP.leftElbow, KP.leftWrist, [], limbScale);
    lengthen(KP.rightElbow, KP.rightWrist, [], limbScale);
    lengthen(KP.leftKnee, KP.leftAnkle, [KP.leftToe], limbScale);
    lengthen(KP.rightKnee, KP.rightAnkle, [KP.rightToe], limbScale);
    const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'));
    const world = new Float32Array(33 * 4);
    p.forEach((v, k) => {
        v.applyQuaternion(rot).multiplyScalar(scale).add(new THREE.Vector3(...shift));
        const i = KEYPOINTS[k][1] * 4;
        world[i] = v.x; world[i + 1] = -v.y; world[i + 2] = -v.z; world[i + 3] = 0.95;
    });
    return world;
}

const featuresOf = (kp) => featuresFromKeypoints(kp);
const ALL_VISIBLE = new Float32Array(SEG_COUNT).fill(1);

test('forward kinematics: T-pose arms point sideways, legs down, toes forward', () => {
    const pose = createPose();
    for (let j = 0; j < JOINT_NAMES.length; j++) pose.rot[j * 4 + 3] = 1;
    pose.root.set([0, 1, 0]);
    const kp = keypointsFromPose(pose);
    const at = (k) => new THREE.Vector3(kp[k * 3], kp[k * 3 + 1], kp[k * 3 + 2]);
    assert.ok(at(KP.leftWrist).x > at(KP.leftElbow).x && at(KP.leftElbow).x > at(KP.leftShoulder).x, 'left arm along +X');
    assert.ok(at(KP.rightWrist).x < at(KP.rightShoulder).x, 'right arm along -X');
    near(at(KP.leftAnkle).y, 1 - 0.92, 1e-5, 'ankle height');
    assert.ok(at(KP.leftToe).z > at(KP.leftAnkle).z, 'toes forward');
    assert.ok(at(KP.nose).z > 0 && at(KP.nose).y > at(KP.leftShoulder).y, 'nose forward and above shoulders');
});

test('features ignore position, size, body proportions and camera viewpoint', () => {
    const dance = makeDance('a', 6);
    const pose = samplePose(dance, 2.3);
    const kp = keypointsFromPose(pose);
    const ref = featuresOf(kp);
    const seen = keypointsFromLandmarks(asSeenByCamera(kp, { yaw: 0.6, pitch: 0.35, roll: -0.2, scale: 0.9, shift: [0.4, -0.1, 2], limbScale: 1.25 }));
    const user = featuresOf(seen);
    for (let s = 0; s < SEG_COUNT; s++) {
        if (s === SEG.torso || s === SEG.facing) continue; // global features: depend on the view on purpose
        near(unitAngle(ref, s * 3, user, s * 3), 0, 1e-3, `segment ${s}`);
    }
    // Turning to face elsewhere (yaw only) keeps the lean, changes only the facing direction
    const turned = featuresOf(keypointsFromLandmarks(asSeenByCamera(kp, { yaw: 0.5, scale: 1.3, shift: [1, 0, 3] })));
    near(unitAngle(ref, SEG.torso * 3, turned, SEG.torso * 3), 0, 1e-4, 'torso lean');
    near(unitAngle(ref, SEG.facing * 3, turned, SEG.facing * 3), 0.5, 1e-3, 'facing differs by the turn');
});

test('the same pose scores ~1; a moved arm lowers only that arm', () => {
    const dance = makeDance('a', 6);
    const kp = keypointsFromPose(samplePose(dance, 1));
    const a = featuresOf(kp);
    const per = new Float32Array(SEG_COUNT);
    near(compareFeatures(a, a, undefined, per), 1, 1e-6);
    // Swing the left forearm 60° about the elbow
    const moved = Float32Array.from(kp);
    const e = new THREE.Vector3(kp[KP.leftElbow * 3], kp[KP.leftElbow * 3 + 1], kp[KP.leftElbow * 3 + 2]);
    const w = new THREE.Vector3(kp[KP.leftWrist * 3], kp[KP.leftWrist * 3 + 1], kp[KP.leftWrist * 3 + 2]);
    const forearm = w.clone().sub(e);
    const axis = new THREE.Vector3().crossVectors(forearm, new THREE.Vector3(0, 1, 0)).normalize();
    w.copy(forearm).applyAxisAngle(axis, Math.PI / 3).add(e);
    moved.set([w.x, w.y, w.z], KP.leftWrist * 3);
    const score = compareFeatures(a, featuresOf(moved), undefined, per);
    assert.ok(score < 0.97 && score > 0.85, `overall ${score}`);
    assert.ok(per[SEG.leftForearm] < 0.5, 'left forearm flagged');
    for (const s of [SEG.rightForearm, SEG.leftUpperArm, SEG.leftThigh]) near(per[s], 1, 1e-6, `segment ${s} unaffected`);
});

test('mirroring swaps sides: a mirrored left-arm raise matches a right-arm raise', () => {
    const pose = createPose();
    for (let j = 0; j < JOINT_NAMES.length; j++) pose.rot[j * 4 + 3] = 1;
    pose.root.set([0, 1, 0]);
    const raise = (joint, angle) => {
        const p = createPose();
        p.rot.set(pose.rot); p.root.set(pose.root);
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle).toArray(p.rot, JOINT_NAMES.indexOf(joint) * 4);
        return keypointsFromPose(p);
    };
    const leftUp = raise('leftUpperArm', 1.0);   // left arm up
    const rightUp = raise('rightUpperArm', -1.0); // right arm up
    near(compareFeatures(featuresOf(mirrorKeypoints(leftUp)), featuresOf(rightUp)), 1, 1e-5, 'mirror match');
    assert.ok(compareFeatures(featuresOf(leftUp), featuresOf(rightUp)) < 0.95, 'unmirrored differ');
    assert.deepEqual(Array.from(mirrorKeypoints(mirrorKeypoints(leftUp))).map((v) => +v.toFixed(5)), Array.from(leftUp).map((v) => +v.toFixed(5)));
});

/** Feed a scorer with a "person" performing `dance` with their own timing shift and body. */
function performance(track, dance, { shift = 0, from = 1, to = 5, camera = { yaw: 0.3, pitch: 0.2, limbScale: 1.2 } } = {}) {
    const scorer = new SyncScorer(track);
    const results = [];
    const kp = new Float32Array(KP_COUNT * 3);
    for (let t = from; t <= to; t += 1 / 30) {
        // The person is `shift` seconds behind the music: at song time t they show the pose of t − shift
        keypointsFromPose(samplePose(dance, t - shift), kp);
        const world = asSeenByCamera(kp, camera);
        const vis = new Float32Array(KP_COUNT);
        const ukp = keypointsFromLandmarks(world, undefined, vis);
        scorer.push(t, featuresFromKeypoints(ukp), segmentVisibility(vis));
        const r = scorer.evaluate();
        if (r) results.push(r);
    }
    return results;
}
const tail = (rs) => rs.slice(Math.floor(rs.length / 3));
const mean = (rs, key) => rs.reduce((s, r) => s + r[key], 0) / rs.length;

test('in time: high scores, no lag, in-sync status', () => {
    const dance = makeDance('a', 8);
    const track = referenceTrackFromChoreography(dance);
    const rs = tail(performance(track, dance));
    assert.ok(mean(rs, 'pose') > 0.97, `pose ${mean(rs, 'pose')}`);
    near(mean(rs, 'lag'), 0, 0.02, 'lag');
    assert.ok(mean(rs, 'overall') > 0.95, `overall ${mean(rs, 'overall')}`);
    assert.ok(rs.filter((r) => r.status === 'in-sync').length / rs.length > 0.9);
});

test('right move, wrong time: the lag is measured and the pose still scores well', () => {
    const dance = makeDance('a', 8);
    const track = referenceTrackFromChoreography(dance);
    const late = tail(performance(track, dance, { shift: 0.25 }));
    near(mean(late, 'lag'), 0.25, 0.04, 'late lag');
    assert.ok(mean(late, 'pose') > 0.95, `pose ${mean(late, 'pose')}`);
    assert.ok(mean(late, 'inTime') < mean(late, 'pose') - 0.02, 'on-the-beat comparison is worse');
    assert.ok(mean(late, 'timing') < 0.6, `timing ${mean(late, 'timing')}`);
    assert.ok(late.filter((r) => r.status === 'late').length / late.length > 0.6, 'flagged late');
    assert.ok(mean(late, 'overall') < 0.9, `overall ${mean(late, 'overall')}`);

    const early = tail(performance(track, dance, { shift: -0.2 }));
    near(mean(early, 'lag'), -0.2, 0.04, 'early lag');
    assert.ok(early.filter((r) => r.status === 'early').length / early.length > 0.6, 'flagged early');
});

test('wrong move: low pose score at every shift, flagged off', () => {
    const reference = makeDance('a', 8);
    const track = referenceTrackFromChoreography(reference);
    const rs = tail(performance(track, makeOtherDance('b', 8)));
    assert.ok(mean(rs, 'pose') < 0.45, `pose ${mean(rs, 'pose')}`);
    assert.ok(mean(rs, 'overall') < 0.45, `overall ${mean(rs, 'overall')}`);
    assert.ok(rs.filter((r) => r.status === 'off').length / rs.length > 0.8);
});

test('standing still while the reference dances scores low: idle body parts earn little', () => {
    const reference = makeOtherDance('b', 8);
    const track = referenceTrackFromChoreography(reference);
    const rs = tail(performance(track, makeStill(8)));
    assert.ok(mean(rs, 'overall') < 0.35, `overall ${mean(rs, 'overall')}`);
});

test('a held pose cannot be early or late: timing is not judged', () => {
    const still = makeStill(6);
    const track = referenceTrackFromChoreography(still);
    const rs = tail(performance(track, still, { shift: 0.3 }));
    assert.ok(rs.every((r) => r.timing === null && r.lag === 0));
    assert.ok(mean(rs, 'overall') > 0.95);
});

test('an attempt summary says which way a body part was off', () => {
    const dance = makeDance('a', 8, { armCenter: 0 });
    const lowArm = makeDance('a', 8, { armCenter: 0, armBias: -0.6 }); // left arm held ~34° lower
    const track = referenceTrackFromChoreography(dance);
    const acc = new AttemptAccumulator({ start: 1, end: 5, beat: 0.5, offset: 0 });
    for (const r of performance(track, lowArm, { camera: {} })) acc.add(r);
    const summary = acc.finish();
    assert.ok(summary.valid);
    const arm = summary.segments.find((s) => s.name === 'leftUpperArm');
    const worst = [...summary.segments].filter((s) => s.score != null).sort((a, b) => a.score - b.score)[0];
    assert.equal(worst.name, 'leftUpperArm');
    assert.ok(arm.diff[1] > 0.2, `reference arm is higher (diff y ${arm.diff[1]})`);
    assert.ok(summary.perBeat.length >= 7 && summary.perBeat[0].count === 3, 'per-count scores from count 3 (t = 1 s at 0.5 s/beat)');
});

test('a recording is lined up with the reference by its movement', () => {
    const dance = makeDance('a', 20);
    const track = referenceTrackFromChoreography(dance);
    // Recording started 2.3 s before the song: recording time r shows song time r − 2.3
    const n = Math.round(10 * 30);
    const times = new Float32Array(n);
    const features = new Float32Array(n * FEATURE_SIZE);
    const weights = new Float32Array(n * SEG_COUNT).fill(1);
    const kp = new Float32Array(KP_COUNT * 3);
    for (let i = 0; i < n; i++) {
        const r = 4 + i / 30;
        times[i] = r;
        keypointsFromPose(samplePose(dance, r - 2.3), kp);
        features.set(featuresFromKeypoints(keypointsFromLandmarks(asSeenByCamera(kp, { yaw: 0.4 }))), i * FEATURE_SIZE);
    }
    const result = alignByMovement({ times, features, weights }, track);
    near(result.offset, -2.3, 1 / 30 + 1e-6, 'offset');
    assert.ok(result.score > 0.95 && result.contrast > 0.1);
});

test('reference tracks interpolate keypoints and features', () => {
    const dance = makeDance('a', 3);
    const track = referenceTrackFromChoreography(dance, { rate: 30 });
    const f = sampleTrackFeatures(track, 1.0);
    const direct = featuresFromKeypoints(keypointsFromPose(samplePose(dance, 1.0)));
    near(compareFeatures(f, direct), 1, 1e-4);
    const kp = sampleTrackKeypoints(track, 1.0);
    near(kp[KP.leftHip * 3 + 1], 1, 0.05, 'hip height');
    const mirrored = referenceTrackFromChoreography(dance, { mirror: true });
    assert.equal(mirrored.mirror, true);
    near(sampleTrackKeypoints(mirrored, 1.0)[KP.rightWrist * 3], -kp[KP.leftWrist * 3], 1e-5, 'mirrored track');
});

test('front/back mix-ups are settled by the expected facing, never by the limbs', async () => {
    const { flipFrontBack, resolveFrontBack } = await import('../choreo/compare.js');
    const dance = makeDance('a', 8);
    // The pose model reads some frames the wrong way round: undone against a camera-facing expectation
    for (let f = 0; f < 60; f++) {
        const truth = keypointsFromLandmarks(asSeenByCamera(keypointsFromPose(samplePose(dance, f / 30)), {}));
        const seen = Float32Array.from(truth);
        const confused = f % 3 === 0;
        if (confused) flipFrontBack(seen);
        assert.equal(resolveFrontBack(seen, null, 1), confused);
        near(compareFeatures(featuresFromKeypoints(seen), featuresFromKeypoints(truth)), 1, 1e-5, `frame ${f}`);
    }
    // A dancer facing the camera who raises the wrong arm keeps the wrong arm
    const pose = createPose();
    for (let j = 0; j < JOINT_NAMES.length; j++) pose.rot[j * 4 + 3] = 1;
    pose.root.set([0, 1, 0]);
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 1).toArray(pose.rot, JOINT_NAMES.indexOf('leftUpperArm') * 4);
    const wrongArm = keypointsFromPose(pose);
    const copy = Float32Array.from(wrongArm);
    assert.equal(resolveFrontBack(copy, null, 1), false);
    assert.deepEqual(Array.from(copy), Array.from(wrongArm));
    // Side-on expectations leave the reading alone
    const seen = Float32Array.from(wrongArm);
    flipFrontBack(seen);
    assert.equal(resolveFrontBack(seen, null, 0.1), false);
});
