// Run with: npm test   (Node 18+; needs `npm install` once for three.js)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Choreography } from '../choreo/choreography.js';
import { JOINT_NAMES } from '../choreo/skeleton.js';
import { samplePose, standingPose, headingOf, poseDistance, createPose } from '../choreo/pose.js';
import {
    createSequence, createClip, createSpeedChange, compileSequence,
    suggestInPoint, suggestLoopOutPoint, sequenceToJSON, sequenceFromJSON, barBeat, beatIndex,
} from '../choreo/sequence.js';

const FPS = 30;
const Z_AXIS = new THREE.Vector3(0, 0, 1);

/**
 * A synthetic dance: the left arm swings by armAngle(t) about Z, the dancer
 * walks along +Z at `speed` hip heights per second, facing `heading` radians.
 */
function makeDance(name, seconds, { armAngle = (t) => t, speed = 0, heading = 0 } = {}) {
    const N = Math.round(seconds * FPS);
    const rotations = Object.fromEntries(JOINT_NAMES.map((n) => [n, new Float32Array(N * 4)]));
    const rootPositions = new Float32Array(N * 3);
    const q = new THREE.Quaternion();
    const hipsQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
    for (let f = 0; f < N; f++) {
        const t = f / FPS;
        for (const n of JOINT_NAMES) rotations[n][f * 4 + 3] = 1;
        q.setFromAxisAngle(Z_AXIS, armAngle(t)).toArray(rotations.leftUpperArm, f * 4);
        hipsQ.toArray(rotations.hips, f * 4);
        rootPositions[f * 3 + 1] = 1;
        rootPositions[f * 3 + 2] = speed * t;
    }
    return new Choreography({ name, fps: FPS, frameCount: N, rotations, rootPositions });
}

const armAngleOf = (pose) => {
    const o = JOINT_NAMES.indexOf('leftUpperArm') * 4;
    return 2 * Math.atan2(pose.rot[o + 2], pose.rot[o + 3]);
};
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} expected ${b}, got ${a}`);

/** Compiled pose at a song time. */
const poseAt = (compiled, t) => samplePose(compiled.choreo, t);

test('samplePose interpolates between frames', () => {
    const dance = makeDance('a', 2, { armAngle: (t) => t, speed: 1 });
    const p = samplePose(dance, 0.5 + 0.5 / FPS);
    near(armAngleOf(p), 0.5 + 0.5 / FPS, 1e-4, 'arm angle');
    near(p.root[2], 0.5 + 0.5 / FPS, 1e-5, 'root z');
});

test('standing pose hangs the arms down and stands at full hip height', () => {
    const pose = standingPose();
    const o = JOINT_NAMES.indexOf('leftUpperArm') * 4;
    const dir = new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion().fromArray(pose.rot, o));
    assert.ok(dir.y < -0.95, `left arm should point down, got ${dir.toArray()}`);
    const r = JOINT_NAMES.indexOf('rightUpperArm') * 4;
    const rdir = new THREE.Vector3(-1, 0, 0).applyQuaternion(new THREE.Quaternion().fromArray(pose.rot, r));
    assert.ok(rdir.y < -0.95, `right arm should point down, got ${rdir.toArray()}`);
    assert.equal(pose.root[1], 1);
    near(headingOf(pose), 0, 1e-9);
});

test('clips play back to back for exactly their trimmed lengths', () => {
    const seq = createSequence({ tempo: { bpm: 120 } });
    seq.clips.push(createClip(makeDance('a', 4), { in: 0, out: 2 }));
    seq.clips.push(createClip(makeDance('b', 4), { in: 1, out: 3.5, loops: 2 }));
    const { choreo, timeline } = compileSequence(seq);
    near(timeline.duration, 2 + 2.5 * 2, 1e-3, 'duration');
    near(choreo.duration, 7, 1 / FPS, 'choreography length');
    assert.deepEqual(timeline.clips.map((c) => [c.clipIndex, c.loop]), [[0, 0], [1, 0], [1, 1]]);
    near(timeline.clips[1].start, 2, 1e-3);
    near(timeline.clips[2].start, 4.5, 1e-3);
    assert.equal(timeline.transitions[1].kind, 'loop');
});

test('a crossfade is centred on the cut and blends both dances', () => {
    const seq = createSequence({ tempo: { bpm: 60 } }); // 1 beat = 1 s
    seq.clips.push(createClip(makeDance('a', 4, { armAngle: () => 0 }), { out: 2, transition: { style: 'crossfade', beats: 1 } }));
    seq.clips.push(createClip(makeDance('b', 4, { armAngle: () => 1 })));
    const compiled = compileSequence(seq);
    near(armAngleOf(poseAt(compiled, 1.4)), 0, 1e-4, 'before the blend');
    near(armAngleOf(poseAt(compiled, 2.0)), 0.5, 1e-3, 'half way at the cut');
    near(armAngleOf(poseAt(compiled, 2.6)), 1, 1e-4, 'after the blend');
    const t = compiled.timeline.transitions[0];
    near(t.start, 1.5, 1e-3);
    near(t.end, 2.5, 1e-3);
});

test('the next clip starts where the previous one ended (no teleport)', () => {
    const seq = createSequence({ tempo: { bpm: 60 } });
    seq.clips.push(createClip(makeDance('walk', 3, { speed: 1 }), { transition: { style: 'cut', beats: 0 } }));
    seq.clips.push(createClip(makeDance('walk again', 3, { speed: 1 })));
    const compiled = compileSequence(seq);
    const { rootPositions: r, frameCount: N } = compiled.choreo;
    let maxStep = 0;
    for (let f = 1; f < N; f++) maxStep = Math.max(maxStep, Math.abs(r[f * 3 + 2] - r[(f - 1) * 3 + 2]));
    assert.ok(maxStep < 2 / FPS, `root jumped by ${maxStep}`);
    near(r[(N - 1) * 3 + 2], 6 - 1 / FPS, 0.05, 'travel accumulates across clips');
});

test('matchHeading turns the next clip to face the way the previous one ended', () => {
    const seq = createSequence({ tempo: { bpm: 60 } });
    seq.matchHeading = true;
    seq.clips.push(createClip(makeDance('a', 2, { heading: Math.PI / 2 }), { transition: { style: 'cut', beats: 0 } }));
    seq.clips.push(createClip(makeDance('b', 2, { heading: 0 })));
    const compiled = compileSequence(seq);
    near(headingOf(poseAt(compiled, 3)), Math.PI / 2, 1e-3);
});

test('a neutral transition passes exactly through the neutral pose at the cut', () => {
    const seq = createSequence({ tempo: { bpm: 60 } });
    seq.clips.push(createClip(makeDance('a', 3, { armAngle: () => 0.3 }), { out: 2, transition: { style: 'neutral', beats: 2 } }));
    seq.clips.push(createClip(makeDance('b', 3, { armAngle: () => -0.4 })));
    const compiled = compileSequence(seq);
    const neutral = standingPose();
    assert.ok(poseDistance(poseAt(compiled, 2), neutral) < 1e-2, 'pose at the cut is the neutral pose');
    near(armAngleOf(poseAt(compiled, 0.5)), 0.3, 1e-4, 'clip A untouched before the blend');
    near(armAngleOf(poseAt(compiled, 3.5)), -0.4, 1e-4, 'clip B untouched after the blend');
});

test('half time for a bar adds two beats and keeps later material on the beat', () => {
    const bpm = 120;
    const beat = 60 / bpm;
    const seq = createSequence({ tempo: { bpm, offset: 0.25 } });
    seq.clips.push(createClip(makeDance('a', 8), { out: 16 * beat }));
    seq.clips.push(createClip(makeDance('b', 8), { out: 8 * beat }));
    // Bar 2 (beats 4–7) at half time, with half-beat ramps
    seq.speedChanges.push(createSpeedChange({ startBeat: 4, beats: 4, speed: 0.5, rampBeats: 0.5 }));
    const { timeline } = compileSequence(seq);
    near(timeline.duration, 0.25 + (24 + 2) * beat, 2e-3, 'two extra beats');
    // Clip b nominally starts at beat 16; the half-time bar delays it by exactly 2 beats
    near(timeline.clips[1].start, 0.25 + 18 * beat, 2e-3, 'clip b lands on a beat');
});

test('the dance holds its pose during a speed-0 hit and before the first downbeat', () => {
    const seq = createSequence({ tempo: { bpm: 60, offset: 1 } });
    seq.clips.push(createClip(makeDance('a', 6, { armAngle: (t) => t * 0.1 })));
    seq.speedChanges.push(createSpeedChange({ startBeat: 2, beats: 1, speed: 0, rampBeats: 0 }));
    const compiled = compileSequence(seq);
    near(armAngleOf(poseAt(compiled, 0.5)), 0, 1e-4, 'held before the downbeat');
    const a = armAngleOf(poseAt(compiled, 1 + 2.1));
    const b = armAngleOf(poseAt(compiled, 1 + 2.9));
    near(a, b, 1e-4, 'frozen during the hit');
    near(a, 0.2, 2e-3, 'frozen at the pose of beat 2');
    near(compiled.timeline.duration, 1 + 6 + 1, 2e-3, 'the hold adds one beat');
});

test('clip tempo matching: a 100 bpm dance on a 120 bpm song plays 1.2x faster', () => {
    const seq = createSequence({ tempo: { bpm: 120 } });
    seq.clips.push(createClip(makeDance('a', 6), { sourceBpm: 100 }));
    near(compileSequence(seq).timeline.duration, 6 / 1.2, 2e-3);
});

test('suggestInPoint finds where the next dance resembles the end of the previous one', () => {
    const seq = createSequence({ tempo: { bpm: 60 } });
    seq.clips.push(createClip(makeDance('a', 3, { armAngle: () => 0.8 }), { out: 2 }));
    // b sweeps its arm through 0.8 rad at t = 0.8 s
    seq.clips.push(createClip(makeDance('b', 4, { armAngle: (t) => t })));
    near(suggestInPoint(seq, 0), 0.8, 1.5 / FPS);
});

test('suggestLoopOutPoint picks an out point that flows back into the in point', () => {
    const seq = createSequence({ tempo: { bpm: 60 } });
    // Arm swings with a 2 s period; a loop from 0 should end near 2 s (or 4 s)
    seq.clips.push(createClip(makeDance('swing', 6, { armAngle: (t) => Math.sin(Math.PI * t) }), { in: 0, out: 3.5, loops: 2 }));
    const out = suggestLoopOutPoint(seq, 0);
    near(out, 4, 2 / FPS);
});

test('sequences survive a save / load round trip', () => {
    const dance = makeDance('a', 3);
    const seq = createSequence({ name: 'Mix', tempo: { bpm: 96, offset: 0.4, beatsPerBar: 3 } });
    seq.clips.push(createClip(dance, { out: 2, loops: 2, transition: { style: 'neutral', beats: 1.5 } }));
    seq.clips.push(createClip(dance, { in: 1 }));
    seq.speedChanges.push(createSpeedChange({ startBeat: 3, beats: 3, speed: 2 }));
    seq.neutralPose = standingPose();
    const loaded = sequenceFromJSON(JSON.stringify(sequenceToJSON(seq)));
    assert.equal(loaded.name, 'Mix');
    assert.deepEqual(loaded.tempo, seq.tempo);
    assert.equal(loaded.clips.length, 2);
    assert.equal(loaded.clips[0].choreo, loaded.clips[1].choreo, 'a shared dance is stored once');
    assert.equal(loaded.clips[0].transition.style, 'neutral');
    assert.equal(loaded.speedChanges[0].speed, 2);
    near(compileSequence(loaded).timeline.duration, compileSequence(seq).timeline.duration, 1e-6);
});

test('bar / beat helpers', () => {
    assert.deepEqual(barBeat(0, 4), { bar: 1, beat: 1 });
    assert.deepEqual(barBeat(5, 4), { bar: 2, beat: 2 });
    assert.deepEqual(barBeat(6.5, 4), { bar: 2, beat: 3.5 });
    assert.equal(beatIndex(3, 1, 4), 8);
});

test('an empty sequence compiles to nothing', () => {
    assert.equal(compileSequence(createSequence()), null);
    assert.ok(createPose());
});

test('a ramped speed change on the very first beat still shifts later material by whole beats', () => {
    // 60 BPM: 1 beat = 1 s. A 4-beat hold from beat 0 with a 1-beat ramp must delay what follows by exactly 4 s.
    const seq = createSequence({ tempo: { bpm: 60 } });
    seq.clips.push(createClip(makeDance('a', 6), { out: 4 }));
    seq.clips.push(createClip(makeDance('b', 6), { out: 2 }));
    seq.speedChanges.push(createSpeedChange({ startBeat: 0, beats: 4, speed: 0, rampBeats: 1 }));
    const { timeline } = compileSequence(seq);
    near(timeline.clips[1].start, 8, 2e-3, 'clip b starts 4 beats late');
    near(timeline.duration, 10, 2e-3);
});
