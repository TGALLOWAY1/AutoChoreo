// AutoChoreo — Synchronisation scoring over time
//
// Feeds a stream of a person's pose features (live from a camera, or from a
// recording) against a reference track (./compare.js) on the shared musical
// timeline, and keeps answering: how close is the movement, and is it on time?
//
// The key question is telling a WRONG movement from a RIGHT movement at the
// WRONG time. A single frame cannot do that, so the scorer compares the last
// moment of movement (a window of samples) with the reference slid earlier and
// later by up to `maxLag` seconds:
//
//     S(ℓ) = how well the person's window at song time t matches the reference at t − ℓ
//
//   - pose   = max S(ℓ)       the shape of the movement, wherever it lines up best
//   - lag    = argmax S(ℓ)    positive: the person is late (showing an earlier
//                             moment of the dance); negative: early
//   - inTime = S(0)           what an on-the-beat comparison alone would give
//
// Good pose with a large lag means "right move, wrong time". Low pose at every
// lag means the movement itself is off. A small penalty on |τ| keeps the lag at
// zero when the reference is holding still and every shift matches equally.

import {
    SEGMENTS, SEG_COUNT, FEATURE_SIZE, SEGMENT_WEIGHTS, angleScore, unitAngle, sampleTrackFeatures, trackWeightsAt,
} from './compare.js';

export const SCORING = {
    window: 0.8,            // seconds of movement compared at once
    maxLag: 0.5,            // furthest early/late shift searched (seconds of song time)
    lagStep: 1 / 30,
    lagPenalty: 0.1,        // radians of mean error a shift must save per second, so ties resolve to "on time"
    minSamples: 4,
    minVisibility: 0.45,    // weighted share of the body that must be visible to score
    timingFull: 0.07,       // |lag| up to this is on time (seconds)
    timingZero: 0.4,        // |lag| from this is fully off time
    minContrastDeg: 4,      // the match must depend on the shift by this much (degrees) to judge timing
    motionDelta: 0.25,      // seconds over which movement is compared
    motionFloor: 0.12,      // radians: turns this small are pose-estimation jitter
    minActivity: 0.05,      // mean reference turn (radians per motionDelta) below which movement isn't judged
    weights: { pose: 0.5, timing: 0.3, motion: 0.2 },
    inSync: 0.72,
    offPose: 0.55,
    minPoseForTiming: 0.6,  // timing is only judged while the movement is roughly right …
    noTimingPose: 0.45,     // … and earns no credit at all below this pose match
    offTimeLag: 0.12,       // early / late is flagged from this shift (seconds) ...
    minShiftGainDeg: 2,     // ... when shifting really fits better than the beat (degrees)
};

const smoothRamp = (u) => {
    const t = Math.max(0, Math.min(1, u));
    return t * t * (3 - 2 * t);
};

export function timingScore(lag, opt = SCORING) {
    const a = Math.abs(lag);
    if (a <= opt.timingFull) return 1;
    if (a >= opt.timingZero) return 0;
    return 1 - (a - opt.timingFull) / (opt.timingZero - opt.timingFull);
}

/** Overall score from its parts (timing / motion may be null when they cannot be judged). */
export function combineScores(pose, timing, motion, opt = SCORING) {
    const w = opt.weights;
    let sum = w.pose * pose;
    let wSum = w.pose;
    if (timing != null) {
        // You cannot be "on time" doing the wrong move
        sum += w.timing * Math.min(timing, pose);
        wSum += w.timing;
    }
    if (motion != null) {
        sum += w.motion * motion;
        wSum += w.motion;
    }
    return sum / wSum;
}

export class SyncScorer {
    /**
     * @param {object} track  Reference track (./compare.js).
     * @param {object} [options]  Overrides for SCORING.
     */
    constructor(track, options = {}) {
        this.opt = { ...SCORING, ...options };
        this.track = track;
        this.samples = [];
        this._ref = new Float32Array(FEATURE_SIZE);
        this._ref2 = new Float32Array(FEATURE_SIZE);
        const lags = Math.round(this.opt.maxLag / this.opt.lagStep);
        this._lagCount = lags * 2 + 1;
        this._lagZero = lags;
        this._S = new Float32Array(this._lagCount);
        this._segSum = new Float32Array(SEG_COUNT);
        this._segW = new Float32Array(SEG_COUNT);
    }

    setTrack(track) {
        this.track = track;
        this.reset();
    }

    reset() {
        this.samples = [];
    }

    /**
     * Add one observation of the person.
     * @param {number} time        Song time (seconds) the observation belongs to.
     * @param {Float32Array} features
     * @param {Float32Array} visibility  Per segment, 0–1.
     */
    push(time, features, visibility) {
        const last = this.samples[this.samples.length - 1];
        if (last && time <= last.t) {
            if (time < last.t - 0.25) this.samples = []; // jumped back (seek / loop): start over
            else return; // duplicate or slightly out of order
        }
        this.samples.push({ t: time, f: Float32Array.from(features), v: Float32Array.from(visibility) });
        const keep = time - (this.opt.window + this.opt.motionDelta + 0.25);
        let drop = 0;
        while (drop < this.samples.length && this.samples[drop].t < keep) drop++;
        if (drop) this.samples.splice(0, drop);
    }

    /**
     * Compare the samples [from, to) with the reference `lag` seconds earlier.
     * Returns the weighted 0–1 match; the weighted mean angle error (radians)
     * is left in this._angle.
     */
    _poseAt(from, to, lag, perSegment) {
        let sum = 0;
        let angleSum = 0;
        let wSum = 0;
        if (perSegment) { this._segSum.fill(0); this._segW.fill(0); }
        for (let i = from; i < to; i++) {
            const smp = this.samples[i];
            const t = smp.t - lag;
            sampleTrackFeatures(this.track, t, this._ref);
            const tw = trackWeightsAt(this.track, t);
            for (let s = 0; s < SEG_COUNT; s++) {
                const w = tw[s] * smp.v[s];
                if (w <= 0) continue;
                const angle = unitAngle(smp.f, s * 3, this._ref, s * 3);
                const score = angleScore(angle);
                sum += w * score;
                angleSum += w * angle;
                wSum += w;
                if (perSegment) { this._segSum[s] += smp.v[s] * score; this._segW[s] += smp.v[s]; }
            }
        }
        this._angle = wSum > 0 ? angleSum / wSum : Math.PI;
        return wSum > 0 ? sum / wSum : 0;
    }

    /**
     * Movement quality: does each body part move as much as the reference's,
     * at the same moments — the hits, holds and sweeps — at the given lag?
     * Compares how far each part turns over `motionDelta` seconds (a speed),
     * not which way: direction is already judged by the pose, and speeds are
     * far less affected by the pose model's depth errors.
     */
    _motionAt(from, to, lag) {
        const o = this.opt;
        let sum = 0;
        let wSum = 0;
        let activity = 0;
        let pairs = 0;
        let j = from;
        for (let i = from; i < to; i++) {
            const a = this.samples[i];
            const target = a.t - o.motionDelta;
            while (j + 1 < i && this.samples[j + 1].t <= target) j++;
            const b = this.samples[j];
            if (j >= i || Math.abs(b.t - target) > o.motionDelta * 0.35) continue;
            sampleTrackFeatures(this.track, a.t - lag, this._ref);
            sampleTrackFeatures(this.track, b.t - lag, this._ref2);
            const tw = trackWeightsAt(this.track, a.t - lag);
            let act = 0;
            let actW = 0;
            for (let s = 0; s < SEG_COUNT; s++) {
                const vis = Math.min(a.v[s], b.v[s]);
                if (vis <= 0) continue;
                const su = unitAngle(a.f, s * 3, b.f, s * 3);
                const sr = unitAngle(this._ref, s * 3, this._ref2, s * 3);
                const amount = su + sr + o.motionFloor;
                // Weighted by how much the reference moves: matching stillness is easy
                const w = tw[s] * vis * (sr + 0.25 * o.motionFloor);
                sum += w * (1 - Math.abs(su - sr) / amount);
                wSum += w;
                act += SEGMENT_WEIGHTS[s] * sr;
                actW += SEGMENT_WEIGHTS[s];
            }
            if (actW > 0) { activity += act / actW; pairs++; }
        }
        if (!pairs || wSum <= 0) return { motion: null, activity: 0 };
        activity /= pairs;
        return { motion: activity >= o.minActivity ? Math.max(0, sum / wSum) : null, activity };
    }

    /**
     * Score the most recent window of movement.
     * @returns {object|null} null until enough samples have arrived. Otherwise:
     *   { time, status, visible, pose, inTime, lag, timing, motion, overall,
     *     segments: Float32Array (per-segment 0–1 match at the best lag),
     *     user: Float32Array, ref: Float32Array (latest features and the reference they were matched with) }
     *   status: 'unseen' | 'in-sync' | 'early' | 'late' | 'off' | 'close'
     */
    evaluate() {
        const o = this.opt;
        const n = this.samples.length;
        if (n < o.minSamples) return null;
        const last = this.samples[n - 1];
        let from = n - 1;
        while (from > 0 && this.samples[from - 1].t >= last.t - o.window) from--;
        if (n - from < o.minSamples) return null;

        // How much of the body is in view
        let vis = 0;
        let visW = 0;
        for (let i = from; i < n; i++) {
            for (let s = 0; s < SEG_COUNT; s++) { vis += SEGMENT_WEIGHTS[s] * this.samples[i].v[s]; visW += SEGMENT_WEIGHTS[s]; }
        }
        const visible = visW > 0 ? vis / visW : 0;
        if (visible < o.minVisibility) {
            return { time: last.t, status: 'unseen', visible, pose: null, inTime: null, lag: null, timing: null, motion: null, overall: null, segments: null };
        }

        // Slide the reference earlier and later
        const S = this._S;
        const A = this._A || (this._A = new Float32Array(this._lagCount));
        let best = this._lagZero;
        let bestValue = Infinity;
        let maxAngle = -Infinity;
        for (let k = 0; k < this._lagCount; k++) {
            const lag = (k - this._lagZero) * o.lagStep;
            S[k] = this._poseAt(from, n, lag, false);
            A[k] = this._angle;
            const value = A[k] + o.lagPenalty * Math.abs(lag);
            if (value < bestValue) { bestValue = value; best = k; }
            if (A[k] > maxAngle) maxAngle = A[k];
        }
        let lag = (best - this._lagZero) * o.lagStep;
        // Sub-step refinement (parabola through the minimum and its neighbours)
        if (best > 0 && best < this._lagCount - 1) {
            const a = A[best - 1];
            const b = A[best];
            const c = A[best + 1];
            const den = a - 2 * b + c;
            if (den > 0) lag += Math.max(-0.5, Math.min(0.5, (a - c) / (2 * den))) * o.lagStep;
        }
        const pose = S[best];
        const inTime = S[this._lagZero];
        const contrast = (maxAngle - A[best]) * 180 / Math.PI;
        // How much closer the best shift gets than staying on the beat (degrees)
        const shiftGain = (A[this._lagZero] - A[best]) * 180 / Math.PI;
        // Timing is not applicable while the reference holds still (every shift
        // matches), and cannot be judged while the movement itself is off.
        const timingApplies = contrast >= o.minContrastDeg;
        const timingKnown = timingApplies && pose >= o.minPoseForTiming;
        // Timing credit fades out as the movement goes wrong (none below noTimingPose)
        const credit = timingApplies ? smoothRamp((pose - o.noTimingPose) / (o.minPoseForTiming - o.noTimingPose)) : 0;
        const timingCredit = timingApplies ? credit * timingScore(lag, o) : null;
        if (!timingKnown) lag = 0;
        const timing = timingKnown ? timingScore(lag, o) : null;

        const bestLag = (best - this._lagZero) * o.lagStep;
        this._poseAt(from, n, timingKnown ? bestLag : 0, true);
        const segments = new Float32Array(SEG_COUNT);
        for (let s = 0; s < SEG_COUNT; s++) segments[s] = this._segW[s] > 0 ? this._segSum[s] / this._segW[s] : NaN;

        const { motion, activity } = this._motionAt(from, n, timingKnown ? bestLag : 0);
        const overall = combineScores(pose, timingCredit, motion, o);

        let status = 'close';
        if (pose < o.offPose) status = 'off';
        else if (timingKnown && Math.abs(lag) >= o.offTimeLag && shiftGain >= o.minShiftGainDeg) status = lag > 0 ? 'late' : 'early';
        else if (inTime >= o.inSync) status = 'in-sync';

        const ref = sampleTrackFeatures(this.track, last.t - (timingKnown ? bestLag : 0), new Float32Array(FEATURE_SIZE));
        return {
            time: last.t, status, visible, pose, inTime, lag: timingKnown ? lag : 0, timingKnown, shiftGain, timing, motion, activity, overall,
            segments, user: last.f, userVisibility: last.v, ref,
        };
    }
}

// ── One attempt at a stretch of choreography ────────────────────────

/**
 * Collects scorer results over one pass through a section (or loop) into a
 * summary: overall averages, how early/late on average, a score per count,
 * and how each body part compared — the raw material for feedback.
 */
export class AttemptAccumulator {
    /**
     * @param {object} o
     * @param {number} o.start, o.end   Song-time range of the attempt.
     * @param {number} o.beat           Seconds per beat.
     * @param {number} o.offset         Song time of count 1.
     */
    constructor({ start, end, beat, offset }) {
        this.start = start;
        this.end = end;
        this.beat = beat;
        this.offset = offset;
        this.lastTime = null;
        this.seen = 0;
        this.unseen = 0;
        this.sums = { overall: 0, pose: 0, inTime: 0, w: 0, timing: 0, timingW: 0, motion: 0, motionW: 0, lag: 0, lag2: 0, lagW: 0 };
        this.beats = new Map(); // beat index → { sum, w, lag, lagW }
        this.seg = SEGMENTS.map(() => ({ score: 0, w: 0, diff: [0, 0, 0], bend: 0, bendW: 0 }));
        this.status = { 'in-sync': 0, early: 0, late: 0, off: 0, close: 0 };
    }

    add(result) {
        if (!result) return;
        const t = result.time;
        if (t < this.start - 1e-6 || t > this.end + 1e-6) return;
        const dt = this.lastTime == null ? 1 / 30 : Math.max(0, Math.min(0.2, t - this.lastTime));
        this.lastTime = t;
        if (dt <= 0) return;
        if (result.status === 'unseen') { this.unseen += dt; return; }
        this.seen += dt;
        const s = this.sums;
        s.overall += dt * result.overall;
        s.pose += dt * result.pose;
        s.inTime += dt * result.inTime;
        s.w += dt;
        if (result.timing != null) {
            s.timing += dt * result.timing;
            s.timingW += dt;
            s.lag += dt * result.lag;
            s.lag2 += dt * result.lag * result.lag;
            s.lagW += dt;
        }
        if (result.motion != null) { s.motion += dt * result.motion; s.motionW += dt; }
        this.status[result.status] = (this.status[result.status] || 0) + dt;

        const b = Math.floor((t - this.offset) / this.beat + 1e-6);
        if (!this.beats.has(b)) this.beats.set(b, { sum: 0, w: 0, lag: 0, lagW: 0 });
        const bucket = this.beats.get(b);
        bucket.sum += dt * result.overall;
        bucket.w += dt;
        if (result.timing != null) { bucket.lag += dt * result.lag; bucket.lagW += dt; }

        // Body parts: how well each matched, and which way it was off
        for (let k = 0; k < SEG_COUNT; k++) {
            const v = result.userVisibility ? result.userVisibility[k] : 1;
            if (!(v > 0.3) || !Number.isFinite(result.segments[k])) continue;
            const acc = this.seg[k];
            acc.score += dt * result.segments[k];
            acc.w += dt;
            for (let c = 0; c < 3; c++) acc.diff[c] += dt * (result.ref[k * 3 + c] - result.user[k * 3 + c]);
        }
        // Hinges: elbows and knees, bent more (+) or less (−) than the reference
        for (const [upper, lower] of HINGES) {
            const acc = this.seg[lower];
            const v = result.userVisibility ? Math.min(result.userVisibility[upper], result.userVisibility[lower]) : 1;
            if (!(v > 0.3)) continue;
            const refBend = unitAngle(result.ref, upper * 3, result.ref, lower * 3);
            const userBend = unitAngle(result.user, upper * 3, result.user, lower * 3);
            acc.bend += dt * (refBend - userBend);
            acc.bendW += dt;
        }
    }

    /** Running averages so far (0–100, null when nothing scored yet), for live display. */
    snapshot() {
        const s = this.sums;
        const avg = (sum, w) => (w > 0 ? Math.round((sum / w) * 100) : null);
        return {
            score: avg(s.overall, s.w),
            pose: avg(s.pose, s.w),
            timing: avg(s.timing, s.timingW),
            motion: avg(s.motion, s.motionW),
            lag: s.lagW > 0 ? s.lag / s.lagW : null,
            seen: this.seen,
        };
    }

    /**
     * @returns {object} { duration, coverage, valid, score, pose, inTime, timing, motion,
     *   lag, lagSpread, lagBeats, perBeat: [{ beat, count, score, lag }],
     *   segments: [{ name, score, diff: [x,y,z], bendDeg }], status }
     *   Scores are 0–100 (rounded); lag in seconds of song time (+ late, − early).
     */
    finish() {
        const s = this.sums;
        const duration = this.end - this.start;
        const coverage = duration > 0 ? Math.min(1, this.seen / duration) : 0;
        const pct = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100));
        const avg = (sum, w) => (w > 0 ? sum / w : null);
        const lag = avg(s.lag, s.lagW);
        const perBeat = [...this.beats.entries()]
            .filter(([, v]) => v.w > 0.05)
            .sort((a, b) => a[0] - b[0])
            .map(([beat, v]) => ({ beat, count: beat + 1, score: pct(v.sum / v.w), lag: v.lagW > 0 ? v.lag / v.lagW : null }));
        const segments = SEGMENTS.map((seg, k) => {
            const a = this.seg[k];
            return {
                name: seg.name,
                score: pct(avg(a.score, a.w)),
                diff: a.w > 0 ? a.diff.map((d) => d / a.w) : null,
                bendDeg: a.bendW > 0 ? (a.bend / a.bendW) * 180 / Math.PI : null,
            };
        });
        return {
            start: this.start,
            end: this.end,
            duration,
            coverage,
            valid: coverage >= 0.5,
            score: pct(avg(s.overall, s.w)),
            pose: pct(avg(s.pose, s.w)),
            inTime: pct(avg(s.inTime, s.w)),
            timing: pct(avg(s.timing, s.timingW)),
            motion: pct(avg(s.motion, s.motionW)),
            lag,
            lagSpread: s.lagW > 0 ? Math.sqrt(Math.max(0, s.lag2 / s.lagW - lag * lag)) : null,
            lagBeats: lag == null ? null : lag / this.beat,
            perBeat,
            segments,
            status: Object.fromEntries(Object.entries(this.status).map(([k, v]) => [k, this.seen > 0 ? v / this.seen : 0])),
        };
    }
}

const SEG_INDEX = Object.fromEntries(SEGMENTS.map((s, i) => [s.name, i]));
/** [upper, lower] segment pairs meeting at a hinge (elbow / knee). */
export const HINGES = [
    [SEG_INDEX.leftUpperArm, SEG_INDEX.leftForearm],
    [SEG_INDEX.rightUpperArm, SEG_INDEX.rightForearm],
    [SEG_INDEX.leftThigh, SEG_INDEX.leftShin],
    [SEG_INDEX.rightThigh, SEG_INDEX.rightShin],
];
