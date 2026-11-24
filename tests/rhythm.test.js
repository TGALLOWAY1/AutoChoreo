// Rhythm: tempo and beat estimation, counts, sections, alignment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Choreography } from '../choreo/choreography.js';
import { JOINT_NAMES } from '../choreo/skeleton.js';
import { referenceTrackFromChoreography } from '../choreo/compare.js';
import {
    fft, audioOnsetEnvelope, motionOnsetEnvelope, analyzeEnvelope, buildSections, countAt,
    nextBeatTime, alignOnsets,
} from '../choreo/rhythm.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} expected ${b}, got ${a}`);

/** A drum-like track: a decaying noise burst + tone on every beat, quieter off-beat hats, light noise. */
function clickTrack({ bpm, offset, seconds, sampleRate = 22050, seed = 1 }) {
    let s = seed;
    const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const out = new Float32Array(Math.round(seconds * sampleRate));
    const beat = 60 / bpm;
    for (let i = 0; i < out.length; i++) out[i] = 0.02 * rand();
    for (let t = offset, k = 0; t < seconds; t += beat / 2, k++) {
        const loud = k % 2 === 0 ? 1 : 0.25;
        const start = Math.round(t * sampleRate);
        for (let j = 0; j < 0.08 * sampleRate && start + j < out.length; j++) {
            const env = Math.exp(-j / (0.015 * sampleRate));
            out[start + j] += loud * env * (0.6 * rand() + 0.4 * Math.sin((2 * Math.PI * 180 * j) / sampleRate));
        }
    }
    return { samples: out, sampleRate };
}

test('fft of a sinusoid peaks at its bin', () => {
    const n = 64;
    const re = Float32Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * 5 * i) / n));
    const im = new Float32Array(n);
    fft(re, im);
    near(Math.hypot(re[5], im[5]), n / 2, 1e-3);
    near(Math.hypot(re[7], im[7]), 0, 1e-3);
});

for (const [bpm, offset] of [[120, 0.35], [95, 1.2], [142, 0.1]]) {
    test(`music at ${bpm} BPM: tempo and first beat are found`, () => {
        const { samples, sampleRate } = clickTrack({ bpm, offset, seconds: 20 });
        const result = analyzeEnvelope(audioOnsetEnvelope(samples, sampleRate));
        near(result.bpm, bpm, 1, 'bpm');
        const beat = 60 / bpm;
        // The first beat found is a real beat (on the grid), at or near the start of the music
        const phaseError = Math.abs(((result.offset - offset) / beat + 0.5) % 1 - 0.5) * beat;
        assert.ok(phaseError < 0.03, `beat phase off by ${phaseError}s`);
        assert.ok(result.offset < offset + beat + 0.03, `first beat ${result.offset}`);
        assert.ok(result.confidence > 0.2);
    });
}

test('dance movement without music: the tempo of its hits is found', () => {
    // The arms hit a position and stop on every beat at 100 BPM
    const fps = 30;
    const bpm = 100;
    const seconds = 16;
    const N = seconds * fps;
    const rotations = Object.fromEntries(JOINT_NAMES.map((n) => [n, new Float32Array(N * 4)]));
    const q = new THREE.Quaternion();
    const Z = new THREE.Vector3(0, 0, 1);
    const beat = 60 / bpm;
    for (let f = 0; f < N; f++) {
        const t = f / fps;
        for (const n of JOINT_NAMES) rotations[n][f * 4 + 3] = 1;
        const k = Math.floor((t - 0.4) / beat);
        const u = Math.min(1, Math.max(0, ((t - 0.4) - k * beat) / (beat * 0.6))); // move for 60% of the beat, then hold
        const from = k % 2 === 0 ? -1 : 0.6;
        const to = k % 2 === 0 ? 0.6 : -1;
        const angle = t < 0.4 ? -1 : from + (to - from) * (u * u * (3 - 2 * u));
        q.setFromAxisAngle(Z, angle).toArray(rotations.leftUpperArm, f * 4);
        q.setFromAxisAngle(Z, -angle).toArray(rotations.rightUpperArm, f * 4);
    }
    const choreo = new Choreography({ name: 'hits', fps, frameCount: N, rotations, rootPositions: new Float32Array(N * 3).fill(1) });
    const result = analyzeEnvelope(motionOnsetEnvelope(referenceTrackFromChoreography(choreo)));
    near(result.bpm, bpm, 2, 'bpm');
});

test('sections are eights on the beat grid; a short tail joins the last one', () => {
    const rhythm = { bpm: 120, offset: 0.5 };
    const even = buildSections({ ...rhythm, duration: 0.5 + 40 * 0.5 });
    assert.equal(even.length, 5);
    assert.deepEqual(even.map((s) => s.label), ['Counts 1–8', 'Counts 9–16', 'Counts 17–24', 'Counts 25–32', 'Counts 33–40']);
    near(even[1].start, 0.5 + 8 * 0.5, 1e-9);
    const tail = buildSections({ ...rhythm, duration: 0.5 + 42 * 0.5 + 0.2 });
    assert.equal(tail.length, 5);
    assert.equal(tail[4].endBeat, 42);
    const short = buildSections({ ...rhythm, duration: 0.5 + 12 * 0.5 });
    assert.deepEqual(short.map((s) => [s.startBeat, s.endBeat]), [[0, 8], [8, 12]]);
});

test('counts wrap in eights and the next beat is found', () => {
    const rhythm = { bpm: 120, offset: 1 };
    assert.deepEqual(countAt(1.0, rhythm), { beat: 0, count: 1, eight: 0 });
    assert.deepEqual(countAt(1 + 9 * 0.5 + 0.1, rhythm), { beat: 9, count: 2, eight: 1 });
    assert.equal(countAt(0.6, rhythm).count, 8); // the pickup before count 1 is the previous "8"
    near(nextBeatTime(1.2, rhythm), 1.5, 1e-9);
    near(nextBeatTime(1.5, rhythm), 1.5, 1e-9);
});

test('two recordings of the same music line up by their onsets', () => {
    const song = clickTrack({ bpm: 118, offset: 0.3, seconds: 30, seed: 3 });
    // Fills at irregular moments, so the alignment is unique
    for (const at of [1.1, 3.9, 5.2, 9.7, 12.4, 13.1, 17.8, 21.3, 22.2, 26.9]) {
        const start = Math.round(at * song.sampleRate);
        for (let j = 0; j < 2000 && start + j < song.samples.length; j++) song.samples[start + j] += 0.8 * Math.sin(j * 0.3) * Math.exp(-j / 400);
    }
    // A phone recording that started 4.2 s into the song, with its own noise
    const cut = Math.round(4.2 * song.sampleRate);
    const recording = song.samples.slice(cut, cut + 15 * song.sampleRate).map((v, i) => 0.7 * v + 0.01 * Math.sin(i));
    const a = audioOnsetEnvelope(song.samples, song.sampleRate);
    const b = audioOnsetEnvelope(recording, song.sampleRate);
    const { offset, confidence, candidates } = alignOnsets(a, b, 20);
    near(offset, 4.2, 0.02, 'offset');
    assert.ok(confidence > 5, `confidence ${confidence}`);
    assert.ok(candidates.length > 1 && candidates[0].score > candidates[1].score);
});

test('a looped song keeps the true shift (modulo the loop) among the candidates', () => {
    // A 4-second loop (two bars at 120 BPM) with an irregular fill, repeated 6 times
    const loop = clickTrack({ bpm: 120, offset: 0, seconds: 4, seed: 5 });
    for (const at of [0.7, 2.6]) {
        const start = Math.round(at * loop.sampleRate);
        for (let j = 0; j < 2000; j++) loop.samples[start + j] += 0.8 * Math.sin(j * 0.3) * Math.exp(-j / 400);
    }
    const song = new Float32Array(loop.samples.length * 6);
    for (let k = 0; k < 6; k++) song.set(loop.samples, k * loop.samples.length);
    const cut = Math.round(3 * loop.sampleRate);
    const recording = song.slice(cut, cut + 8 * loop.sampleRate);
    const a = audioOnsetEnvelope(song, loop.sampleRate);
    const b = audioOnsetEnvelope(recording, loop.sampleRate);
    const { candidates } = alignOnsets(a, b, 20);
    const modLoop = (x) => ((x % 4) + 4) % 4;
    assert.ok(Math.abs(modLoop(candidates[0].offset) - 3) < 0.02, JSON.stringify(candidates));
});
