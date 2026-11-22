// AutoChoreo — Feedback: measurements → words a dancer can act on
//
// Everything here is derived from what the comparison engine actually measured
// (./choreo/scoring.js): which body part was off and in which direction, how
// early or late, which counts were weakest. No canned encouragement pretending
// to be analysis — if something could not be measured, we say so.
//
// Directions are in the dancer's own body frame: x towards their left, y up
// along the torso, z the way their chest faces. With mirrored practice the
// reference was mirrored before comparing, so "left" is always the dancer's left.

import { SEGMENTS, SEG } from '../choreo/compare.js';
import { countsLabel } from './adaptive.js';

const DIRECTION_MIN = 0.15; // ≈ 9°: smaller average differences are not worth a cue
const BEND_MIN_DEG = 15;

/** "½ beat", "¼ beat", "1 beat" … for a number of beats. */
export function beatFraction(beats) {
    const a = Math.abs(beats);
    if (a < 0.19) return 'a fraction of a beat';
    if (a < 0.3) return '¼ beat';
    if (a < 0.42) return '⅓ beat';
    if (a < 0.62) return '½ beat';
    if (a < 0.85) return '¾ beat';
    if (a < 1.25) return '1 beat';
    return `${Math.round(a * 2) / 2} beats`;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Advice for one body part from the average difference (reference − dancer)
 * of its direction, and for elbows/knees the bend difference in degrees
 * (positive: the reference is more bent).
 */
export function segmentAdvice(name, diff, bendDeg = null) {
    const seg = SEGMENTS[SEG[name]];
    if (!seg || !diff) return null;
    const side = seg.side;
    // Bends first: they are what dancers feel most directly
    if (seg.part === 'lower' && bendDeg != null && Math.abs(bendDeg) >= BEND_MIN_DEG) {
        if (seg.limb === 'arm') return bendDeg > 0 ? `Bend your ${side} elbow more` : `Straighten your ${side} arm more`;
        if (seg.limb === 'leg') return bendDeg > 0 ? `Bend your ${side} knee deeper` : `Straighten your ${side} leg`;
    }
    const [dx, dy, dz] = diff;
    if (seg.frame === 'yaw') { // torso lean
        if (Math.abs(dz) >= Math.abs(dx) && Math.abs(dz) >= DIRECTION_MIN) return dz > 0 ? 'Lean your chest further forward' : 'Stay more upright — less forward lean';
        if (Math.abs(dx) >= DIRECTION_MIN) return dx > 0 ? 'Lean more to your left' : 'Lean more to your right';
        return null;
    }
    if (seg.frame === 'heading') {
        if (Math.hypot(dx, dz) < DIRECTION_MIN * 1.5) return null;
        return dx > 0 ? 'Turn further to your left' : 'Turn further to your right';
    }
    if (name === 'shoulders') {
        if (Math.abs(dy) >= Math.abs(dz) && Math.abs(dy) >= DIRECTION_MIN) return dy > 0 ? 'Lift your left shoulder / drop your right' : 'Drop your left shoulder / lift your right';
        if (Math.abs(dz) >= DIRECTION_MIN) return dz > 0 ? 'Twist your chest more to the right' : 'Twist your chest more to the left';
        return null;
    }
    const outward = side === 'left' ? dx : -dx;
    const axes = [['y', dy], ['out', outward], ['z', dz]].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    const [axis, value] = axes[0];
    if (Math.abs(value) < DIRECTION_MIN) return null;
    const up = value > 0;
    if (seg.limb === 'arm') {
        const what = seg.part === 'upper' ? `${side} elbow` : `${side} hand`;
        if (axis === 'y') return up ? `Raise your ${what} higher` : `Lower your ${what}`;
        if (axis === 'out') return up ? `Take your ${side} arm wider, out to the side` : `Keep your ${side} arm closer to your body`;
        return up ? `Bring your ${what} further forward` : `Take your ${what} further back`;
    }
    if (seg.limb === 'leg') {
        if (seg.part === 'upper') {
            if (axis === 'y') return up ? `Lift your ${side} knee higher` : `Lower your ${side} knee`;
            if (axis === 'out') return up ? `Step your ${side} leg wider` : `Bring your ${side} leg in, under your hip`;
            return up ? `Bring your ${side} knee further forward` : `Take your ${side} leg further back`;
        }
        if (axis === 'y') return up ? `Lift your ${side} foot higher` : `Keep your ${side} foot lower`;
        if (axis === 'out') return up ? `Kick your ${side} foot further out` : `Keep your ${side} foot closer in`;
        return up ? `Bring your ${side} foot further forward` : `Take your ${side} foot further back`;
    }
    if (seg.limb === 'foot') {
        if (axis === 'y') return up ? `Flex your ${side} foot up more` : `Point your ${side} toes more`;
        return null;
    }
    return null;
}

/**
 * A short live cue from one scorer result.
 * @returns {{ tone: 'good'|'warn'|'bad'|'idle', text: string }}
 */
export function liveCue(result, { beat }) {
    if (!result) return { tone: 'idle', text: 'Waiting for movement…' };
    if (result.status === 'unseen') return { tone: 'warn', text: 'Step back so your whole body is in view' };
    if (result.status === 'in-sync') return { tone: 'good', text: 'In sync' };
    if (result.status === 'late') return { tone: 'warn', text: `About ${beatFraction(result.lag / beat)} late — move on the count` };
    if (result.status === 'early') return { tone: 'warn', text: `About ${beatFraction(result.lag / beat)} early — wait for the beat` };
    const worst = worstSegment(result.segments);
    if (worst >= 0) {
        const diff = [0, 1, 2].map((c) => result.ref[worst * 3 + c] - result.user[worst * 3 + c]);
        const advice = segmentAdvice(SEGMENTS[worst].name, diff);
        if (advice) return { tone: result.status === 'off' ? 'bad' : 'warn', text: advice };
    }
    return { tone: result.status === 'off' ? 'bad' : 'warn', text: result.status === 'off' ? 'Different move — watch the reference' : 'Close — sharpen the shapes' };
}

/** Index of the body part matching worst (weighted by importance), or −1. */
export function worstSegment(segments, minScore = 0.75) {
    if (!segments) return -1;
    let worst = -1;
    let worstValue = Infinity;
    for (let s = 0; s < SEGMENTS.length; s++) {
        const score = segments[s];
        if (!Number.isFinite(score) || score >= minScore || SEGMENTS[s].weight < 0.5) continue;
        const value = score - 0.1 * SEGMENTS[s].weight;
        if (value < worstValue) { worstValue = value; worst = s; }
    }
    return worst;
}

/** The weakest run of `width` consecutive counts in an attempt. */
export function weakestCounts(perBeat, width = 2) {
    if (!perBeat || perBeat.length < width) return null;
    let best = null;
    for (let i = 0; i + width <= perBeat.length; i++) {
        const run = perBeat.slice(i, i + width);
        if (run[width - 1].beat - run[0].beat !== width - 1) continue; // not consecutive
        const score = run.reduce((s, b) => s + b.score, 0) / width;
        if (!best || score < best.score) best = { startBeat: run[0].beat, endBeat: run[width - 1].beat + 1, score: Math.round(score) };
    }
    return best;
}

export function headlineFor(score) {
    if (score >= 85) return 'Excellent — you nailed it';
    if (score >= 75) return 'Great — that’s learned';
    if (score >= 62) return 'Getting there';
    if (score >= 48) return 'Keep drilling it';
    return 'Let’s slow it down and rebuild';
}

/**
 * What to tell the dancer after an attempt.
 * @param {object} summary  AttemptAccumulator.finish() result.
 * @param {object} o
 * @param {number} o.beat   Seconds per beat.
 * @returns {{ headline, tips: Array<{ kind, text, action? }>, strengths: string[] }}
 *   action: { type: 'drill', startBeat, endBeat } for tips that can be practised directly.
 */
export function attemptFeedback(summary, { beat }) {
    const tips = [];
    const strengths = [];
    if (!summary || !summary.valid) {
        const seen = summary ? Math.round(summary.coverage * 100) : 0;
        return {
            headline: 'Not enough to score',
            tips: [{ kind: 'tracking', text: `You were in view for ${seen}% of the attempt. Step back so your whole body, feet included, stays in the frame.` }],
            strengths,
        };
    }

    // Body: the weakest important part, with its direction
    const ranked = summary.segments
        .map((s, i) => ({ ...s, i, weight: SEGMENTS[i].weight }))
        .filter((s) => s.score != null && s.weight >= 0.5)
        .sort((a, b) => (a.score - 10 * a.weight) - (b.score - 10 * b.weight));
    for (const seg of ranked) {
        if (seg.score >= 75 || tips.filter((t) => t.kind === 'body').length >= 2) break;
        const advice = segmentAdvice(seg.name, seg.diff, seg.bendDeg);
        if (advice) tips.push({ kind: 'body', text: `${advice} (${SEGMENTS[seg.i].label}: ${seg.score}% match).` });
    }

    // Timing: a consistent lean early or late
    if (summary.timing != null && summary.lagBeats != null) {
        const consistent = summary.lagSpread == null || summary.lagSpread < Math.abs(summary.lag) * 1.2 + 0.05;
        if (Math.abs(summary.lagBeats) >= 0.15 && consistent) {
            tips.push({
                kind: 'timing',
                text: summary.lag > 0
                    ? `You’re about ${beatFraction(summary.lagBeats)} behind the music on average — hit each move on the count, not after it.`
                    : `You’re rushing by about ${beatFraction(summary.lagBeats)} — let the beat land before you move.`,
            });
        } else if (summary.timing >= 85) {
            strengths.push('Great timing');
        }
    }

    // Counts: where it fell apart
    const weak = weakestCounts(summary.perBeat, 2);
    if (weak && weak.score < Math.min(75, summary.score - 5)) {
        tips.push({
            kind: 'counts',
            text: `${cap(countsLabel(weak.startBeat, weak.endBeat))} were your weakest (${weak.score}%). Drill them slowly.`,
            action: { type: 'drill', startBeat: weak.startBeat, endBeat: weak.endBeat },
        });
    }

    // Dynamics: right shapes, flat movement between them
    if (summary.motion != null && summary.motion < 60 && summary.pose >= 70) {
        tips.push({ kind: 'motion', text: 'Your shapes are right — now match how you travel between them: sharper hits and fuller movements.' });
    }

    if (summary.pose >= 85) strengths.push('Clean shapes');
    if (summary.motion != null && summary.motion >= 85) strengths.push('Movement quality');
    if (!tips.length && summary.score < 75) tips.push({ kind: 'general', text: 'No single problem stands out — run it again a little slower to clean it up.' });
    return { headline: headlineFor(summary.score), tips: tips.slice(0, 3), strengths };
}
