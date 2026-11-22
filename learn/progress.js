// AutoChoreo — Practice progress and history
//
// Everything the app remembers about the dancer's practice, kept in the
// browser (localStorage): every scored attempt, per routine and per step the
// best and latest scores, where they left off, and how long they practised.
// Every number on the dashboard is computed from these records — nothing is
// shown that was not measured.
//
// Steps of a routine (keys):
//   'watch'                   watch the reference through
//   'section:<from>-<to>'     an eight of the routine (0-based beats, end exclusive)
//   'full'                    the whole routine
//   'loop' / 'drill'          a custom loop / a drill phrase (history only)

import { PRACTICE } from './adaptive.js';

export const PROGRESS_KEY = 'autochoreo.progress.v1';
const MAX_ATTEMPTS = 600;
const DAY = 24 * 3600 * 1000;

export const DEFAULT_SETTINGS = {
    mirror: true,        // follow the reference like a mirror
    autoRewind: false,   // rewind and drill automatically when the routine is lost
    adaptiveTempo: true, // speed up / slow down between passes
    metronome: 'auto',   // 'auto' (when the routine has no music) | 'on' | 'off'
    countIn: 4,          // beats counted in before each pass
    latencyMs: 0,        // extra delay to compensate (e.g. Bluetooth headphones)
    showSkeleton: true,
    trackingModel: 'full',
};

export function emptyProgress() {
    return { version: 1, routines: {}, attempts: [], daily: {}, favorites: [], settings: { ...DEFAULT_SETTINGS } };
}

export const sectionKey = (section) => `section:${section.startBeat}-${section.endBeat}`;

/** Local calendar day of a timestamp, e.g. "2026-11-22". */
export function dayKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function routineRecord(data, routineId) {
    if (!data.routines[routineId]) {
        data.routines[routineId] = { lastPracticedAt: 0, practiceSeconds: 0, steps: {}, resume: null };
    }
    return data.routines[routineId];
}

/**
 * Record a finished attempt.
 * @param {object} attempt { routineId, routineName, stepKey, stepLabel, tempo, input, at, summary }
 *   summary is an AttemptAccumulator.finish() result.
 * @returns {object} the stored attempt record, with `improved` (beat the previous best) and `mastered`.
 */
export function recordAttempt(data, { routineId, routineName, stepKey, stepLabel, tempo, input, at = Date.now(), summary }) {
    const r = routineRecord(data, routineId);
    r.lastPracticedAt = Math.max(r.lastPracticedAt, at);
    const step = r.steps[stepKey] || (r.steps[stepKey] = { attempts: 0, bestScore: null, bestEffective: 0, bestFullTempo: null, lastScore: null, lastAt: 0, mastered: false });
    const record = {
        id: `${at.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        routineId,
        routineName,
        stepKey,
        stepLabel,
        at,
        tempo,
        input,
        valid: !!summary.valid,
        score: summary.score,
        pose: summary.pose,
        timing: summary.timing,
        motion: summary.motion,
        lagBeats: summary.lagBeats == null ? null : Math.round(summary.lagBeats * 100) / 100,
        coverage: Math.round(summary.coverage * 100) / 100,
        start: summary.start,
        end: summary.end,
        perBeat: summary.perBeat.map((b) => [b.beat, b.score]),
        improved: false,
        mastered: false,
    };
    if (summary.valid && summary.score != null) {
        step.attempts++;
        record.improved = step.bestScore != null && summary.score > step.bestScore;
        step.bestScore = Math.max(step.bestScore ?? 0, summary.score);
        step.bestEffective = Math.max(step.bestEffective, summary.score * Math.min(1, tempo));
        if (tempo >= 1 - 1e-6) step.bestFullTempo = Math.max(step.bestFullTempo ?? 0, summary.score);
        step.lastScore = summary.score;
        step.lastAt = at;
        const wasMastered = step.mastered;
        step.mastered = (step.bestFullTempo ?? 0) >= PRACTICE.masteryScore;
        record.mastered = step.mastered && !wasMastered;
    }
    data.attempts.push(record);
    if (data.attempts.length > MAX_ATTEMPTS) data.attempts.splice(0, data.attempts.length - MAX_ATTEMPTS);
    return record;
}

/** Mark a step done without scoring (e.g. watching the routine through). */
export function completeStep(data, routineId, stepKey, at = Date.now()) {
    const r = routineRecord(data, routineId);
    const step = r.steps[stepKey] || (r.steps[stepKey] = { attempts: 0, bestScore: null, bestEffective: 0, bestFullTempo: null, lastScore: null, lastAt: 0, mastered: false });
    step.mastered = true;
    step.lastAt = at;
    r.lastPracticedAt = Math.max(r.lastPracticedAt, at);
}

export function addPracticeTime(data, routineId, seconds, at = Date.now()) {
    if (!(seconds > 0)) return;
    const r = routineRecord(data, routineId);
    r.practiceSeconds += seconds;
    r.lastPracticedAt = Math.max(r.lastPracticedAt, at);
    const day = dayKey(at);
    data.daily[day] = (data.daily[day] || 0) + seconds;
}

/** Where to pick up next time: { stepKey, tempo, position }. */
export function setResume(data, routineId, resume, at = Date.now()) {
    const r = routineRecord(data, routineId);
    r.resume = { ...resume, at };
}

export function getResume(data, routineId) {
    return data.routines[routineId]?.resume || null;
}

export function stepRecord(data, routineId, stepKey) {
    return data.routines[routineId]?.steps[stepKey] || null;
}

/** 0–1: how far along a step is. Mastered = 1; otherwise the best tempo-weighted score toward mastery. */
export function stepProgress(step) {
    if (!step) return 0;
    if (step.mastered) return 1;
    return Math.min(0.95, (step.bestEffective || 0) / PRACTICE.masteryScore);
}

/**
 * Mastery of a routine over its learnable steps (its sections and the full routine).
 * @returns {{ mastery: number, mastered: number, total: number, started: boolean }}
 */
export function routineMastery(data, routineId, stepKeys) {
    const r = data.routines[routineId];
    if (!stepKeys.length) return { mastery: 0, mastered: 0, total: 0, started: !!r };
    let sum = 0;
    let mastered = 0;
    for (const key of stepKeys) {
        const p = stepProgress(r?.steps[key]);
        sum += p;
        if (p >= 1) mastered++;
    }
    return { mastery: sum / stepKeys.length, mastered, total: stepKeys.length, started: !!r && r.lastPracticedAt > 0 };
}

/** Practice in the last 7 days: seconds, attempts, mean score. */
export function weeklyStats(data, now = Date.now()) {
    let practiceSeconds = 0;
    for (let d = 0; d < 7; d++) practiceSeconds += data.daily[dayKey(now - d * DAY)] || 0;
    const recent = data.attempts.filter((a) => a.valid && a.at >= now - 7 * DAY);
    const avgScore = recent.length ? recent.reduce((s, a) => s + a.score, 0) / recent.length : null;
    return { practiceSeconds, attempts: recent.length, avgScore };
}

/**
 * Scores grouped into practice sessions (attempts less than an hour apart).
 * @returns {Array<{ start, end, attempts, avgScore }>} oldest first
 */
export function practiceSessions(data, gapMs = 3600 * 1000) {
    const sessions = [];
    for (const a of data.attempts) {
        if (!a.valid) continue;
        const last = sessions[sessions.length - 1];
        if (last && a.at - last.end <= gapMs) {
            last.end = a.at;
            last.sum += a.score;
            last.attempts++;
        } else {
            sessions.push({ start: a.at, end: a.at, sum: a.score, attempts: 1 });
        }
    }
    return sessions.map((s) => ({ start: s.start, end: s.end, attempts: s.attempts, avgScore: s.sum / s.attempts }));
}

/** Latest session's mean score and its change from the session before. */
export function sessionTrend(data) {
    const sessions = practiceSessions(data);
    const last = sessions[sessions.length - 1] || null;
    const prev = sessions[sessions.length - 2] || null;
    return { last, previous: prev, delta: last && prev ? last.avgScore - prev.avgScore : null, sessions };
}

export function recentAttempts(data, n = 10, filter = () => true) {
    return data.attempts.filter((a) => a.valid && filter(a)).slice(-n).reverse();
}

/**
 * What to practise next. Continues the most recently practised routine: the
 * first section not yet learned, then the full routine; once that is learned,
 * the weakest section. With no history, suggests starting the first routine.
 *
 * @param {Array<{ id, name, steps: Array<{ key, label, kind }> }>} routines  Steps in lesson order.
 * @returns {{ routineId, stepKey, label, reason } | null}
 */
export function recommendNext(data, routines) {
    if (!routines.length) return null;
    const byRecent = routines
        .map((r) => ({ r, at: data.routines[r.id]?.lastPracticedAt || 0 }))
        .sort((a, b) => b.at - a.at);
    const current = byRecent[0].at > 0 ? byRecent[0].r : null;
    if (!current) {
        const first = routines[0];
        const step = first.steps.find((s) => s.kind === 'section') || first.steps[0];
        return { routineId: first.id, stepKey: step.key, label: step.label, reason: 'Start your first routine' };
    }
    const steps = current.steps.filter((s) => s.kind === 'section' || s.kind === 'full');
    const progress = (s) => stepProgress(stepRecord(data, current.id, s.key));
    const next = steps.find((s) => progress(s) < 1);
    if (next) {
        const p = progress(next);
        return {
            routineId: current.id,
            stepKey: next.key,
            label: next.label,
            reason: p > 0 ? `Keep going — ${Math.round(p * 100)}% of the way to learned` : (next.kind === 'full' ? 'Put the sections together' : 'Build on your progress'),
        };
    }
    // Everything learned: polish the weakest section, or move on to an untouched routine
    const fresh = routines.find((r) => !data.routines[r.id]);
    if (fresh) {
        const step = fresh.steps.find((s) => s.kind === 'section') || fresh.steps[0];
        return { routineId: fresh.id, stepKey: step.key, label: step.label, reason: `You learned ${current.name} — start something new` };
    }
    const weakest = steps
        .map((s) => ({ s, score: stepRecord(data, current.id, s.key)?.lastScore ?? 0 }))
        .sort((a, b) => a.score - b.score)[0];
    return { routineId: current.id, stepKey: weakest.s.key, label: weakest.s.label, reason: 'Polish your weakest section' };
}

// ── Persistence ─────────────────────────────────────────────────────

/** Load progress from storage (fresh progress if missing or unreadable). */
export function loadProgress(storage = globalThis.localStorage) {
    try {
        const raw = storage?.getItem(PROGRESS_KEY);
        if (!raw) return emptyProgress();
        const data = JSON.parse(raw);
        if (!data || data.version !== 1) return emptyProgress();
        return { ...emptyProgress(), ...data, settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) } };
    } catch (err) {
        console.warn('Could not read practice progress:', err);
        return emptyProgress();
    }
}

export function saveProgress(data, storage = globalThis.localStorage) {
    try {
        storage?.setItem(PROGRESS_KEY, JSON.stringify(data));
        return true;
    } catch (err) {
        console.warn('Could not save practice progress:', err);
        return false;
    }
}
