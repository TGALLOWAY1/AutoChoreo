// AutoChoreo — Adaptive practice rules
//
// How practice reacts to the dancer: when to call out that they lost the
// routine, where to rewind to, when to slow down and when to speed back up.
// Pure functions and small state machines, so the rules can be tested and
// tuned on their own; the Practice Studio (practice.js) applies them.

import { beatSeconds, beatIndexAt, beatTime } from '../choreo/rhythm.js';

/** Tempo multipliers offered in practice (music keeps its pitch). */
export const TEMPO_STEPS = [0.5, 0.75, 0.85, 1, 1.15, 1.25];

export const PRACTICE = {
    // Scores are calibrated so a flawless performance tracked by a webcam lands
    // in the mid 80s (the pose model's own error caps it), a different routine
    // around 50 and standing still in the 40s.
    masteryScore: 75,    // a section is learned once it scores this at full tempo
    speedUpScore: 75,    // a slowed-down pass this good earns the next tempo up
    slowDownScore: 50,   // a pass this weak drops the tempo a step
    lostAfter: 1.5,      // seconds (of song time) out of sync before calling it lost
    recoverAfter: 1.0,   // seconds back in sync before another loss can be called
    drillCounts: 4,      // a drill loop is this many counts
};

export function nearestTempoIndex(tempo) {
    let best = 0;
    for (let i = 1; i < TEMPO_STEPS.length; i++) {
        if (Math.abs(TEMPO_STEPS[i] - tempo) < Math.abs(TEMPO_STEPS[best] - tempo)) best = i;
    }
    return best;
}

/** One tempo step slower (dir −1) or faster (+1), within [min, max]. */
export function stepTempo(tempo, dir, { min = TEMPO_STEPS[0], max = TEMPO_STEPS[TEMPO_STEPS.length - 1] } = {}) {
    const i = nearestTempoIndex(tempo);
    const next = TEMPO_STEPS[Math.max(0, Math.min(TEMPO_STEPS.length - 1, i + dir))];
    return Math.max(min, Math.min(max, next));
}

/**
 * The tempo for the next pass after an attempt.
 * Up a step after a strong pass (never past `target`, normally full speed),
 * down a step after a weak one.
 * @returns {{ tempo: number, change: 'up'|'down'|null }}
 */
export function tempoAfterAttempt(tempo, summary, { target = 1 } = {}) {
    if (!summary || !summary.valid || summary.score == null) return { tempo, change: null };
    if (summary.score >= PRACTICE.speedUpScore && tempo < target - 1e-6) {
        return { tempo: Math.min(target, stepTempo(tempo, +1)), change: 'up' };
    }
    if (summary.score < PRACTICE.slowDownScore && tempo > TEMPO_STEPS[0] + 1e-6) {
        return { tempo: stepTempo(tempo, -1), change: 'down' };
    }
    return { tempo, change: null };
}

/**
 * Watches live scores and says when the dancer has lost the routine: out of
 * sync (off, early or late) for `lostAfter` seconds in a row. Calls it once,
 * then waits until they have been back in sync for a while.
 */
export class SyncLossDetector {
    constructor(options = {}) {
        this.opt = { ...PRACTICE, ...options };
        this.reset();
    }

    reset() {
        this.badSince = null;
        this.goodSince = null;
        this.armed = true;
        this.lastTime = null;
        this.bad = { off: 0, early: 0, late: 0, lag: 0, lagN: 0 };
    }

    /**
     * @param {object|null} result  A SyncScorer result.
     * @returns {object|null} { time, start, kind: 'timing'|'movement', lag } when the routine is lost.
     */
    update(result) {
        if (!result) return null;
        const t = result.time;
        if (this.lastTime != null && (t < this.lastTime - 0.25 || t > this.lastTime + 1)) this.reset(); // seek / loop
        this.lastTime = t;
        if (result.status === 'unseen') { this.badSince = null; return null; }
        const isBad = result.status === 'off' || result.status === 'early' || result.status === 'late';
        if (!isBad) {
            this.badSince = null;
            this.bad = { off: 0, early: 0, late: 0, lag: 0, lagN: 0 };
            if (result.status === 'in-sync' || result.status === 'close') {
                if (this.goodSince == null) this.goodSince = t;
                if (t - this.goodSince >= this.opt.recoverAfter) this.armed = true;
            }
            return null;
        }
        this.goodSince = null;
        if (this.badSince == null) this.badSince = t;
        this.bad[result.status]++;
        if (result.status !== 'off') { this.bad.lag += result.lag; this.bad.lagN++; }
        if (this.armed && t - this.badSince >= this.opt.lostAfter) {
            this.armed = false;
            const timing = this.bad.early + this.bad.late > this.bad.off;
            return {
                time: t,
                start: this.badSince,
                kind: timing ? 'timing' : 'movement',
                lag: this.bad.lagN ? this.bad.lag / this.bad.lagN : 0,
            };
        }
        return null;
    }
}

/**
 * The short phrase to drill after losing the routine at `time`: the block of
 * `counts` beats where it went wrong (if it went wrong on the first beat of a
 * block, the previous block too — the mistake usually started just before).
 * Stays inside `bounds` (the section or loop being practised).
 */
export function drillRange(time, rhythm, bounds, counts = PRACTICE.drillCounts) {
    const beat = beatSeconds(rhythm);
    const b = beatIndexAt(time, rhythm);
    let startBeat = Math.floor(b / counts) * counts;
    if (b - startBeat < 1) startBeat -= counts;
    let endBeat = startBeat + counts;
    let start = beatTime(startBeat, rhythm);
    let end = beatTime(endBeat, rhythm);
    if (start < bounds.start - 1e-6) {
        start = bounds.start;
        startBeat = beatIndexAt(start + 1e-6, rhythm);
        end = Math.max(end, start + counts * beat);
    }
    if (end > bounds.end + 1e-6) end = bounds.end;
    if (end - start < 2 * beat) { // too short to be a phrase: take the bounds' last block
        end = bounds.end;
        start = Math.max(bounds.start, end - counts * beat);
        startBeat = beatIndexAt(start + 1e-6, rhythm);
    }
    endBeat = Math.round((end - rhythm.offset) / beat);
    return { start, end, startBeat, endBeat };
}

/** "counts 9–12" for a range on the beat grid. */
export function countsLabel(startBeat, endBeat) {
    return endBeat - startBeat <= 1 ? `count ${startBeat + 1}` : `counts ${startBeat + 1}–${endBeat}`;
}

/** Has a drill phrase been cleared at the tempo the dancer was practising before it? */
export function drillCleared(summary, tempo, returnTempo) {
    return !!summary && summary.valid && summary.score >= PRACTICE.masteryScore && tempo >= returnTempo - 1e-6;
}
