// AutoChoreo — Sequences: stitching dances together on a musical timeline
//
// A sequence strings clips of separate dances (or repeats of one) into a single
// performance, smooths the joins between them, and can bend time in rhythmic
// amounts (half time for a bar, a held hit, a burst of double time).
//
//   song time ──► (speed changes) ──► sequence time ──► (clips + transitions) ──► pose
//
// Sequence time is the clips laid end to end, each lasting exactly its trimmed
// length. Transitions are centred on the join (the blend starts a little before
// the cut and ends a little after), so they never change where a clip starts —
// a clip trimmed to 8 beats occupies exactly 8 beats.
//
// compileSequence() flattens the whole thing into one ordinary Choreography, so
// everything downstream (baking for a rig, the transport, saving) is unchanged.

import { Choreography } from './choreography.js';
import { JOINT_NAMES } from './skeleton.js';
import {
    JOINT_COUNT, FOOT_KEYS, createPose, copyPose, samplePose, blendPoses,
    headingOf, transformPose, standingPose, poseDistance,
} from './pose.js';

export const SEQUENCE_FORMAT = 'autochoreo.sequence';
export const SEQUENCE_VERSION = 1;

/** How one clip hands over to the next. */
export const TRANSITION_STYLES = {
    crossfade: 'Crossfade',      // both dances play while one fades into the other
    neutral: 'Via neutral pose', // ease into a shared neutral pose, then out of it
    cut: 'Cut',                  // switch instantly (only the position is matched)
};

let idCounter = 0;
const newId = () => `q${++idCounter}`;

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const smoothstep = (u) => {
    const t = clamp(u, 0, 1);
    return t * t * (3 - 2 * t);
};
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ── Model ───────────────────────────────────────────────────────────

export function createSequence(init = {}) {
    return {
        name: init.name || 'Sequence',
        tempo: { bpm: 120, offset: 0, beatsPerBar: 4, ...(init.tempo || {}) },
        clips: [],
        speedChanges: [],
        neutralPose: null,   // null = the built-in standing pose; else a captured pose
        matchHeading: false, // turn each clip to face the way the previous one ended
    };
}

/**
 * A trimmed, optionally looped stretch of a choreography.
 *   in / out    Source seconds to play.
 *   loops       How many times to play it back to back.
 *   sourceBpm   The dance's own tempo. When set, the clip is sped up / slowed
 *               down so its beats land on the song's beats. 0 = natural speed.
 *   transition  How this clip hands over to the NEXT clip (beats = blend length).
 *   loopTransition  How each repeat hands over to the next repeat.
 */
export function createClip(choreo, overrides = {}) {
    return {
        id: newId(),
        choreo,
        name: choreo.name,
        in: 0,
        out: choreo.duration,
        loops: 1,
        sourceBpm: 0,
        transition: { style: 'crossfade', beats: 1 },
        loopTransition: { style: 'crossfade', beats: 0.5 },
        ...overrides,
    };
}

/**
 * A change of speed for a stretch of the song, measured in song beats from the
 * first downbeat. speed 0.5 = half time, 2 = double time, 0 = hold the pose.
 * rampBeats eases in and out of the new speed; ramps are centred on the
 * boundaries, so they never shift where later beats land.
 */
export function createSpeedChange(overrides = {}) {
    return { id: newId(), startBeat: 0, beats: 4, speed: 0.5, rampBeats: 0.5, ...overrides };
}

export const beatLength = (tempo) => 60 / tempo.bpm;

/** Playback rate of a clip: matches its own tempo to the song's when known. */
export function clipRate(clip, tempo) {
    return clip.sourceBpm > 0 ? tempo.bpm / clip.sourceBpm : 1;
}

/** The clip's in/out points, kept inside its dance and at least two frames apart. */
export function clipBounds(clip) {
    const dur = clip.choreo.duration;
    const minLen = 2 / clip.choreo.fps;
    const a = clamp(Number(clip.in) || 0, 0, dur - minLen);
    const b = clamp(Number.isFinite(Number(clip.out)) ? Number(clip.out) : dur, a + minLen, dur);
    return [a, b];
}

/** Write sanitised in/out/loops back into a clip (after the user edits it). */
export function normalizeClip(clip) {
    [clip.in, clip.out] = clipBounds(clip);
    clip.loops = Math.max(1, Math.round(Number(clip.loops) || 1));
    clip.sourceBpm = Math.max(0, Number(clip.sourceBpm) || 0);
    return clip;
}

/**
 * How many beats a speed change moves everything after it (positive = later).
 * Whole numbers keep later material on the beat.
 */
export function speedChangeShift(change) {
    return Math.max(0, change.beats) * (1 - Math.max(0, change.speed));
}

/** 0-based beat index → { bar, beat } (both 1-based), e.g. beat 5 in 4/4 → bar 2, beat 2. */
export function barBeat(beatIndex, beatsPerBar) {
    const bar = Math.floor(beatIndex / beatsPerBar + 1e-9);
    return { bar: bar + 1, beat: beatIndex - bar * beatsPerBar + 1 };
}

/** { bar, beat } (1-based) → 0-based beat index. */
export function beatIndex(bar, beat, beatsPerBar) {
    return (bar - 1) * beatsPerBar + (beat - 1);
}

// ── Layout: clips end to end in sequence time ───────────────────────

function layout(seq) {
    const beat = beatLength(seq.tempo);
    const instances = [];
    const seams = [];
    let t = 0;
    seq.clips.forEach((clip, ci) => {
        const [a, b] = clipBounds(clip);
        const rate = clipRate(clip, seq.tempo);
        const loops = Math.max(1, Math.round(clip.loops || 1));
        const len = (b - a) / rate;
        for (let r = 0; r < loops; r++) {
            if (instances.length) {
                seams.push(r === 0
                    ? { kind: 'clip', clipIndex: ci - 1, transition: seq.clips[ci - 1].transition, time: t }
                    : { kind: 'loop', clipIndex: ci, transition: clip.loopTransition, time: t });
            }
            instances.push({ clipIndex: ci, loop: r, name: clip.name, choreo: clip.choreo,
                srcIn: a, rate, start: t, end: t + len, yaw: 0, dx: 0, dz: 0 });
            t += len;
        }
    });
    seams.forEach((s, k) => {
        s.prev = instances[k];
        s.next = instances[k + 1];
        const style = TRANSITION_STYLES[s.transition?.style] ? s.transition.style : 'crossfade';
        const blend = style === 'cut' ? 0 : Math.max(0, Number(s.transition?.beats) || 0) * beat;
        // Each half of the blend must fit inside the clip on its side
        s.half = Math.min(blend, s.prev.end - s.prev.start, s.next.end - s.next.start) / 2;
        s.style = s.half > 1e-6 ? style : 'cut';
    });
    return { instances, seams, length: t };
}

function sampleInstance(inst, t, out) {
    // Past the out point (or before the in point) reads the dance's own handles,
    // which is what a centred crossfade blends with. samplePose clamps at the ends.
    samplePose(inst.choreo, inst.srcIn + (t - inst.start) * inst.rate, out);
    return transformPose(out, inst.yaw, inst.dx, inst.dz);
}

/**
 * Place every clip where the previous one left off (and, optionally, facing the
 * same way), so the dancer never teleports at a join.
 */
function align(L, seq) {
    const neutral = seq.neutralPose || standingPose();
    const a = createPose();
    const b = createPose();
    for (const s of L.seams) {
        sampleInstance(s.prev, s.time, a);
        sampleInstance(s.next, s.time, b); // the next clip is still untransformed here
        const yaw = seq.matchHeading ? wrapAngle(headingOf(a) - headingOf(b)) : 0;
        transformPose(b, yaw, 0, 0);
        s.next.yaw = yaw;
        s.next.dx = a.root[0] - b.root[0];
        s.next.dz = a.root[2] - b.root[2];
        if (s.style === 'neutral') {
            // The shared pose stands where the outgoing dance ends, facing its way
            s.neutral = transformPose(copyPose(neutral), headingOf(a), a.root[0], a.root[2]);
        }
    }
}

function findInstance(instances, t) {
    let lo = 0;
    let hi = instances.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (instances[mid].start <= t) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

function evaluateSeam(s, t, out, tmp) {
    const u = (t - (s.time - s.half)) / (2 * s.half); // 0 → 1 across the blend
    if (s.style === 'crossfade') {
        sampleInstance(s.prev, t, out);
        sampleInstance(s.next, t, tmp);
        return blendPoses(out, tmp, smoothstep(u), out);
    }
    // Via neutral: the first half eases into the neutral pose, the second out of it
    if (u < 0.5) {
        sampleInstance(s.prev, t, out);
        return blendPoses(out, s.neutral, smoothstep(u * 2), out);
    }
    sampleInstance(s.next, t, out);
    return blendPoses(s.neutral, out, smoothstep((u - 0.5) * 2), out);
}

/** Pose at a sequence time (seconds of clips laid end to end). */
function evaluate(L, t, out, tmp) {
    const i = findInstance(L.instances, t);
    const sIn = i > 0 ? L.seams[i - 1] : null;
    const sOut = i < L.seams.length ? L.seams[i] : null;
    if (sIn && sIn.half > 0 && t < sIn.time + sIn.half) return evaluateSeam(sIn, t, out, tmp);
    if (sOut && sOut.half > 0 && t > sOut.time - sOut.half) return evaluateSeam(sOut, t, out, tmp);
    return sampleInstance(L.instances[i], t, out);
}

// ── Time warp: song time → sequence time ────────────────────────────

/**
 * Integrates the speed curve defined by the speed changes. A tabulated integral
 * (rather than a closed form) keeps it robust when changes sit back to back.
 */
function buildWarp(seq, length, step) {
    const beat = beatLength(seq.tempo);
    const changes = (seq.speedChanges || []).map((c) => {
        const a = Math.max(0, Number(c.startBeat) || 0) * beat;
        const b = a + Math.max(0, Number(c.beats) || 0) * beat;
        const r = Math.min(Math.max(0, Number(c.rampBeats) || 0) * beat, b - a);
        return { id: c.id, a, b, r, speed: Math.max(0, Number(c.speed) || 0) };
    }).filter((c) => c.b > c.a);
    // Smooth 0 → 1 step centred on `at`, `r` wide (a hard step when r = 0).
    // Centred and antisymmetric, so it adds exactly what a hard step would:
    // the beat grid after a change is not shifted by the ramp.
    const rise = (t, at, r) => (r > 0 ? smoothstep((t - at + r / 2) / r) : (t >= at ? 1 : 0));
    const speedAt = (t) => {
        let v = 1;
        for (const c of changes) v += (c.speed - 1) * (rise(t, c.a, c.r) - rise(t, c.b, c.r));
        return Math.max(0, v);
    };

    const sigma = [0];
    const maxSteps = Math.ceil((length + changes.reduce((s, c) => s + (c.b - c.a), 0) + 1) / step) + 16;
    let s = 0;
    let v0 = speedAt(0);
    let duration = 0;
    for (let k = 1; s < length && k <= maxSteps; k++) {
        const v1 = speedAt(k * step);
        const inc = ((v0 + v1) / 2) * step;
        // The sequence ends part-way through this step
        duration = s + inc >= length ? (k - 1) * step + ((length - s) / inc) * step : k * step;
        s += inc;
        sigma.push(s);
        v0 = v1;
    }
    if (length <= 0) duration = 0;

    const sigmaAt = (tau) => {
        const x = tau / step;
        if (x <= 0) return 0;
        const i = Math.floor(x);
        if (i >= sigma.length - 1) return Math.min(length, sigma[sigma.length - 1]);
        return Math.min(length, sigma[i] + (sigma[i + 1] - sigma[i]) * (x - i));
    };
    // First song time at which the sequence reaches `target` (for timeline labels)
    const tauAt = (target) => {
        if (target <= 0) return 0;
        if (target >= length) return duration;
        let lo = 0;
        let hi = sigma.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (sigma[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        if (lo === 0) return 0;
        const d = sigma[lo] - sigma[lo - 1];
        return ((lo - 1) + (d > 0 ? (target - sigma[lo - 1]) / d : 0)) * step;
    };
    return { duration, sigmaAt, tauAt, speedAt, changes };
}

// ── Compile ─────────────────────────────────────────────────────────

/**
 * Flatten a sequence into one Choreography on the song's timeline.
 * Before the first downbeat (tempo.offset) the dancer holds the opening pose.
 *
 * Returns { choreo, timeline } — the timeline lists where each clip, transition
 * and speed change falls in song seconds, for drawing — or null when empty.
 */
export function compileSequence(seq, { fps } = {}) {
    if (!seq.clips.length) return null;
    const L = layout(seq);
    align(L, seq);

    const F = fps || Math.min(60, Math.max(...seq.clips.map((c) => c.choreo.fps)));
    const warp = buildWarp(seq, L.length, 1 / (F * 8));
    const offset = Math.max(0, Number(seq.tempo.offset) || 0);
    const total = offset + warp.duration;
    const N = Math.max(2, Math.round(total * F));

    const rotations = Object.fromEntries(JOINT_NAMES.map((n) => [n, new Float32Array(N * 4)]));
    const rootPositions = new Float32Array(N * 3);
    const withContacts = FOOT_KEYS.filter((k) => seq.clips.some((c) => c.choreo.contacts && c.choreo.contacts[k]));
    const contacts = Object.fromEntries(withContacts.map((k) => [k, new Uint8Array(N)]));

    const pose = createPose();
    const tmp = createPose();
    for (let f = 0; f < N; f++) {
        const tau = f / F - offset;
        evaluate(L, tau <= 0 ? 0 : warp.sigmaAt(tau), pose, tmp);
        for (let j = 0; j < JOINT_COUNT; j++) {
            rotations[JOINT_NAMES[j]].set(pose.rot.subarray(j * 4, j * 4 + 4), f * 4);
        }
        rootPositions.set(pose.root, f * 3);
        for (const k of withContacts) contacts[k][f] = pose.contacts[k] >= 0.5 ? 1 : 0;
    }

    const beat = beatLength(seq.tempo);
    const beats = [];
    for (let k = 0; offset + k * beat <= total + 1e-9; k++) beats.push(offset + k * beat);

    const choreo = new Choreography({
        name: seq.name,
        fps: F,
        frameCount: N,
        rotations,
        rootPositions,
        contacts,
        beats,
        source: { type: 'sequence', clips: seq.clips.map((c) => c.name) },
    });

    const song = (t) => offset + warp.tauAt(t);
    const timeline = {
        offset,
        duration: total,
        beat,
        beatsPerBar: seq.tempo.beatsPerBar,
        clips: L.instances.map((inst) => ({
            clipIndex: inst.clipIndex, loop: inst.loop, name: inst.name,
            start: song(inst.start), end: song(inst.end),
        })),
        transitions: L.seams.map((s) => ({
            kind: s.kind, clipIndex: s.clipIndex, style: s.style,
            time: song(s.time), start: song(s.time - s.half), end: song(s.time + s.half),
        })),
        speedChanges: warp.changes.map((c) => ({ id: c.id, speed: c.speed, start: offset + c.a, end: offset + c.b })),
    };
    return { choreo, timeline };
}

// ── Pose matching: pick cut points where the poses already agree ────

const MATCH_LOOKBACK = 0.15; // seconds; comparing a moment earlier too matches the motion, not just the pose

function bestCandidate(lo, hi, origin, step, score) {
    let best = origin;
    let bestScore = Infinity;
    const kLo = Math.ceil((lo - origin) / step - 1e-9);
    const kHi = Math.floor((hi - origin) / step + 1e-9);
    for (let k = kLo; k <= kHi; k++) {
        const t = origin + k * step;
        const s = score(t) + 0.05 * Math.abs(t - origin); // all else equal, stay near the current point
        if (s < bestScore) {
            bestScore = s;
            best = t;
        }
    }
    return best;
}

// With a known tempo, only consider half-beat steps so the clip stays on the beat
const matchStep = (clip) => (clip.sourceBpm > 0 ? 30 / clip.sourceBpm : 1 / clip.choreo.fps);

/**
 * A new in-point for clip `clipIndex + 1` whose opening pose (and motion)
 * best resembles how clip `clipIndex` ends. Searches near the current in-point.
 */
export function suggestInPoint(seq, clipIndex) {
    const a = seq.clips[clipIndex];
    const b = seq.clips[clipIndex + 1];
    if (!a || !b) return null;
    const [, aOut] = clipBounds(a);
    const [bIn, bOut] = clipBounds(b);
    const endA = samplePose(a.choreo, aOut);
    const beforeEndA = samplePose(a.choreo, aOut - MATCH_LOOKBACK);
    const p = createPose();
    const q = createPose();
    const minLen = Math.min(1, (bOut - bIn) / 2);
    return bestCandidate(Math.max(0, bIn - 1), Math.min(bOut - minLen, bIn + 2), bIn, matchStep(b), (t) =>
        poseDistance(endA, samplePose(b.choreo, t, p)) +
        0.5 * poseDistance(beforeEndA, samplePose(b.choreo, t - MATCH_LOOKBACK, q)));
}

/** A new out-point for a looped clip whose pose best flows back into its in-point. */
export function suggestLoopOutPoint(seq, clipIndex) {
    const c = seq.clips[clipIndex];
    if (!c) return null;
    const [cIn, cOut] = clipBounds(c);
    // Compare where the motion is heading just after the join: the moment
    // before the in-point may not exist (an in-point of 0), the one after does.
    const start = samplePose(c.choreo, cIn);
    const afterStart = samplePose(c.choreo, cIn + MATCH_LOOKBACK);
    const p = createPose();
    const q = createPose();
    const minLen = Math.min(1, (cOut - cIn) / 2);
    return bestCandidate(Math.max(cIn + minLen, cOut - 2), Math.min(c.choreo.duration, cOut + 1), cOut, matchStep(c), (t) =>
        poseDistance(start, samplePose(c.choreo, t, p)) +
        0.5 * poseDistance(afterStart, samplePose(c.choreo, t + MATCH_LOOKBACK, q)));
}

// ── Save / load ─────────────────────────────────────────────────────

const roundArr = (arr, digits = 5) => {
    const k = 10 ** digits;
    return Array.from(arr, (v) => Math.round(v * k) / k);
};

/** A self-contained sequence file: the clips' dances are embedded. */
export function sequenceToJSON(seq) {
    const choreographies = [];
    const index = new Map();
    const ref = (choreo) => {
        if (!index.has(choreo)) {
            index.set(choreo, choreographies.length);
            choreographies.push(choreo.toJSON());
        }
        return index.get(choreo);
    };
    return {
        format: SEQUENCE_FORMAT,
        version: SEQUENCE_VERSION,
        name: seq.name,
        tempo: { ...seq.tempo },
        matchHeading: !!seq.matchHeading,
        neutralPose: seq.neutralPose
            ? { rotations: roundArr(seq.neutralPose.rot), root: roundArr(seq.neutralPose.root), contacts: { ...seq.neutralPose.contacts } }
            : null,
        clips: seq.clips.map((c) => ({
            name: c.name,
            choreography: ref(c.choreo),
            in: c.in,
            out: c.out,
            loops: c.loops,
            sourceBpm: c.sourceBpm,
            transition: { ...c.transition },
            loopTransition: { ...c.loopTransition },
        })),
        speedChanges: seq.speedChanges.map(({ startBeat, beats, speed, rampBeats }) => ({ startBeat, beats, speed, rampBeats })),
        choreographies,
    };
}

export function isSequenceJSON(data) {
    return !!data && data.format === SEQUENCE_FORMAT;
}

export function sequenceFromJSON(data) {
    if (typeof data === 'string') data = JSON.parse(data);
    if (!isSequenceJSON(data)) throw new Error('Not an AutoChoreo sequence file');
    if (data.version > SEQUENCE_VERSION) {
        throw new Error(`Sequence file version ${data.version} is newer than this app supports`);
    }
    const choreos = (data.choreographies || []).map((c) => Choreography.fromJSON(c));
    const seq = createSequence({ name: data.name, tempo: data.tempo });
    seq.matchHeading = !!data.matchHeading;
    if (data.neutralPose) {
        const pose = createPose();
        pose.rot.set(data.neutralPose.rotations);
        pose.root.set(data.neutralPose.root);
        Object.assign(pose.contacts, data.neutralPose.contacts || {});
        seq.neutralPose = pose;
    }
    for (const c of data.clips || []) {
        const choreo = choreos[c.choreography];
        if (!choreo) throw new Error(`Sequence clip "${c.name}" refers to a missing dance`);
        seq.clips.push(normalizeClip(createClip(choreo, {
            name: c.name,
            in: c.in,
            out: c.out,
            loops: c.loops,
            sourceBpm: c.sourceBpm,
            transition: { ...createClip(choreo).transition, ...c.transition },
            loopTransition: { ...createClip(choreo).loopTransition, ...c.loopTransition },
        })));
    }
    for (const s of data.speedChanges || []) seq.speedChanges.push(createSpeedChange(s));
    return seq;
}
