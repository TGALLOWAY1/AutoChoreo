// Adaptive practice rules, feedback wording, progress records.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEG_COUNT, SEGMENTS } from '../choreo/compare.js';
import {
    stepTempo, tempoAfterAttempt, SyncLossDetector, drillRange, countsLabel, drillCleared,
} from '../learn/adaptive.js';
import { segmentAdvice, liveCue, attemptFeedback, beatFraction, weakestCounts } from '../learn/feedback.js';
import {
    emptyProgress, recordAttempt, routineMastery, recommendNext, weeklyStats, sessionTrend,
    addPracticeTime, setResume, getResume, loadProgress, saveProgress, sectionKey, completeStep,
} from '../learn/progress.js';

const summaryOf = (score, extra = {}) => ({
    valid: true, coverage: 0.95, score, pose: score, timing: score, motion: score, inTime: score,
    lag: 0, lagBeats: 0, lagSpread: 0.02, start: 0, end: 4,
    perBeat: [], segments: SEGMENTS.map((s) => ({ name: s.name, score: 95, diff: [0, 0, 0], bendDeg: 0 })),
    ...extra,
});

test('tempo ladder: up after a strong pass (capped at full speed), down after a weak one', () => {
    assert.equal(stepTempo(0.75, +1), 0.85);
    assert.equal(stepTempo(0.5, -1), 0.5);
    assert.deepEqual(tempoAfterAttempt(0.75, summaryOf(86)), { tempo: 0.85, change: 'up' });
    assert.deepEqual(tempoAfterAttempt(1, summaryOf(95)), { tempo: 1, change: null });
    assert.deepEqual(tempoAfterAttempt(1, summaryOf(40)), { tempo: 0.85, change: 'down' });
    assert.deepEqual(tempoAfterAttempt(0.85, { ...summaryOf(95), valid: false }), { tempo: 0.85, change: null });
});

const r = (time, status, lag = 0) => ({ time, status, lag });

test('losing the routine is called once after it lasts, then re-armed after recovering', () => {
    const d = new SyncLossDetector();
    let event = null;
    for (let t = 0; t < 1; t += 0.1) assert.equal(d.update(r(t, 'in-sync')), null);
    for (let t = 1; t < 3; t += 0.1) event = d.update(r(t, 'late', 0.3)) || event;
    assert.ok(event, 'loss called');
    assert.equal(event.kind, 'timing');
    assert.ok(Math.abs(event.lag - 0.3) < 1e-9);
    assert.ok(event.time >= 2.5 && event.time < 2.7);
    // Still lost: no repeat
    for (let t = 3; t < 5; t += 0.1) assert.equal(d.update(r(t, 'off')), null);
    // Back in sync long enough, then lost again (movement this time)
    for (let t = 5; t < 6.5; t += 0.1) d.update(r(t, 'in-sync'));
    let second = null;
    for (let t = 6.5; t < 8.5; t += 0.1) second = d.update(r(t, 'off')) || second;
    assert.equal(second?.kind, 'movement');
});

test('drill range: the 4-count phrase where it went wrong, inside the section', () => {
    const rhythm = { bpm: 120, offset: 0 }; // 0.5 s per beat
    const bounds = { start: 4, end: 8 };    // counts 9–16
    assert.deepEqual(drillRange(6.8, rhythm, bounds), { start: 6, end: 8, startBeat: 12, endBeat: 16 });
    // Lost on the first beat of a block: start a block earlier
    assert.deepEqual(drillRange(6.2, rhythm, bounds), { start: 4, end: 6, startBeat: 8, endBeat: 12 });
    // Never before the section
    assert.equal(drillRange(4.1, rhythm, bounds).start, 4);
    assert.equal(countsLabel(12, 16), 'counts 13–16');
    assert.ok(drillCleared(summaryOf(85), 1, 1));
    assert.ok(!drillCleared(summaryOf(85), 0.75, 1));
});

test('advice names the body part and the direction to fix', () => {
    assert.equal(segmentAdvice('leftUpperArm', [0, 0.4, 0]), 'Raise your left elbow higher');
    assert.equal(segmentAdvice('rightForearm', [0, -0.3, 0.1]), 'Lower your right hand');
    assert.equal(segmentAdvice('rightUpperArm', [-0.4, 0, 0]), 'Take your right arm wider, out to the side');
    assert.equal(segmentAdvice('leftShin', [0, 0, 0], 30), 'Bend your left knee deeper');
    assert.equal(segmentAdvice('leftForearm', [0, 0.05, 0], -25), 'Straighten your left arm more');
    assert.equal(segmentAdvice('torso', [0, 0, 0.3]), 'Lean your chest further forward');
    assert.equal(segmentAdvice('leftThigh', [0, 0.05, 0.02]), null, 'small differences stay quiet');
    assert.equal(beatFraction(0.5), '½ beat');
    assert.equal(beatFraction(-0.27), '¼ beat');
});

test('live cues: timing, tracking and body corrections', () => {
    assert.match(liveCue({ status: 'late', lag: 0.25 }, { beat: 0.5 }).text, /½ beat late/);
    assert.equal(liveCue({ status: 'unseen' }, { beat: 0.5 }).tone, 'warn');
    const segments = new Float32Array(SEG_COUNT).fill(1);
    const user = new Float32Array(SEG_COUNT * 3);
    const ref = new Float32Array(SEG_COUNT * 3);
    const arm = SEGMENTS.findIndex((s) => s.name === 'leftUpperArm');
    segments[arm] = 0.2;
    user.set([1, -0.5, 0], arm * 3);
    ref.set([1, 0.5, 0], arm * 3);
    const cue = liveCue({ status: 'off', segments, user, ref }, { beat: 0.5 });
    assert.equal(cue.text, 'Raise your left elbow higher');
    assert.equal(cue.tone, 'bad');
});

test('attempt feedback: worst body part, timing tendency, weakest counts', () => {
    const segments = SEGMENTS.map((s) => ({ name: s.name, score: 92, diff: [0, 0, 0], bendDeg: 0 }));
    segments.find((s) => s.name === 'rightUpperArm').score = 48;
    segments.find((s) => s.name === 'rightUpperArm').diff = [0, 0.45, 0];
    const perBeat = [0, 1, 2, 3, 4, 5, 6, 7].map((b) => ({ beat: b, count: b + 1, score: b === 2 || b === 3 ? 45 : 88 }));
    const fb = attemptFeedback(summaryOf(72, { segments, perBeat, lag: 0.17, lagBeats: 0.34, lagSpread: 0.05, timing: 60 }), { beat: 0.5 });
    assert.equal(fb.headline, 'Getting there');
    assert.match(fb.tips[0].text, /^Raise your right elbow higher \(right upper arm: 48% match\)/);
    assert.match(fb.tips.find((t) => t.kind === 'timing').text, /⅓ beat behind/);
    const counts = fb.tips.find((t) => t.kind === 'counts');
    assert.match(counts.text, /^Counts 3–4 were your weakest \(45%\)/);
    assert.deepEqual(counts.action, { type: 'drill', startBeat: 2, endBeat: 4 });
    assert.deepEqual(weakestCounts(perBeat, 2), { startBeat: 2, endBeat: 4, score: 45 });

    const unseen = attemptFeedback({ valid: false, coverage: 0.3 }, { beat: 0.5 });
    assert.match(unseen.tips[0].text, /30%/);
});

test('progress: attempts update steps, mastery needs full tempo, resume is kept', () => {
    const data = emptyProgress();
    const sections = [{ startBeat: 0, endBeat: 8 }, { startBeat: 8, endBeat: 16 }];
    const keys = [...sections.map(sectionKey), 'full'];
    const t0 = Date.UTC(2026, 10, 20, 18);
    recordAttempt(data, { routineId: 'r1', routineName: 'R', stepKey: keys[0], stepLabel: 'Counts 1–8', tempo: 0.75, input: 'camera', at: t0, summary: summaryOf(90) });
    let m = routineMastery(data, 'r1', keys);
    assert.equal(m.mastered, 0, 'slow-tempo pass is progress, not mastery');
    assert.ok(m.mastery > 0.2 && m.mastery < 0.34);
    const rec = recordAttempt(data, { routineId: 'r1', routineName: 'R', stepKey: keys[0], stepLabel: 'Counts 1–8', tempo: 1, input: 'camera', at: t0 + 60e3, summary: summaryOf(84) });
    assert.ok(rec.mastered);
    m = routineMastery(data, 'r1', keys);
    assert.equal(m.mastered, 1);
    // Invalid attempts are kept in history but don't count
    recordAttempt(data, { routineId: 'r1', routineName: 'R', stepKey: keys[1], stepLabel: 'Counts 9–16', tempo: 1, input: 'camera', at: t0 + 120e3, summary: { ...summaryOf(99), valid: false } });
    assert.equal(data.routines.r1.steps[keys[1]].attempts, 0);
    completeStep(data, 'r1', 'watch', t0);
    assert.equal(data.routines.r1.steps.watch.mastered, true);

    setResume(data, 'r1', { stepKey: keys[1], tempo: 0.85 });
    assert.equal(getResume(data, 'r1').tempo, 0.85);

    const routines = [{ id: 'r1', name: 'R', steps: [{ key: 'watch', kind: 'watch', label: 'Watch' }, ...sections.map((s, i) => ({ key: keys[i], kind: 'section', label: `S${i}` })), { key: 'full', kind: 'full', label: 'Full' }] }];
    assert.deepEqual(recommendNext(data, routines).stepKey, keys[1]);
    assert.equal(recommendNext(emptyProgress(), routines).reason, 'Start your first routine');
});

test('weekly stats and session trend come from recorded practice', () => {
    const data = emptyProgress();
    const day1 = Date.UTC(2026, 10, 18, 18);
    const day2 = Date.UTC(2026, 10, 21, 18);
    for (const [at, score] of [[day1, 60], [day1 + 60e3, 70], [day2, 80], [day2 + 60e3, 84]]) {
        recordAttempt(data, { routineId: 'r', routineName: 'R', stepKey: 'full', stepLabel: 'Full', tempo: 1, input: 'camera', at, summary: summaryOf(score) });
    }
    addPracticeTime(data, 'r', 600, day2);
    const week = weeklyStats(data, day2 + 3600e3);
    assert.equal(week.attempts, 4);
    assert.equal(week.practiceSeconds, 600);
    assert.equal(week.avgScore, 73.5);
    const trend = sessionTrend(data);
    assert.equal(trend.sessions.length, 2);
    assert.equal(trend.delta, 82 - 65);
});

test('progress survives a save/load round trip and tolerates junk', () => {
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    const data = emptyProgress();
    data.settings.mirror = false;
    addPracticeTime(data, 'r', 42);
    assert.ok(saveProgress(data, storage));
    const back = loadProgress(storage);
    assert.equal(back.settings.mirror, false);
    assert.equal(back.routines.r.practiceSeconds, 42);
    assert.equal(back.settings.countIn, 4, 'new settings get defaults');
    store.set('autochoreo.progress.v1', '{not json');
    assert.deepEqual(loadProgress(storage).attempts, []);
});

test('lesson plan: watch, one step per eight, then the full routine', async () => {
    const { lessonSteps, learnableSteps, countsSummary } = await import('../learn/lesson.js');
    const meta = { duration: 0.5 + 18 * 0.5 + 0.2, rhythm: { bpm: 120, offset: 0.5 } }; // 18 counts
    const steps = lessonSteps(meta);
    assert.deepEqual(steps.map((s) => s.key), ['watch', 'section:0-8', 'section:8-18', 'full']);
    assert.equal(steps[1].label, 'Learn counts 1–8');
    assert.equal(steps[2].label, 'Learn counts 9–18', 'a short tail joins the last section');
    assert.equal(steps[3].start, 0);
    assert.equal(learnableSteps(steps).length, 3);
    assert.equal(countsSummary(meta), '18 counts · 2 sections');
    // A routine of a single eight has no separate section step
    assert.deepEqual(lessonSteps({ duration: 4.2, rhythm: { bpm: 120, offset: 0 } }).map((s) => s.key), ['watch', 'full']);
});
