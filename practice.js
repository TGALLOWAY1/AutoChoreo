// AutoChoreo — Practice Studio
//
// Learn a routine by repetition with feedback:
//   pick a step (a section of eight counts, or the whole routine)
//   → count-in → dance along with the reference (camera or a recording)
//   → live comparison on the shared musical timeline (pose, timing, movement)
//   → when the routine is lost: rewind to the phrase and drill it slower
//   → each pass is scored and stored; the tempo steps back up as it improves.
//
// The reference (a 3D dancer, or the source video), the music, the metronome,
// the dancer's recording and the scorer all follow one TransportController.

import { TransportController } from './sync.js';
import { loadRoutine, loadFbx, buildReferenceTrack, setRoutineRhythm } from './learn/library.js';
import { Stage } from './learn/stage.js';
import { PracticeTimeline, waveformPeaks } from './learn/timeline.js';
import { Metronome } from './learn/metronome.js';
import { LiveTracker } from './choreo/liveTracker.js';
import { extractPoseFromVideo } from './choreo/poseExtractor.js';
import {
    keypointsFromLandmarks, featuresFromKeypoints, segmentVisibility, compareFeatures, sampleTrackFeatures,
    resolveFrontBack, trackFacingTowardCamera,
    trackWeightsAt, trackMotionEnergy, alignByMovement, movementMatchAt, KP_COUNT, SEG_COUNT, FEATURE_SIZE,
} from './choreo/compare.js';
import { SyncScorer, AttemptAccumulator } from './choreo/scoring.js';
import { audioOnsetEnvelope, alignOnsets, mixToMono, beatSeconds, countAt, beatTime } from './choreo/rhythm.js';
import { lessonSteps, routineSections, countsSummary } from './learn/lesson.js';
import {
    loadProgress, saveProgress, recordAttempt, completeStep, addPracticeTime, setResume, getResume,
    stepRecord, stepProgress, recommendNext,
} from './learn/progress.js';
import { TEMPO_STEPS, stepTempo, tempoAfterAttempt, SyncLossDetector, drillRange, countsLabel, drillCleared } from './learn/adaptive.js';
import { liveCue, attemptFeedback, weakestCounts, beatFraction } from './learn/feedback.js';
import { drawSkeleton2D, imagePoints, prepareCanvas, toBox, COLORS } from './learn/overlay.js';
import { ICONS, hydrateIcons, ring, setRing, fmtClock, fmtTempo, esc, toast, scoreClass } from './learn/ui.js';

const $ = (id) => document.getElementById(id);
const TEMPO_CHIPS = [0.5, 0.75, 0.85, 1, 1.25];

// ── State ───────────────────────────────────────────────────────────

const transport = new TransportController();
const metronome = new Metronome(transport);
const progress = loadProgress();
const settings = progress.settings;
const lossDetector = new SyncLossDetector();

const state = {
    routine: null,
    meta: null,
    steps: [],
    sections: [],
    rhythm: null,
    step: null,
    range: null,           // { start, end } being practised
    loop: true,            // loop the range (A ↔ B) vs play the whole routine once
    customRange: false,    // the range was dragged on the timeline
    tempo: 1,
    input: null,           // null | 'camera' | 'recording' | 'watch'
    phase: 'idle',         // 'idle' | 'countin' | 'ready' | 'playing'
    pending: null,         // AbortController of a count-in / ready wait / loop restart
    attempt: null,         // AttemptAccumulator of the current pass
    passComplete: false,   // the current pass started at the range start and was not interrupted
    ownSeek: false,
    lastResult: null,
    lastSummary: null,
    lastFeedback: null,
    drill: null,           // { range, label, returnRange, returnTempo, returnLoop, returnStep, returnCustom }
    demo: null,            // "watch slowly" playback: settings to restore afterwards
    refSource: '3d',
    tracks: {},
    scorer: null,
    practiceSeconds: 0,
};

let stage = null;
let tracker = null;
let recording = null;      // { times, features, weights, image, valid, fps, duration, offset, alignment, url }
let recIndex = 0;
let liveLandmarks = null;  // latest camera landmarks (image space) for the overlay
let liveFeatures = null;
let liveVisibility = null;
const kpScratch = new Float32Array(KP_COUNT * 3);
const visScratch = new Float32Array(KP_COUNT);

const timeline = new PracticeTimeline($('timeline'), {
    onSeek: (t) => userSeek(t),
    onRangeChange: (range) => setCustomRange(range),
});

// ── Startup ─────────────────────────────────────────────────────────

hydrateIcons();
$('syncRing').innerHTML = ring(0, { id: 'sync' });
renderTempoChips();
updatePlayButton();

async function init() {
    const params = new URLSearchParams(location.search);
    let routineId = params.get('routine');
    if (!routineId) {
        // Pick up where the dancer left off, or start the first routine
        const recent = Object.entries(progress.routines).sort((a, b) => b[1].lastPracticedAt - a[1].lastPracticedAt)[0];
        routineId = recent ? recent[0] : 'preset:DancingMedium';
    }
    try {
        setLoading('Loading routine…');
        const routine = await loadRoutine(routineId);
        setLoading('Loading the dancer…');
        await applyRoutine(routine, { stepKey: params.get('step') });
        setLoading(null);
        const input = params.get('input');
        if (input === 'camera') startCamera();
        else if (input === 'recording') {
            // A file picker can only open from a click: point at the option instead
            $('useRecording').classList.add('suggested');
            $('useRecording').focus();
        }
    } catch (err) {
        console.error(err);
        setLoading(null);
        $('routineName').textContent = 'Could not load this routine';
        $('routineMeta').textContent = err.message;
        toast(`Could not load the routine: ${err.message}`, { tone: 'bad', ms: 8000 });
    }
}

function setLoading(text) {
    $('loading').classList.toggle('hidden', !text);
    if (text) $('loadingText').textContent = text;
}

async function applyRoutine(routine, { stepKey = null } = {}) {
    state.routine = routine;
    state.meta = routine.meta;
    state.tracks = {};
    document.title = `${routine.meta.name} — Practice — Auto Choreograph`;

    if (routine.music) {
        try {
            await transport.loadAudio(routine.music, routine.musicName || routine.meta.name);
        } catch (err) {
            console.warn('Routine music could not be decoded:', err);
        }
    }

    stage = stage || new Stage($('stageHost'), { transport });
    stage.setBody(await loadFbx(routine.bodyUrl));
    stage.setChoreography(routine.choreo);
    const body = settings.refBody === 'skeleton' ? 'skeleton' : 'character';
    stage.setMode(body);
    for (const b of $('bodyToggle').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === body));

    if (routine.video && routine.capture) {
        $('refVideo').src = URL.createObjectURL(routine.video);
        setRefSource('video');
    } else {
        $('refSourceToggle').classList.add('hidden');
        setRefSource('3d');
    }

    state.scorer = new SyncScorer(currentTrack());
    applyRhythm();
    metronome.setEnabled(settings.metronome === 'on' || (settings.metronome === 'auto' && !transport.hasAudio));

    $('routineThumb').src = routine.meta.thumbnail || '';
    $('trackThumb').src = routine.meta.thumbnail || '';
    $('routineName').textContent = routine.meta.name;
    $('trackName').textContent = routine.meta.name;

    // Where to start: the requested step, the saved resume point, or what's next
    const resume = getResume(progress, routine.meta.id);
    let key = stepKey || resume?.stepKey;
    if (!state.steps.find((s) => s.key === key)) {
        const next = recommendNext(progress, [{ id: routine.meta.id, name: routine.meta.name, steps: state.steps }]);
        const watched = stepRecord(progress, routine.meta.id, 'watch')?.mastered;
        key = watched || stepRecord(progress, routine.meta.id, next?.stepKey) ? next?.stepKey : 'watch';
    }
    const restoring = !!resume?.tempo && !stepKey;
    if (restoring) setTempo(resume.tempo, { persist: false });
    selectStep(key || 'watch', { restoring });
    updateMirrorUI();
    renderCoach();
    updateMetrics(null);
}

/** (Re)build everything that depends on the beat grid. */
function applyRhythm() {
    const meta = state.meta;
    state.rhythm = meta.rhythm;
    state.steps = lessonSteps(meta);
    state.sections = routineSections(meta);
    metronome.setRhythm(state.rhythm);
    const wave = transport.audioBuffer ? waveformPeaks(transport.audioBuffer) : null;
    let energy = null;
    if (!wave) {
        const values = trackMotionEnergy(currentTrack());
        const top = Array.from(values).sort((a, b) => a - b)[Math.floor(values.length * 0.97)] || 1;
        energy = { values: values.map((v) => Math.min(1, v / top)), rate: currentTrack().rate };
    }
    timeline.setData({ duration: meta.duration, rhythm: state.rhythm, sections: state.sections, wave, energy });
    const r = state.rhythm;
    const source = { music: 'from the music', movement: 'estimated from the movement', sequence: 'from the sequence', manual: 'set by you' }[r.source] || '';
    $('routineMeta').textContent = countsSummary(meta);
    $('rhythmInfo').innerHTML = `${Math.round(r.bpm)} BPM · ${esc(source)} <button id="adjustRhythm" title="Correct the tempo or where count 1 falls">Adjust</button>`;
    $('adjustRhythm').addEventListener('click', openRhythmEditor);
    $('trackMeta').textContent = `${Math.round(r.bpm)} BPM · ${transport.hasAudio ? esc(state.routine.musicName || 'Music') : 'No music — metronome'}`;
    updateTempoUI();
    renderSteps();
}

function currentTrack() {
    return trackFor(settings.mirror);
}

// ── Lesson steps ────────────────────────────────────────────────────

function renderSteps() {
    const id = state.meta.id;
    $('steps').innerHTML = state.steps.map((s, i) => {
        const rec = stepRecord(progress, id, s.key);
        const p = s.kind === 'watch' ? (rec?.mastered ? 1 : 0) : stepProgress(rec);
        const cls = [state.step?.key === s.key && !state.customRange && !state.drill ? 'current' : '', p >= 1 ? 'done' : p > 0 ? 'started' : ''].join(' ');
        const icon = state.step?.key === s.key && !state.customRange && !state.drill ? ICONS.play : p >= 1 ? ICONS.check : '';
        const best = rec?.bestScore != null ? `<span class="best ${scoreClass(rec.bestScore)}" title="Best score">${rec.bestScore}%</span>` : '';
        return `<li class="step ${cls}" data-key="${esc(s.key)}" tabindex="0" role="button" aria-label="${esc(s.label)}">
<span class="state">${icon}</span><span class="num">${i + 1}</span>
<span class="text"><b>${esc(s.label)}</b><small>${esc(s.sublabel)}</small></span>${best}</li>`;
    }).join('');
}

$('steps').addEventListener('click', (e) => {
    const li = e.target.closest('.step');
    if (li) selectStep(li.dataset.key);
});
$('steps').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('step')) {
        e.preventDefault();
        selectStep(e.target.dataset.key);
    }
});

function selectStep(key, { restoring = false } = {}) {
    const step = state.steps.find((s) => s.key === key) || state.steps[0];
    stopPass();
    leaveDemo();
    leaveDrill();
    state.step = step;
    state.customRange = false;
    state.loop = step.kind !== 'full' && step.kind !== 'watch' ? true : state.loop && step.kind === 'full';
    // Watching is easier a little slower
    if (step.kind === 'watch' && state.tempo >= 1 && !restoring) setTempo(0.75);
    applyRange({ start: step.start, end: step.end });
    seekTo(step.start);
    persistResume();
    renderSteps();
    renderCoach();
}

function setCustomRange(range) {
    stopPass();
    leaveDemo();
    leaveDrill();
    state.customRange = true;
    state.loop = true;
    applyRange(range);
    seekTo(range.start);
    renderSteps();
    renderCoach();
}

function applyRange(range) {
    state.range = { start: range.start, end: Math.min(range.end, state.meta.duration) };
    transport.setRange(state.loop ? state.range : { start: state.range.start, end: state.meta.duration });
    timeline.setRange(state.range);
    updateLoopUI();
}

function rangeLabel(range = state.range) {
    if (!state.rhythm) return `${fmtClock(range.start)}–${fmtClock(range.end)}`;
    const beat = beatSeconds(state.rhythm);
    const a = Math.max(0, Math.round((range.start - state.rhythm.offset) / beat));
    const b = Math.round((range.end - state.rhythm.offset) / beat);
    return `${countsLabel(a, b)} (${b - a} counts)`;
}

function currentStepKey() {
    if (state.drill) return 'drill';
    if (state.customRange) return 'loop';
    return state.step.key;
}

function currentStepLabel() {
    if (state.drill) return `Drill ${rangeLabel(state.drill.range).replace(/ \(.*/, '')}`;
    if (state.customRange) return `Loop ${rangeLabel().replace(/ \(.*/, '')}`;
    return state.step.label;
}

function updateLoopUI() {
    const label = state.loop ? `Loop: ${rangeLabel()}` : 'Playing straight through';
    $('loopLabel').textContent = label.charAt(0).toUpperCase() + label.slice(1);
    for (const b of $('loopToggle').querySelectorAll('button')) {
        b.setAttribute('aria-pressed', String((b.dataset.loop === 'on') === state.loop));
    }
}

$('loopToggle').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.loop === 'full') {
        state.loop = false;
        if (state.step?.kind !== 'full' || state.customRange || state.drill) selectStep('full');
        else applyRange(state.range);
    } else {
        state.loop = true;
        applyRange(state.range);
    }
    updateLoopUI();
});

// ── Tempo ───────────────────────────────────────────────────────────

function renderTempoChips() {
    $('tempoChips').innerHTML = TEMPO_CHIPS.map((t) => `<button data-tempo="${t}" aria-pressed="false">${fmtTempo(t)}</button>`).join('');
}

function setTempo(t, { persist = true } = {}) {
    state.tempo = Math.max(TEMPO_STEPS[0], Math.min(TEMPO_STEPS[TEMPO_STEPS.length - 1], t));
    transport.setSpeed(state.tempo);
    updateTempoUI();
    if (persist) persistResume();
}

function updateTempoUI() {
    for (const b of $('tempoChips').querySelectorAll('button')) {
        b.setAttribute('aria-pressed', String(Math.abs(Number(b.dataset.tempo) - state.tempo) < 1e-6));
    }
    const bpm = state.rhythm ? Math.round(state.rhythm.bpm * state.tempo) : null;
    $('bpmLabel').textContent = bpm ? `${bpm} BPM${state.tempo !== 1 ? ` · ${fmtTempo(state.tempo)}` : ''}` : fmtTempo(state.tempo);
    $('refTempo').textContent = fmtTempo(state.tempo);
}

$('tempoChips').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) setTempo(Number(b.dataset.tempo));
});
$('tempoDown').addEventListener('click', () => setTempo(stepTempo(state.tempo, -1)));
$('tempoUp').addEventListener('click', () => setTempo(stepTempo(state.tempo, +1)));

// ── Playback and passes ─────────────────────────────────────────────

const scoringActive = () => (state.input === 'camera' || state.input === 'recording') && state.step?.kind !== 'watch' && !state.demo;

function updatePlayButton() {
    const busy = transport.playing || state.phase === 'countin' || state.phase === 'ready' || state.phase === 'between';
    $('playButton').innerHTML = busy ? ICONS.pause : ICONS.play;
    $('playButton').classList.toggle('playing', busy);
    $('playButton').setAttribute('aria-label', busy ? 'Pause' : 'Play');
}

function seekTo(t) {
    state.ownSeek = true;
    transport.seek(t);
    state.ownSeek = false;
}

/** A seek the dancer asked for: the current pass no longer counts as a full pass. */
function userSeek(t) {
    const wasPlaying = transport.playing;
    cancelPending();
    seekTo(t);
    state.passComplete = false;
    if (state.phase === 'countin' || state.phase === 'ready') state.phase = 'idle';
    if (wasPlaying) transport.play();
    updatePlayButton();
}

function cancelPending() {
    if (state.pending) state.pending.abort();
    state.pending = null;
    $('countIn').classList.add('hidden');
    $('readyMeter').classList.add('hidden');
}

/** Stop playback and drop the pass in progress. */
function stopPass() {
    cancelPending();
    transport.pause();
    state.phase = 'idle';
    const hadPass = !!state.attempt;
    state.attempt = null;
    state.passComplete = false;
    $('liveCue').classList.add('hidden');
    // An unfinished pass is not shown as a result: back to the last finished one
    if (hadPass) updateMetrics(state.lastSummary, { final: !!state.lastSummary });
    updatePlayButton();
}

function togglePlay() {
    if (transport.playing || state.phase === 'countin' || state.phase === 'ready' || state.phase === 'between') {
        stopPass();
        flushPracticeTime();
        renderCoach();
        return;
    }
    startPass();
}

/**
 * Start a pass: from the range start (or wherever the playhead is inside it),
 * counted in when scoring, then play and score.
 */
async function startPass({ ready = false } = {}) {
    cancelPending();
    const end = state.loop ? state.range.end : state.meta.duration;
    let from = transport.currentTime;
    if (from < state.range.start - 1e-3 || from >= end - 0.05) from = state.range.start;
    seekTo(from);
    const fullPass = Math.abs(from - state.range.start) < 0.02;
    const job = new AbortController();
    state.pending = job;
    try {
        if (ready && state.input === 'camera') {
            state.phase = 'ready';
            updatePlayButton();
            await waitUntilReady(job.signal);
        }
        if (scoringActive() && state.input === 'camera' && settings.countIn > 0 && state.rhythm) {
            state.phase = 'countin';
            updatePlayButton();
            $('countIn').classList.remove('hidden');
            await metronome.countIn(from, {
                beats: settings.countIn,
                signal: job.signal,
                onCount: (label) => { $('countIn').innerHTML = `<span>${label}</span>`; },
            });
        }
    } catch (err) {
        if (err.name === 'AbortError') return;
        throw err;
    } finally {
        $('countIn').classList.add('hidden');
        $('countIn').innerHTML = '';
        $('readyMeter').classList.add('hidden');
        if (state.pending === job) state.pending = null;
    }
    if (job.signal.aborted) return;
    state.scorer.reset();
    lossDetector.reset();
    state.attempt = scoringActive() ? new AttemptAccumulator({ start: from, end, beat: beatSeconds(state.rhythm), offset: state.rhythm.offset }) : null;
    state.passComplete = fullPass && scoringActive();
    state.phase = 'playing';
    hideSyncToast();
    transport.play();
    updatePlayButton();
    renderCoach();
}

transport.on('rangeend', () => onPassEnd());
transport.on('seek', () => {
    state.scorer?.reset();
    lossDetector.reset();
    if (recording) recIndex = firstRecordingIndexAfter(transport.currentTime - 0.05);
    if (!state.ownSeek) state.passComplete = false;
    syncVideos(true);
});
transport.on('play', () => syncVideos(true));
transport.on('pause', () => { syncVideos(true); updatePlayButton(); });
transport.on('error', ({ message }) => toast(message, { tone: 'bad' }));

function onPassEnd() {
    state.phase = 'idle';
    updatePlayButton();
    flushPracticeTime();
    $('liveCue').classList.add('hidden');
    if (state.demo) { finishDemo(); return; }

    let summary = null;
    let record = null;
    let previousBest = null;
    if (state.attempt) {
        summary = state.attempt.finish();
        state.attempt = null;
        if (state.passComplete) {
            previousBest = stepRecord(progress, state.meta.id, currentStepKey())?.bestScore ?? null;
            record = recordAttempt(progress, {
                routineId: state.meta.id,
                routineName: state.meta.name,
                stepKey: currentStepKey(),
                stepLabel: currentStepLabel(),
                tempo: state.tempo,
                input: state.input,
                summary,
            });
        }
        state.lastSummary = summary;
        timeline.setBeatScores(new Map(summary.perBeat.map((b) => [b.beat, b.score])));
    }

    if (state.step.kind === 'watch' && !state.customRange && !state.drill) {
        completeStep(progress, state.meta.id, 'watch');
        saveProgress(progress);
        renderSteps();
        const next = state.steps.find((s) => s.kind === 'section') || state.steps.find((s) => s.kind === 'full');
        toast(`Watched. Next: ${next.label.toLowerCase()}.`, { tone: 'good' });
        selectStep(next.key);
        return;
    }

    let tempoChange = null;
    if (summary) {
        if (state.drill) {
            if (drillCleared(summary, state.tempo, state.drill.returnTempo)) {
                finishFeedback(summary, record, previousBest, null);
                exitDrill({ cleared: true });
                return;
            }
            const next = tempoAfterAttempt(state.tempo, summary, { target: state.drill.returnTempo });
            if (next.change) { setTempo(next.tempo); tempoChange = next.change; }
        } else if (settings.adaptiveTempo && state.passComplete) {
            const next = tempoAfterAttempt(state.tempo, summary, { target: 1 });
            if (next.change) { setTempo(next.tempo); tempoChange = next.change; }
        }
    }
    finishFeedback(summary, record, previousBest, tempoChange);
    persistResume();
    saveProgress(progress);
    renderSteps();

    if (state.loop) {
        // Keep looping: a short breath to read the score, then the next pass
        // (the pause button stays live, so the loop can be stopped here too)
        const job = new AbortController();
        state.pending = job;
        state.phase = 'between';
        updatePlayButton();
        const delay = summary ? 1600 : 400;
        setTimeout(() => {
            if (job.signal.aborted) return;
            state.pending = null;
            state.phase = 'idle';
            seekTo(state.range.start);
            startPass();
        }, delay);
    } else {
        seekTo(state.range.start);
    }
}

function finishFeedback(summary, record, previousBest, tempoChange) {
    if (!summary) return;
    state.lastFeedback = attemptFeedback(summary, { beat: beatSeconds(state.rhythm) });
    state.lastFeedback.record = record;
    state.lastFeedback.previousBest = previousBest;
    state.lastFeedback.tempoChange = tempoChange;
    updateMetrics(summary, { final: true });
    renderCoach();
    if (record?.mastered) {
        const next = state.steps.find((s) => (s.kind === 'section' || s.kind === 'full') && stepProgress(stepRecord(progress, state.meta.id, s.key)) < 1);
        toast(`${record.stepLabel} learned at full tempo!${next ? ` Next: ${next.label.toLowerCase()}.` : ''}`, { tone: 'good', ms: 5000 });
    } else if (record?.improved) {
        toast(`New best on this step: ${record.score}%`, { tone: 'good' });
    } else if (summary && !summary.valid) {
        toast('That pass could not be scored — make sure your whole body is in view.', { tone: 'warn' });
    }
}

$('playButton').addEventListener('click', togglePlay);

function phraseJump(dir) {
    const beat = state.rhythm ? beatSeconds(state.rhythm) : 1;
    const target = transport.currentTime + dir * 4 * beat;
    userSeek(Math.max(state.loop ? state.range.start : 0, Math.min(target, (state.loop ? state.range.end : state.meta.duration) - 0.05)));
}
$('prevPhrase').addEventListener('click', () => phraseJump(-1));
$('nextPhrase').addEventListener('click', () => phraseJump(+1));

window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select, .modal')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.code === 'ArrowLeft') { e.preventDefault(); phraseJump(-1); }
    if (e.code === 'ArrowRight') { e.preventDefault(); phraseJump(+1); }
});

// ── Getting ready (after a rewind) ─────────────────────────────────

/** Wait until the dancer holds the reference's starting pose (or presses "start now"). */
function waitUntilReady(signal) {
    $('readyMeter').classList.remove('hidden');
    const track = currentTrack();
    const target = sampleTrackFeatures(track, state.range.start);
    const baseWeights = trackWeightsAt(track, state.range.start);
    const weights = new Float32Array(SEG_COUNT);
    let heldSince = null;
    let smooth = 0;
    return new Promise((resolve, reject) => {
        const timer = setInterval(() => {
            if (!liveFeatures) return;
            for (let s = 0; s < SEG_COUNT; s++) weights[s] = baseWeights[s] * liveVisibility[s];
            const match = compareFeatures(liveFeatures, target, weights);
            smooth = smooth * 0.7 + match * 0.3;
            $('readyBar').style.width = `${Math.round(smooth * 100)}%`;
            if (smooth >= 0.72) {
                heldSince = heldSince ?? performance.now();
                if (performance.now() - heldSince > 500) finish();
            } else {
                heldSince = null;
            }
        }, 50);
        const finish = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
        const cleanup = () => {
            clearInterval(timer);
            signal.removeEventListener('abort', abort);
            $('startNow').removeEventListener('click', finish);
            $('readyMeter').classList.add('hidden');
        };
        signal.addEventListener('abort', abort, { once: true });
        $('startNow').addEventListener('click', finish, { once: true });
    });
}

// ── Scoring ─────────────────────────────────────────────────────────

/** A new observation of the dancer, at a song time. */
function onObservation(songTime, world) {
    if (!world) return;
    keypointsFromLandmarks(world, kpScratch, visScratch);
    // Settle the pose model's front/back ambiguity by which way the reference faces now
    resolveFrontBack(kpScratch, visScratch, trackFacingTowardCamera(currentTrack(), songTime));
    const features = featuresFromKeypoints(kpScratch);
    const vis = segmentVisibility(visScratch);
    liveFeatures = features;
    liveVisibility = vis;
    if (state.phase !== 'playing' || !transport.playing) return;
    state.scorer.push(songTime, features, vis);
    const result = state.scorer.evaluate();
    if (!result) return;
    state.lastResult = result;
    if (state.attempt) state.attempt.add(result);
    if (scoringActive()) {
        const loss = lossDetector.update(result);
        if (loss && !state.drill) onSyncLost(loss);
    }
}

let lastCueAt = 0;
function showLiveFeedback(now) {
    if (state.phase !== 'playing' || !scoringActive()) return;
    if (now - lastCueAt < 250) return;
    lastCueAt = now;
    const cue = liveCue(state.lastResult, { beat: beatSeconds(state.rhythm) });
    const el = $('liveCue');
    el.classList.remove('hidden');
    el.className = `live-cue ${cue.tone}`;
    el.textContent = cue.text;
    if (state.attempt) updateMetrics(state.attempt.snapshot());
    const coachLive = $('coachLive');
    if (coachLive) { coachLive.textContent = cue.text; coachLive.className = `live ${cue.tone}`; }
}

function updateMetrics(values, { final = false } = {}) {
    const set = (id, bar, v) => {
        $(id).textContent = v == null ? '—' : `${v}%`;
        $(id).className = scoreClass(v);
        $(bar).style.width = `${v ?? 0}%`;
    };
    const v = values || {};
    set('mTiming', 'bTiming', v.timing);
    set('mPose', 'bPose', v.pose);
    set('mMotion', 'bMotion', v.motion);
    set('mOverall', 'bOverall', v.score);
    $('syncValue').textContent = v.score == null ? '—' : `${v.score}%`;
    setRing($('syncRing').querySelector('svg'), (v.score ?? 0) / 100);
    const best = state.lastFeedback?.previousBest;
    const delta = final && v.score != null && best != null ? v.score - best : null;
    $('syncDelta').innerHTML = delta != null ? `<span class="${delta >= 0 ? 'good' : 'bad'}">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)} vs best</span>` : '';
    $('syncCaption').textContent = values ? (final ? `Last pass · ${fmtTempo(state.tempo)}` : 'This pass') : (state.input && state.input !== 'watch' ? 'Waiting for a pass' : '');
    const lag = v.lag;
    const beat = state.rhythm ? beatSeconds(state.rhythm) : 0.5;
    $('lagReadout').textContent = lag == null ? '' : Math.abs(lag) < 0.06
        ? 'On the beat on average'
        : `On average ${beatFraction(lag / beat)} ${lag > 0 ? 'behind' : 'ahead of'} the beat (${Math.round(Math.abs(lag) * 1000)} ms)`;
}

// ── Losing the routine → rewind and drill ───────────────────────────

let syncToastTimer = null;
let pendingLoss = null;

function onSyncLost(loss) {
    const c = countAt(loss.start, state.rhythm);
    const what = loss.kind === 'timing' ? `<b>Off timing</b>` : `<b>Lost the move</b>`;
    const detail = loss.kind === 'timing' && Math.abs(loss.lag) > 0.05 ? ` — ${beatFraction(loss.lag / beatSeconds(state.rhythm))} ${loss.lag > 0 ? 'late' : 'early'}` : '';
    pendingLoss = loss;
    $('syncToastText').innerHTML = `${what} at ${fmtClock(loss.start)} (count ${c.count})${detail}`;
    $('syncToast').classList.remove('hidden');
    clearTimeout(syncToastTimer);
    syncToastTimer = setTimeout(hideSyncToast, 9000);
    if (settings.autoRewind) rewindAndPractice();
}

function hideSyncToast() {
    $('syncToast').classList.add('hidden');
    clearTimeout(syncToastTimer);
}

function rewindAndPractice() {
    const loss = pendingLoss;
    hideSyncToast();
    if (!loss) return;
    const range = drillRange(loss.start, state.rhythm, state.loop ? state.range : { start: 0, end: state.meta.duration });
    startDrill(range);
}

$('rewindPractice').addEventListener('click', rewindAndPractice);
$('dismissToast').addEventListener('click', hideSyncToast);

function startDrill(range) {
    stopPass();
    leaveDemo();
    const returnTempo = state.drill ? state.drill.returnTempo : state.tempo;
    if (!state.drill) {
        state.drill = { returnRange: { ...state.range }, returnTempo, returnLoop: state.loop, returnStep: state.step.key, returnCustom: state.customRange };
    }
    state.drill.range = { start: range.start, end: range.end };
    state.loop = true;
    setTempo(stepTempo(Math.min(state.tempo, returnTempo), -1));
    applyRange(state.drill.range);
    seekTo(range.start);
    $('drillText').innerHTML = `Drilling <b>${esc(rangeLabel())}</b> — clear it at ${fmtTempo(returnTempo)} to go back`;
    $('drillBanner').classList.remove('hidden');
    renderSteps();
    renderCoach();
    if (state.input === 'camera' || state.input === 'recording') startPass({ ready: true });
}

function exitDrill({ cleared = false } = {}) {
    const d = state.drill;
    if (!d) return;
    stopPass();
    leaveDrill();
    state.loop = d.returnLoop;
    state.customRange = d.returnCustom;
    state.step = state.steps.find((s) => s.key === d.returnStep) || state.step;
    setTempo(d.returnTempo);
    applyRange(d.returnRange);
    renderSteps();
    renderCoach();
    if (cleared) {
        toast('Phrase cleared! Back to the routine.', { tone: 'good' });
        // Carry on from where the drilled phrase ended
        const end = state.loop ? state.range.end : state.meta.duration;
        seekTo(d.range.end < end - 0.5 ? d.range.end : state.range.start);
        startPass();
    } else {
        seekTo(state.range.start);
    }
}

/** Forget drill state without touching playback (used when choosing another step). */
function leaveDrill() {
    state.drill = null;
    $('drillBanner').classList.add('hidden');
}

$('exitDrill').addEventListener('click', () => exitDrill());

// ── Coach ───────────────────────────────────────────────────────────

function renderCoach() {
    const body = $('coachBody');
    const watchStep = state.step?.kind === 'watch';
    if (state.phase === 'playing' && scoringActive()) {
        body.innerHTML = `<div id="coachLive" class="live">Watching your movement…</div><p>Comparing your ${state.input === 'camera' ? 'live movement' : 'recording'} with the reference at ${fmtTempo(state.tempo)}.</p>`;
        return;
    }
    if (!state.input) {
        body.innerHTML = `<h4>Ready when you are</h4><p>Choose <b>Live camera</b> or <b>Upload a recording</b>. Each pass is compared with the reference — body shape, timing and movement — and you’ll get specific corrections here.</p>`;
        return;
    }
    if (watchStep) {
        body.innerHTML = `<h4>Watch it through first</h4><p>See the whole routine at ${fmtTempo(state.tempo)} and notice where the sections change. Press play — the sections are marked A, B, C… on the timeline.</p>`;
        return;
    }
    const fb = state.lastFeedback;
    if (!fb) {
        const step = state.drill ? 'this phrase' : state.customRange ? 'this loop' : state.step.kind === 'full' ? 'the full routine' : state.step.label.replace(/^Learn /, '');
        body.innerHTML = `<h4>${esc(state.drill ? 'Drill the phrase' : 'Your turn')}</h4><p>Press play for a ${settings.countIn ? `${settings.countIn}-count count-in` : 'start'} and dance ${esc(step)} with the reference.${settings.adaptiveTempo ? ' The tempo steps up as you get it right.' : ''}</p>`;
        return;
    }
    const tips = fb.tips.map((t, i) => `<li>${esc(t.text)}${t.action ? ` <button class="btn small outline" data-tip="${i}">Drill</button>` : ''}</li>`).join('');
    const strengths = fb.strengths.length ? `<div class="strengths">${fb.strengths.map((s) => `<span class="chip">${ICONS.check}${esc(s)}</span>`).join('')}</div>` : '';
    const tempo = fb.tempoChange === 'up' ? `<p class="good">Next pass a step faster: ${fmtTempo(state.tempo)}.</p>`
        : fb.tempoChange === 'down' ? `<p class="warn">Next pass a step slower: ${fmtTempo(state.tempo)}.</p>` : '';
    body.innerHTML = `<h4>${esc(fb.headline)}</h4>${tips ? `<ul>${tips}</ul>` : ''}${strengths}${tempo}`;
    body.querySelectorAll('[data-tip]').forEach((b) => b.addEventListener('click', () => {
        const action = fb.tips[Number(b.dataset.tip)].action;
        drillCounts(action.startBeat, action.endBeat);
    }));
}

/** Drill a run of counts (padded by a beat before, so the move can be set up). */
function drillCounts(startBeat, endBeat) {
    const bounds = state.drill ? state.drill.returnRange : state.range;
    const start = Math.max(bounds.start, beatTime(startBeat - 1, state.rhythm));
    const end = Math.min(bounds.end, beatTime(Math.max(endBeat, startBeat + 2), state.rhythm));
    startDrill({ start, end });
}

$('drillWeak').addEventListener('click', () => {
    const weak = state.lastSummary ? weakestCounts(state.lastSummary.perBeat, 2) : null;
    if (!weak) { toast('Dance a pass first — then I can find your weakest counts.'); return; }
    drillCounts(weak.startBeat, weak.endBeat);
});

/** Play the reference slowly over the focus area (weakest counts or the current range), without scoring. */
$('watchSlowly').addEventListener('click', () => {
    const weak = state.lastSummary ? weakestCounts(state.lastSummary.perBeat, 2) : null;
    stopPass();
    state.demo = { tempo: state.tempo, range: { ...state.range }, loop: state.loop };
    let range = state.range;
    if (weak) {
        range = { start: Math.max(state.range.start, beatTime(weak.startBeat - 1, state.rhythm)), end: Math.min(state.range.end, beatTime(weak.endBeat, state.rhythm)) };
    }
    state.loop = true;
    setTempo(0.5, { persist: false });
    applyRange(range);
    seekTo(range.start);
    if (state.refSource === 'video' && state.routine.video) setRefSource('video');
    toast(`Watching ${rangeLabel(range)} at 0.5×`);
    state.phase = 'playing';
    transport.play();
    updatePlayButton();
});

/** Leave "watch slowly" early (another step, loop or drill was chosen): give back the tempo it borrowed. */
function leaveDemo() {
    if (!state.demo) return;
    const { tempo } = state.demo;
    state.demo = null;
    setTempo(tempo);
}

function finishDemo() {
    const d = state.demo;
    state.demo = null;
    state.loop = d.loop;
    setTempo(d.tempo);
    applyRange(d.range);
    seekTo(d.range.start);
    renderCoach();
}

// ── Inputs: live camera ─────────────────────────────────────────────

$('useCamera').addEventListener('click', startCamera);
$('useRecording').addEventListener('click', () => $('recordingInput').click());
$('justWatch').addEventListener('click', () => setInput('watch'));
$('changeInput').addEventListener('click', () => {
    stopPass();
    closeInputs();
    setInput(null);
});

function setInput(input) {
    state.input = input;
    $('inputPicker').classList.toggle('hidden', !!input);
    $('changeInput').classList.toggle('hidden', !input);
    $('alignTools').classList.toggle('hidden', input !== 'recording');
    $('userWrap').classList.toggle('flipped', input === 'camera');
    $('userLabel').textContent = { camera: 'Your performance (live)', recording: 'Your recording', watch: 'Watching only — no scoring' }[input] || 'Choose an input';
    if (input !== 'camera' && input !== 'recording') $('inputStatus').textContent = '';
    renderCoach();
    updateMetrics(null);
}

function closeInputs() {
    if (tracker) { tracker.close(); tracker = null; }
    liveLandmarks = null;
    liveFeatures = null;
    if (recording) {
        URL.revokeObjectURL(recording.url);
        recording = null;
    }
    const v = $('userVideo');
    v.pause();
    v.removeAttribute('src');
    v.srcObject = null;
    v.load();
}

async function startCamera() {
    closeInputs();
    setInput('camera');
    $('inputStatus').textContent = 'Starting camera…';
    try {
        tracker = new LiveTracker({
            model: settings.trackingModel,
            onPose: ({ world, image, captureTime }) => {
                liveLandmarks = image;
                const songTime = transport.songTimeAt(captureTime) - (transport.outputLatency + settings.latencyMs / 1000) * transport.speed;
                onObservation(songTime, world);
            },
        });
        await tracker.openCamera($('userVideo'));
        $('inputStatus').textContent = 'Loading pose model…';
        await tracker.start();
        $('inputStatus').textContent = 'Tracking';
        toast('Camera ready — stand back so your whole body is in view, then press play.');
    } catch (err) {
        console.error(err);
        const denied = err.name === 'NotAllowedError' || err.name === 'SecurityError';
        toast(denied ? 'Camera access was blocked. Allow the camera for this site, or upload a recording instead.' : `Camera unavailable: ${err.message}`, { tone: 'bad', ms: 7000 });
        closeInputs();
        setInput(null);
    }
}

// ── Inputs: an uploaded recording ───────────────────────────────────

$('recordingInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await loadRecording(file);
});

async function loadRecording(file) {
    stopPass();
    closeInputs();
    setInput('recording');
    const job = new AbortController();
    try {
        setLoading('Tracking your recording…');
        const capture = await extractPoseFromVideo(file, {
            signal: job.signal,
            onProgress: ({ stage: what, fraction }) => setLoading(`${what}… ${Math.round(fraction * 100)}%`),
        });
        setLoading('Lining your recording up with the routine…');
        const rec = recordingTrack(capture);
        rec.url = URL.createObjectURL(file);
        rec.alignment = await alignRecording(file, rec);
        rec.offset = rec.alignment.offset;
        if (rec.alignment.mirror !== settings.mirror) {
            // Score it the way it was danced
            settings.mirror = rec.alignment.mirror;
            state.scorer.setTrack(currentTrack());
            updateMirrorUI();
        }
        recording = rec;
        recIndex = 0;
        const v = $('userVideo');
        v.src = rec.url;
        v.muted = true;
        setLoading(null);
        updateAlignLabel();
        const missed = capture.frameCount - rec.validCount;
        $('inputStatus').textContent = missed > capture.frameCount * 0.2 ? `Not seen in ${Math.round((missed / capture.frameCount) * 100)}% of frames` : '';
        const side = rec.alignment.mirror ? 'mirrored' : 'on the same side as the reference';
        toast(rec.alignment.source === 'music'
            ? `Recording lined up by its music; you danced it ${side}. Press play to score it.`
            : `Recording lined up by your movement (so timing is judged relative to your own average); you danced it ${side}. Press play to score it.`, { ms: 7000 });
    } catch (err) {
        setLoading(null);
        console.error(err);
        toast(`Could not use this recording: ${err.message}`, { tone: 'bad', ms: 7000 });
        closeInputs();
        setInput(null);
    }
}

/**
 * Per-frame keypoints and features of a recording (recording time = frame
 * middle). Features are read facing the camera — good enough to line the
 * recording up; once it is placed, each frame is re-read against the
 * reference's facing as it is scored (see feedRecording).
 */
function recordingTrack(capture) {
    const n = capture.frameCount;
    const S = KP_COUNT * 3;
    const times = new Float32Array(n);
    const keypoints = new Float32Array(n * S);
    const keypointVis = new Float32Array(n * KP_COUNT);
    const features = new Float32Array(n * FEATURE_SIZE);
    const weights = new Float32Array(n * SEG_COUNT);
    const valid = new Uint8Array(n);
    let validCount = 0;
    for (let f = 0; f < n; f++) {
        times[f] = (f + 0.5) / capture.fps;
        const w = capture.world[f];
        if (!w) continue;
        keypointsFromLandmarks(w, kpScratch, visScratch);
        keypoints.set(kpScratch, f * S);
        keypointVis.set(visScratch, f * KP_COUNT);
        resolveFrontBack(kpScratch, visScratch, 1);
        features.set(featuresFromKeypoints(kpScratch), f * FEATURE_SIZE);
        weights.set(segmentVisibility(visScratch), f * SEG_COUNT);
        valid[f] = 1;
        validCount++;
    }
    return { times, keypoints, keypointVis, features, weights, valid, validCount, image: capture.image, fps: capture.fps, duration: capture.duration, frameCount: n };
}

/**
 * Where the recording sits on the routine's timeline, and whether it was
 * danced mirrored or on the same side as the reference. Placed by the music
 * when both have it (several candidate shifts for looped music, picked by
 * movement); otherwise by the movement itself.
 */
async function alignRecording(file, rec) {
    const valid = [];
    for (let i = 0; i < rec.frameCount; i++) if (rec.valid[i]) valid.push(i);
    const user = { times: rec.times, features: rec.features, weights: rec.weights };
    const tracks = { mirror: trackFor(true), same: trackFor(false) };
    let byMusic = null;
    if (transport.audioBuffer) {
        try {
            const recBuffer = await transport.audioContext.decodeAudioData(await file.arrayBuffer());
            const a = audioOnsetEnvelope(mixToMono(transport.audioBuffer), transport.audioBuffer.sampleRate);
            const b = audioOnsetEnvelope(mixToMono(recBuffer), recBuffer.sampleRate);
            const result = alignOnsets(a, b, Math.max(10, Math.min(120, transport.audioBuffer.duration)));
            if (result.confidence >= 4) byMusic = result;
        } catch (err) {
            console.warn('Recording has no usable soundtrack for alignment:', err);
        }
    }
    let best = null;
    for (const [mode, track] of Object.entries(tracks)) {
        if (byMusic) {
            for (const c of byMusic.candidates.filter((c) => c.score >= byMusic.candidates[0].score * 0.9)) {
                const m = movementMatchAt(user, track, c.offset, valid).score;
                if (!best || m > best.score) best = { offset: c.offset, source: 'music', score: m, mirror: mode === 'mirror' };
            }
        } else {
            const r = alignByMovement(user, track);
            if (r && (!best || r.score > best.score)) best = { offset: r.offset, source: 'movement', score: r.score, mirror: mode === 'mirror' };
        }
    }
    if (!best) throw new Error('Nobody was found in the recording');
    return best;
}

function trackFor(mirror) {
    const key = mirror ? 'mirror' : 'normal';
    if (!state.tracks[key]) state.tracks[key] = buildReferenceTrack(state.routine, { mirror });
    return state.tracks[key];
}

function updateAlignLabel() {
    if (!recording) return;
    const o = recording.offset;
    $('alignLabel').textContent = `${recording.alignment.source === 'music' ? 'Music' : 'Movement'} sync ${o >= 0 ? '+' : ''}${o.toFixed(2)} s`;
    $('alignLabel').title = `Your recording is placed ${Math.abs(o).toFixed(2)} s ${o >= 0 ? 'later' : 'earlier'} on the routine’s timeline (lined up by ${recording.alignment.source}). Nudge it if needed.`;
}

$('alignTools').addEventListener('click', (e) => {
    const b = e.target.closest('[data-nudge]');
    if (!b || !recording) return;
    recording.offset += Number(b.dataset.nudge);
    updateAlignLabel();
    userSeek(transport.currentTime);
});

function firstRecordingIndexAfter(songTime) {
    if (!recording) return 0;
    let i = 0;
    while (i < recording.frameCount && recording.times[i] + recording.offset <= songTime) i++;
    return i;
}

/** Feed the recording's frames up to the playhead into the scorer, in order. */
function feedRecording() {
    if (!recording || !transport.playing) return;
    const now = transport.currentTime;
    while (recIndex < recording.frameCount && recording.times[recIndex] + recording.offset <= now) {
        const i = recIndex++;
        if (!recording.valid[i]) continue;
        const songTime = recording.times[i] + recording.offset;
        kpScratch.set(recording.keypoints.subarray(i * KP_COUNT * 3, (i + 1) * KP_COUNT * 3));
        visScratch.set(recording.keypointVis.subarray(i * KP_COUNT, (i + 1) * KP_COUNT));
        resolveFrontBack(kpScratch, visScratch, trackFacingTowardCamera(currentTrack(), songTime));
        const features = featuresFromKeypoints(kpScratch);
        const vis = segmentVisibility(visScratch);
        liveFeatures = features;
        liveVisibility = vis;
        if (state.phase !== 'playing') continue;
        state.scorer.push(songTime, features, vis);
        const result = state.scorer.evaluate();
        if (!result) continue;
        state.lastResult = result;
        if (state.attempt) state.attempt.add(result);
        if (scoringActive()) {
            const loss = lossDetector.update(result);
            if (loss && !state.drill) onSyncLost(loss);
        }
    }
}

// ── Views ───────────────────────────────────────────────────────────

function setRefSource(source) {
    state.refSource = source;
    const video = source === 'video' && state.routine?.video;
    $('refVideoWrap').classList.toggle('hidden', !video);
    $('stageHost').classList.toggle('hidden', !!video);
    for (const b of $('refSourceToggle').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.source === (video ? 'video' : '3d')));
    $('bodyToggle').classList.toggle('hidden', !!video);
    syncVideos(true);
}

$('refSourceToggle').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) setRefSource(b.dataset.source);
});
$('bodyToggle').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !stage) return;
    stage.setMode(b.dataset.mode);
    settings.refBody = b.dataset.mode;
    saveProgress(progress);
    for (const x of $('bodyToggle').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
});

/** Mirror practice: the dancer follows the reference like a mirror (their left = its right). */
function updateMirrorUI() {
    // Same-side practice shows the reference mirrored, as in a dance studio mirror
    $('refMedia').classList.toggle('flipped', !settings.mirror);
    $('mirrorBadge').innerHTML = `${ICONS.mirror}${settings.mirror ? 'Mirror' : 'Same side'}`;
    $('mirrorBadge').title = settings.mirror
        ? 'Follow like a mirror: when the reference moves its right arm, you move your left'
        : 'Same side: you move the same arm as the reference';
}

function syncVideo(video, target, duration, force) {
    if (!video.src && !video.currentSrc) return;
    const inside = target >= 0 && target <= duration;
    const t = Math.max(0, Math.min(duration - 0.02, target));
    if (force || Math.abs(video.currentTime - t) > 0.12) video.currentTime = t;
    if (video.playbackRate !== transport.speed) video.playbackRate = transport.speed;
    const shouldPlay = transport.playing && inside;
    if (shouldPlay && video.paused) video.play().catch(() => {});
    if (!shouldPlay && !video.paused) video.pause();
}

function syncVideos(force = false) {
    const t = transport.currentTime;
    if (state.refSource === 'video' && state.routine?.capture) syncVideo($('refVideo'), t, state.routine.capture.duration, force);
    if (recording) syncVideo($('userVideo'), t - recording.offset, recording.duration, force);
}

function drawReferenceVideoOverlay() {
    const capture = state.routine?.capture;
    const video = $('refVideo');
    const { ctx, box } = prepareCanvas($('refOverlay'), video);
    if (!capture || state.refSource !== 'video') return;
    const f = Math.max(0, Math.min(capture.frameCount - 1, Math.floor(video.currentTime * capture.fps)));
    const lm = capture.image[f];
    if (!lm) return;
    drawSkeleton2D(ctx, toBox(imagePoints(lm, 1, 1), box), { color: COLORS.reference, glow: COLORS.referenceGlow, lineWidth: Math.max(2, box.height / 170) });
}

function drawUserOverlay() {
    const video = $('userVideo');
    const { ctx, box } = prepareCanvas($('userOverlay'), video);
    let lm = null;
    if (state.input === 'camera') lm = liveLandmarks;
    else if (state.input === 'recording' && recording) {
        const f = Math.max(0, Math.min(recording.frameCount - 1, Math.floor(video.currentTime * recording.fps)));
        lm = recording.image[f];
    }
    if (!lm) return;
    const scoring = state.phase === 'playing' && scoringActive() && state.lastResult?.segments;
    drawSkeleton2D(ctx, toBox(imagePoints(lm, 1, 1), box), {
        color: '#e8e2ff',
        segmentScores: scoring ? state.lastResult.segments : null,
        lineWidth: Math.max(2, box.height / 170),
    });
}

// ── Settings ────────────────────────────────────────────────────────

$('settingsButton').addEventListener('click', openSettings);

function modal(html, onMount) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    backdrop.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    onMount?.(backdrop.querySelector('.modal'), close);
    backdrop.querySelector('button, input')?.focus();
    return close;
}

function openSettings() {
    const s = settings;
    modal(`<h3>Practice settings</h3>
<div class="switch-row"><span class="what">Follow like a mirror<small>Your left matches the reference’s right (turn off to use the same side)</small></span><input type="checkbox" class="switch" data-set="mirror" ${s.mirror ? 'checked' : ''}></div>
<div class="switch-row"><span class="what">Auto-rewind when lost<small>Rewind to the phrase and drill it slower automatically</small></span><input type="checkbox" class="switch" data-set="autoRewind" ${s.autoRewind ? 'checked' : ''}></div>
<div class="switch-row"><span class="what">Adaptive tempo<small>Speed up after a strong pass, slow down after a weak one</small></span><input type="checkbox" class="switch" data-set="adaptiveTempo" ${s.adaptiveTempo ? 'checked' : ''}></div>
<div class="switch-row"><span class="what">Metronome<small>Clicks on every count</small></span>
 <div class="segmented" data-seg="metronome">${['auto', 'on', 'off'].map((v) => `<button data-v="${v}" aria-pressed="${s.metronome === v}">${v === 'auto' ? 'Auto' : v === 'on' ? 'On' : 'Off'}</button>`).join('')}</div></div>
<div class="switch-row"><span class="what">Count-in<small>Beats counted before each pass</small></span>
 <div class="segmented" data-seg="countIn">${[0, 4, 8].map((v) => `<button data-v="${v}" aria-pressed="${s.countIn === v}">${v || 'Off'}</button>`).join('')}</div></div>
<div class="switch-row"><span class="what">Tracking<small>Fast suits slower computers</small></span>
 <div class="segmented" data-seg="trackingModel">${[['lite', 'Fast'], ['full', 'Accurate']].map(([v, l]) => `<button data-v="${v}" aria-pressed="${s.trackingModel === v}">${l}</button>`).join('')}</div></div>
<div class="field" style="margin-top:12px"><label for="latency">Audio delay compensation: <b id="latencyValue">${s.latencyMs} ms</b></label>
 <input id="latency" type="range" min="-100" max="400" step="10" value="${s.latencyMs}">
 <small class="muted">Raise this if you’re always scored late with wireless headphones or speakers.</small></div>
<div class="actions"><button class="btn primary" data-close>Done</button></div>`, (root) => {
        root.querySelectorAll('[data-set]').forEach((input) => input.addEventListener('change', () => {
            settings[input.dataset.set] = input.checked;
            if (input.dataset.set === 'mirror') {
                state.scorer.setTrack(currentTrack());
                updateMirrorUI();
            }
            saveProgress(progress);
        }));
        root.querySelectorAll('[data-seg]').forEach((seg) => seg.addEventListener('click', (e) => {
            const b = e.target.closest('button');
            if (!b) return;
            const key = seg.dataset.seg;
            settings[key] = key === 'countIn' ? Number(b.dataset.v) : b.dataset.v;
            seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
            if (key === 'metronome') metronome.setEnabled(settings.metronome === 'on' || (settings.metronome === 'auto' && !transport.hasAudio));
            if (key === 'trackingModel' && state.input === 'camera') toast('The new tracking setting applies next time the camera starts.');
            saveProgress(progress);
            renderCoach();
        }));
        root.querySelector('#latency').addEventListener('input', (e) => {
            settings.latencyMs = Number(e.target.value);
            root.querySelector('#latencyValue').textContent = `${settings.latencyMs} ms`;
            saveProgress(progress);
        });
    });
}

/** Correct the routine's tempo or where count 1 falls (tap along, halve/double, shift). */
function openRhythmEditor() {
    const r = { ...state.rhythm };
    const taps = [];
    modal(`<h3>Tempo &amp; counts</h3>
<p>Sections and counts follow this beat grid. It was ${r.source === 'music' ? 'detected from the music' : r.source === 'movement' ? 'estimated from the dancer’s movement' : r.source === 'sequence' ? 'taken from the sequence' : 'set by you'}.</p>
<div class="field"><label for="bpmInput">Beats per minute</label>
 <div style="display:flex;gap:6px;flex-wrap:wrap"><input id="bpmInput" class="input" type="number" min="40" max="240" step="0.1" value="${Math.round(r.bpm * 10) / 10}" style="width:110px">
 <button class="btn small" data-act="half">½×</button><button class="btn small" data-act="double">2×</button><button class="btn small" data-act="tap">Tap along</button></div></div>
<div class="field"><span class="label">Count 1 falls at <b id="offsetValue">${r.offset.toFixed(2)} s</b></span>
 <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn small" data-act="beat-">− 1 count</button><button class="btn small" data-act="fine-">− ⅛</button><button class="btn small" data-act="fine+">+ ⅛</button><button class="btn small" data-act="beat+">+ 1 count</button><button class="btn small" data-act="here">Here (playhead)</button></div></div>
<div class="actions"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-act="save">Save</button></div>`, (root, close) => {
        const bpmInput = root.querySelector('#bpmInput');
        const show = () => { bpmInput.value = Math.round(r.bpm * 10) / 10; root.querySelector('#offsetValue').textContent = `${r.offset.toFixed(2)} s`; };
        bpmInput.addEventListener('change', () => { r.bpm = Math.max(40, Math.min(240, Number(bpmInput.value) || r.bpm)); });
        root.addEventListener('click', async (e) => {
            const act = e.target.closest('[data-act]')?.dataset.act;
            if (!act) return;
            const beat = 60 / r.bpm;
            if (act === 'half') r.bpm /= 2;
            if (act === 'double') r.bpm *= 2;
            if (act === 'tap') {
                const now = performance.now();
                if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
                taps.push(now);
                if (taps.length >= 4) r.bpm = 60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1));
            }
            if (act === 'beat-') r.offset = Math.max(0, r.offset - beat);
            if (act === 'beat+') r.offset += beat;
            if (act === 'fine-') r.offset = Math.max(0, r.offset - beat / 8);
            if (act === 'fine+') r.offset += beat / 8;
            if (act === 'here') r.offset = transport.currentTime;
            // Keep count 1 within the first beat-or-so of the routine unless moved on purpose
            show();
            if (act === 'save') {
                state.meta = await setRoutineRhythm(state.meta.id, { bpm: r.bpm, offset: r.offset });
                state.routine.meta = state.meta;
                const key = state.step?.key;
                applyRhythm();
                selectStep(state.steps.find((s) => s.key === key) ? key : 'watch');
                close();
                toast('Beat grid updated');
            }
        });
    });
}

// ── Progress bookkeeping ────────────────────────────────────────────

function persistResume() {
    if (!state.meta || !state.step) return;
    setResume(progress, state.meta.id, { stepKey: state.step.key, tempo: state.tempo, position: transport.currentTime });
    saveProgress(progress);
}

function flushPracticeTime() {
    if (state.practiceSeconds > 0 && state.meta) {
        addPracticeTime(progress, state.meta.id, state.practiceSeconds);
        state.practiceSeconds = 0;
        saveProgress(progress);
    }
}

window.addEventListener('pagehide', () => {
    flushPracticeTime();
    persistResume();
    closeInputs();
});

// ── Frame loop ──────────────────────────────────────────────────────

let lastFrame = performance.now();
let flushAt = performance.now();
function animate(now) {
    requestAnimationFrame(animate);
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    transport.tick(dt);
    metronome.tick();
    if (state.input === 'recording') feedRecording();
    syncVideos(false);
    if (state.refSource === '3d' || !state.routine?.video) stage?.render();
    else drawReferenceVideoOverlay();
    drawUserOverlay();
    showLiveFeedback(now);
    timeline.setTime(transport.currentTime);
    const total = fmtClock(state.meta?.duration ?? 0);
    const clock = `${fmtClock(transport.currentTime)} / ${total}`;
    $('refClock').textContent = clock;
    $('userClock').textContent = clock;
    if (tracker && state.input === 'camera') $('inputStatus').textContent = `Tracking · ${tracker.fps} fps${tracker.delegate === 'CPU' ? ' (CPU)' : ''}`;
    if (transport.playing && scoringActive()) state.practiceSeconds += dt;
    if (now - flushAt > 10000) { flushAt = now; flushPracticeTime(); }
}
requestAnimationFrame(animate);

init();

// Exposed for debugging and automated browser tests
window.autochoreoPractice = { transport, state, settings, startPass, selectStep, setTempo };
