// AutoChoreo — Learning dashboard
//
// The entry point for learning: what choreography is available (built-in mocap,
// the dancer's converted videos and imports), a preview of the selected routine
// (source video, its kinematic data and the animated dancer, on one timeline),
// upload → convert → practise, and progress — every number from recorded practice.

import { TransportController } from './sync.js';
import {
    listRoutines, loadRoutine, loadFbx, buildReferenceTrack, importVideo, importDanceFile, deleteRoutine,
} from './learn/library.js';
import { Stage } from './learn/stage.js';
import { PracticeTimeline, waveformPeaks } from './learn/timeline.js';
import { sampleTrackKeypoints, trackMotionEnergy, KP, KP_COUNT } from './choreo/compare.js';
import { lessonSteps, learnableSteps, routineSections, countsSummary } from './learn/lesson.js';
import {
    loadProgress, saveProgress, routineMastery, weeklyStats, sessionTrend, recentAttempts, recommendNext, getResume, stepRecord,
} from './learn/progress.js';
import { drawSkeleton2D, imagePoints, prepareCanvas, toBox, COLORS } from './learn/overlay.js';
import { ICONS, hydrateIcons, ring, setRing, fmtDuration, fmtDay, esc, toast, scoreClass } from './learn/ui.js';

const $ = (id) => document.getElementById(id);
const progress = loadProgress();
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5];

let routines = [];
let filter = 'all';
let query = '';
let showAll = false;
let historyAll = false;
let selectedId = null;
let preview = null;       // { routine, track, sections, bounds }
let loadToken = 0;

hydrateIcons();
$('masteryRing').innerHTML = ring(0, { size: 120, stroke: 11, id: 'mastery' });
$('welcome').textContent = progress.attempts.length ? 'Welcome back' : 'Welcome';

// ── Library ─────────────────────────────────────────────────────────

const analysed = (m) => m.duration && m.rhythm;
const stepsOf = (m) => (analysed(m) ? lessonSteps(m) : []);
const masteryOf = (m) => routineMastery(progress, m.id, learnableSteps(stepsOf(m)).map((s) => s.key));
const sourceTag = (m) => ({ preset: 'Mocap', video: 'From video', mocap: 'Mocap', choreo: 'Choreography' }[m.kind] || 'Routine');

function matches(m) {
    if (query) {
        const hay = `${m.name} ${(m.tags || []).join(' ')} ${sourceTag(m)} ${m.musicName || ''}`.toLowerCase();
        if (!hay.includes(query)) return false;
    }
    if (filter === 'mine') return m.kind !== 'preset';
    if (filter === 'presets') return m.kind === 'preset';
    if (filter === 'favorites') return progress.favorites.includes(m.id);
    if (filter === 'progress') return !!progress.routines[m.id]?.lastPracticedAt;
    return true;
}

function renderLibrary() {
    const list = routines.filter(matches);
    const shown = showAll ? list : list.slice(0, 5);
    $('libraryAll').textContent = showAll ? 'Show less' : `View all${list.length > 5 ? ` (${list.length})` : ''}`;
    $('libraryAll').classList.toggle('hidden', list.length <= 5 && !showAll);
    if (!list.length) {
        $('routineList').innerHTML = `<li class="empty">${query ? 'No routines match your search.' : filter === 'mine' ? 'Nothing uploaded yet — use Upload Video above.' : filter === 'favorites' ? 'Star a routine to keep it here.' : 'Nothing here yet.'}</li>`;
        return;
    }
    $('routineList').innerHTML = shown.map((m) => {
        const fav = progress.favorites.includes(m.id);
        const mastery = analysed(m) ? masteryOf(m) : null;
        const sub = analysed(m) ? `${countsSummary(m).split(' · ')[0]} · ${Math.round(m.rhythm.bpm)} BPM` : 'Analysing…';
        const tags = [sourceTag(m), ...(m.tags || []).filter((t) => t !== sourceTag(m))].slice(0, 2);
        return `<li class="routine${m.id === selectedId ? ' selected' : ''}" data-id="${esc(m.id)}" tabindex="0" role="button" aria-label="Preview ${esc(m.name)}">
<div class="thumb-wrap">${m.thumbnail ? `<img src="${m.thumbnail}" alt="">` : ''}<span class="play">${ICONS.play}</span></div>
<div><b>${esc(m.name)}</b><div class="sub">${esc(sub)}</div><div class="tags">${tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
${mastery && mastery.started ? `<div class="bar accent mini" title="${Math.round(mastery.mastery * 100)}% mastered"><span style="width:${Math.round(mastery.mastery * 100)}%"></span></div>` : ''}</div>
<div class="side-col"><button class="star${fav ? ' on' : ''}" data-fav="${esc(m.id)}" aria-label="${fav ? 'Remove from' : 'Add to'} favorites">${fav ? ICONS.starFilled : ICONS.star}</button>
${m.kind !== 'preset' ? `<button class="remove" data-remove="${esc(m.id)}" aria-label="Remove ${esc(m.name)} from the library">${ICONS.trash}</button>` : ''}</div></li>`;
    }).join('');
}

$('routineList').addEventListener('click', async (e) => {
    const fav = e.target.closest('[data-fav]');
    if (fav) {
        const id = fav.dataset.fav;
        progress.favorites = progress.favorites.includes(id) ? progress.favorites.filter((x) => x !== id) : [...progress.favorites, id];
        saveProgress(progress);
        renderLibrary();
        return;
    }
    const remove = e.target.closest('[data-remove]');
    if (remove) {
        const m = routines.find((r) => r.id === remove.dataset.remove);
        if (m && confirm(`Remove “${m.name}” from your library? Its practice history stays.`)) {
            await deleteRoutine(m.id);
            routines = await listRoutines();
            if (selectedId === m.id) select(defaultRoutineId());
            renderAll();
        }
        return;
    }
    const item = e.target.closest('.routine');
    if (item) select(item.dataset.id);
});
$('routineList').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('routine')) {
        e.preventDefault();
        select(e.target.dataset.id);
    }
});
$('filters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    filter = b.dataset.filter;
    $('filters').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderLibrary();
});
$('libraryAll').addEventListener('click', () => { showAll = !showAll; renderLibrary(); });
$('search').addEventListener('input', (e) => {
    query = e.target.value.trim().toLowerCase();
    showAll = !!query;
    renderLibrary();
});

function defaultRoutineId() {
    const recent = routines
        .map((m) => ({ m, at: progress.routines[m.id]?.lastPracticedAt || 0 }))
        .sort((a, b) => b.at - a.at)[0];
    if (recent && recent.at > 0) return recent.m.id;
    return (routines.find((m) => m.kind !== 'preset') || routines.find((m) => m.id === 'preset:DancingMedium') || routines[0])?.id;
}

// ── Preview of the selected routine ─────────────────────────────────

const transport = new TransportController();
let stage = null;
const timeline = new PracticeTimeline($('pvTimeline'), {
    onSeek: (t) => transport.seek(t),
    onRangeChange: (range) => setPreviewRange(range),
});

$('pvSpeeds').innerHTML = SPEEDS.map((s) => `<button data-speed="${s}" aria-pressed="${s === 1}">${s}×</button>`).join('');
$('pvSpeeds').addEventListener('click', (e) => {
    const b = e.target.closest('[data-speed]');
    if (!b) return;
    transport.setSpeed(Number(b.dataset.speed));
    $('pvSpeeds').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
});
$('pvPlay').addEventListener('click', () => transport.togglePlayPause());
transport.on('play', updatePlay);
transport.on('pause', updatePlay);
transport.on('rangeend', () => { transport.seek(transport.range.start); transport.play(); });
function updatePlay() {
    $('pvPlay').innerHTML = transport.playing ? ICONS.pause : ICONS.play;
    $('pvPlay').setAttribute('aria-label', transport.playing ? 'Pause preview' : 'Play preview');
}
updatePlay();

function sectionIndexAt(t) {
    if (!preview) return -1;
    return preview.sections.findIndex((s) => t >= s.start - 1e-3 && t < s.end - 1e-3);
}
$('pvPrev').addEventListener('click', () => jumpSection(-1));
$('pvNext').addEventListener('click', () => jumpSection(+1));
function jumpSection(dir) {
    if (!preview?.sections.length) return;
    const i = Math.max(0, Math.min(preview.sections.length - 1, sectionIndexAt(transport.currentTime) + dir));
    setPreviewRange(preview.sections[i], i);
}

function setPreviewRange(range, sectionIndex = -1) {
    transport.setRange(range);
    timeline.setRange(range);
    transport.seek(range.start);
    $('sectionChips').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.section) === sectionIndex)));
    const step = sectionIndex >= 0 ? stepsOf(preview.routine.meta).find((s) => s.kind === 'section' && s.index === sectionIndex) : null;
    setPracticeLinks(preview.routine.meta, step?.key);
}

$('sectionChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-section]');
    if (!b || !preview) return;
    const i = Number(b.dataset.section);
    if (i < 0) {
        transport.setRange(null);
        timeline.setRange(null);
        $('sectionChips').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        setPracticeLinks(preview.routine.meta, null);
        return;
    }
    setPreviewRange(preview.sections[i], i);
    if (!transport.playing) transport.play();
});

function setPracticeLinks(meta, stepKey) {
    const step = stepKey ? `&step=${encodeURIComponent(stepKey)}` : '';
    $('practiceButton').href = `practice.html?routine=${encodeURIComponent(meta.id)}${step}`;
    $('compareButton').href = `practice.html?routine=${encodeURIComponent(meta.id)}${step}&input=recording`;
}

async function select(id) {
    if (!id) return;
    selectedId = id;
    renderLibrary();
    const token = ++loadToken;
    transport.pause();
    $('paneEmpty').classList.remove('hidden');
    $('paneEmpty').textContent = 'Loading preview…';
    try {
        const routine = await loadRoutine(id);
        if (token !== loadToken) return;
        // Analysis may just have been stored: refresh the list entry
        const i = routines.findIndex((r) => r.id === id);
        if (i >= 0) routines[i] = routine.meta;
        transport.setRange(null);
        transport.clearAudio();
        if (routine.music) {
            try { await transport.loadAudio(routine.music, routine.musicName || routine.meta.name); } catch (_) { /* silent */ }
        }
        if (token !== loadToken) return;
        stage = stage || new Stage($('previewStage'), { transport });
        stage.setBody(await loadFbx(routine.bodyUrl));
        stage.setChoreography(routine.choreo);
        if (token !== loadToken) return;
        const track = buildReferenceTrack(routine);
        preview = { routine, track, sections: routineSections(routine.meta), bounds: keypointBounds(track) };
        const video = routine.video && routine.capture;
        $('paneVideo').classList.toggle('hidden', !video);
        if (video) $('previewVideo').src = URL.createObjectURL(routine.video);
        else $('previewVideo').removeAttribute('src');
        const wave = transport.audioBuffer ? waveformPeaks(transport.audioBuffer) : null;
        let energy = null;
        if (!wave) {
            const values = trackMotionEnergy(track);
            const sorted = Array.from(values).sort((a, b) => a - b);
            const top = sorted[Math.floor(sorted.length * 0.97)] || 1;
            energy = { values: values.map((v) => Math.min(1, v / top)), rate: track.rate };
        }
        timeline.setData({ duration: routine.meta.duration, rhythm: routine.meta.rhythm, sections: preview.sections, wave, energy });
        timeline.setRange(null);
        $('sectionChips').innerHTML = `<button class="chip" data-section="-1" aria-pressed="true">Whole routine</button>` +
            preview.sections.map((s) => `<button class="chip" data-section="${s.index}" aria-pressed="false">${String.fromCharCode(65 + s.index)} (${s.startBeat + 1}–${s.endBeat})</button>`).join('');
        transport.seek(0);
        renderSession(routine.meta);
        $('paneEmpty').classList.add('hidden');
        renderAll();
    } catch (err) {
        console.error(err);
        if (token === loadToken) $('paneEmpty').textContent = `Could not load this routine: ${err.message}`;
    }
}

function keypointBounds(track) {
    let minX = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    const K = track.keypoints;
    for (let i = 0; i < K.length; i += 3) {
        minX = Math.min(minX, K[i]); maxX = Math.max(maxX, K[i]);
        maxY = Math.max(maxY, K[i + 1]);
    }
    return { minX, maxX, maxY };
}

function renderSession(meta) {
    const resume = getResume(progress, meta.id);
    const steps = stepsOf(meta);
    const step = steps.find((s) => s.key === resume?.stepKey);
    $('sessionKicker').textContent = resume ? 'Current session' : 'Preview';
    $('sessionTitle').textContent = step && step.kind !== 'watch' ? `${meta.name} — ${step.label.replace(/^Learn /, '')}` : meta.name;
    const tags = [
        meta.kind === 'video' ? `${ICONS.film} From video` : `${ICONS.motion} ${sourceTag(meta)}`,
        countsSummary(meta),
        `${ICONS.metronome} ${Math.round(meta.rhythm.bpm)} BPM`,
        meta.hasMusic || meta.musicFromVideo ? `${ICONS.music} ${esc(meta.musicName || 'With music')}` : 'No music',
    ];
    $('sessionTags').innerHTML = tags.filter(Boolean).map((t) => `<span class="chip">${t}</span>`).join('');
    setPracticeLinks(meta, resume?.stepKey);
    $('practiceButton').innerHTML = `${ICONS.pose}${resume ? 'Resume practice' : 'Practice Mode'}`;
}

// Kinematic data pane: the motion as tracked points, with a short trail of the hands and feet
function drawKinematic() {
    const { ctx, width, height } = prepareCanvas($('kinematicCanvas'));
    if (!preview) return;
    const { track, bounds } = preview;
    const t = transport.animationTime || transport.currentTime;
    const span = Math.max(1.4, bounds.maxX - bounds.minX + 0.8);
    const scale = Math.min(width / span, (height * 0.92) / (bounds.maxY + 0.15));
    const cx = (bounds.minX + bounds.maxX) / 2;
    const ground = height * 0.95;
    const project = (kp, k) => [width / 2 + (kp[k * 3] - cx) * scale, ground - kp[k * 3 + 1] * scale];
    // Floor grid
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.12)';
    ctx.lineWidth = 1;
    for (let x = -3; x <= 3; x++) {
        ctx.beginPath();
        ctx.moveTo(width / 2 + x * scale * 0.5, ground);
        ctx.lineTo(width / 2 + x * scale * 1.2, height);
        ctx.stroke();
    }
    // Trails
    for (const k of [KP.leftWrist, KP.rightWrist, KP.leftAnkle, KP.rightAnkle]) {
        ctx.beginPath();
        for (let i = 0; i <= 24; i++) {
            const kp = sampleTrackKeypoints(track, Math.max(0, t - (24 - i) * 0.03));
            const [x, y] = project(kp, k);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = 'rgba(34, 211, 238, 0.35)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }
    const kp = sampleTrackKeypoints(track, t);
    const points = Array.from({ length: KP_COUNT }, (_, k) => project(kp, k));
    drawSkeleton2D(ctx, points, { color: '#67e8f9', glow: 'rgba(34, 211, 238, 0.6)', lineWidth: Math.max(2, scale * 0.02) });
}

function drawVideoOverlay() {
    const capture = preview?.routine.capture;
    const video = $('previewVideo');
    const { ctx, box } = prepareCanvas($('previewVideoOverlay'), video, 'cover');
    if (!capture || !preview.routine.video) return;
    const f = Math.max(0, Math.min(capture.frameCount - 1, Math.floor(video.currentTime * capture.fps)));
    const lm = capture.image[f];
    if (lm) drawSkeleton2D(ctx, toBox(imagePoints(lm, 1, 1), box), { color: COLORS.reference, lineWidth: Math.max(2, box.height / 200) });
}

function syncPreviewVideo() {
    const video = $('previewVideo');
    if (!preview?.routine.video || !video.src) return;
    const t = Math.min(transport.currentTime, preview.routine.capture.duration - 0.02);
    if (Math.abs(video.currentTime - t) > 0.12) video.currentTime = t;
    video.playbackRate = transport.speed;
    if (transport.playing && video.paused) video.play().catch(() => {});
    if (!transport.playing && !video.paused) video.pause();
}

// ── Progress cards ──────────────────────────────────────────────────

function renderProgress() {
    const meta = routines.find((r) => r.id === selectedId);
    const week = weeklyStats(progress);
    const m = meta && analysed(meta) ? masteryOf(meta) : { mastery: 0, mastered: 0, total: 0, started: false };
    setRing($('masteryRing').querySelector('svg'), m.mastery);
    $('masteryValue').textContent = m.started ? `${Math.round(m.mastery * 100)}%` : '—';
    $('statLearned').textContent = m.total ? `${m.mastered} / ${m.total}` : '—';
    $('barLearned').style.width = m.total ? `${(m.mastered / m.total) * 100}%` : '0';
    $('statTime').textContent = fmtDuration(week.practiceSeconds);
    $('statSync').textContent = week.avgScore == null ? '—' : `${Math.round(week.avgScore)}%`;
    $('barSync').style.width = `${week.avgScore ?? 0}%`;
    $('masteryNote').textContent = meta
        ? m.started ? `Mastery of ${meta.name}: sections and the full routine learned at full tempo.` : `You haven’t practised ${meta.name} yet.`
        : '';

    // Session trend
    const trend = sessionTrend(progress);
    if (!trend.last) {
        $('syncBig').textContent = '—';
        $('syncTrend').textContent = 'Score a pass in the Practice Studio to see your trend.';
        $('syncChart').innerHTML = '';
    } else {
        $('syncBig').textContent = `${Math.round(trend.last.avgScore)}%`;
        $('syncTrend').innerHTML = trend.delta == null
            ? 'Your latest session'
            : `<span class="${trend.delta >= 0 ? 'good' : 'bad'}">${trend.delta >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(trend.delta))}%</span> vs. last session`;
        $('syncChart').innerHTML = lineChart(trend.sessions.slice(-8).map((s) => s.avgScore), $('syncChart').clientWidth || 320);
    }

    // History
    const items = recentAttempts(progress, historyAll ? 25 : 5);
    $('historyAll').classList.toggle('hidden', progress.attempts.length <= 5);
    $('historyAll').textContent = historyAll ? 'Show less' : 'View all';
    $('historyList').innerHTML = items.length
        ? items.map((a) => `<li><span class="when">${esc(fmtDay(a.at))}</span><span class="what" title="${esc(a.routineName)} — ${esc(a.stepLabel)} at ${a.tempo}×">${esc(a.routineName)} – ${esc(a.stepLabel.replace(/^Learn /, ''))}</span><span class="score ${scoreClass(a.score)}">${a.score}%</span></li>`).join('')
        : '<li class="empty">No scored passes yet.</li>';

    // Next up
    const candidates = routines.filter(analysed).map((r) => ({ id: r.id, name: r.name, steps: stepsOf(r) }));
    const next = recommendNext(progress, candidates);
    if (!next) {
        $('nextUp').innerHTML = '<p class="empty">Add a routine to get started.</p>';
    } else {
        const r = routines.find((x) => x.id === next.routineId);
        const step = stepsOf(r).find((s) => s.key === next.stepKey);
        const rec = stepRecord(progress, r.id, next.stepKey);
        $('nextUp').innerHTML = `<div class="next-item">${r.thumbnail ? `<img src="${r.thumbnail}" alt="">` : ''}<div><b>${esc(r.name)} – ${esc(next.label.replace(/^Learn /, ''))}</b>
<small>${esc(next.reason)}</small><small class="muted">${step ? `${step.endBeat - step.startBeat || ''} counts · ${Math.round((step.end - step.start))} s` : ''}${rec?.bestScore != null ? ` · best ${rec.bestScore}%` : ''}</small></div></div>
<a class="btn primary block" href="practice.html?routine=${encodeURIComponent(r.id)}&step=${encodeURIComponent(next.stepKey)}">${ICONS.play}Start Practice</a>`;
    }
    $('navLearn').href = next ? `practice.html?routine=${encodeURIComponent(next.routineId)}&step=${encodeURIComponent(next.stepKey)}` : 'practice.html';
}

$('historyAll').addEventListener('click', () => { historyAll = !historyAll; renderProgress(); });
new ResizeObserver(() => { if (progress.attempts.length) renderProgress(); }).observe($('syncChart'));

function lineChart(values, w = 320) {
    const h = 130;
    const pad = { l: 34, r: 8, t: 8, b: 8 };
    const lo = Math.max(0, Math.min(60, Math.floor((Math.min(...values) - 5) / 10) * 10));
    const x = (i) => pad.l + (values.length === 1 ? (w - pad.l - pad.r) / 2 : (i / (values.length - 1)) * (w - pad.l - pad.r));
    const y = (v) => pad.t + (1 - (v - lo) / (100 - lo)) * (h - pad.t - pad.b);
    const ticks = [];
    for (let v = lo; v <= 100; v += (100 - lo) / 4) ticks.push(Math.round(v));
    const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const area = `${line}L${x(values.length - 1).toFixed(1)},${h - pad.b}L${x(0).toFixed(1)},${h - pad.b}Z`;
    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Average score of your last ${values.length} sessions: ${values.map((v) => Math.round(v)).join(', ')}">
<defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a855f7" stop-opacity="0.45"/><stop offset="1" stop-color="#a855f7" stop-opacity="0"/></linearGradient></defs>
${ticks.map((v) => `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(255,255,255,0.08)"/><text x="${pad.l - 6}" y="${y(v) + 4}" fill="#8f88ad" font-size="10" text-anchor="end">${v}%</text>`).join('')}
${values.length > 1 ? `<path d="${area}" fill="url(#area)"/><path d="${line}" fill="none" stroke="#c084fc" stroke-width="2.5" stroke-linejoin="round"/>` : ''}
${values.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="#e9d5ff" stroke="#7c3aed" stroke-width="2"><title>${Math.round(v)}%</title></circle>`).join('')}</svg>`;
}

// ── Upload → convert → practise ─────────────────────────────────────

let importJob = null;

function setPipe(step, status, note = null, fraction = null) {
    const stateEl = $(`pipe${step}State`);
    if (stateEl) {
        stateEl.className = `pipe-state ${status === 'done' ? 'done' : status === 'busy' ? 'busy' : ''}`;
        stateEl.innerHTML = status === 'done' ? ICONS.check : '';
    }
    if (note != null) $(`pipe${step}Note`).textContent = note;
    if (step === 'Convert') {
        $('pipeProgress').classList.toggle('hidden', fraction == null);
        if (fraction != null) $('pipeProgress').firstElementChild.style.width = `${Math.round(fraction * 100)}%`;
    }
}

$('pipeUpload').addEventListener('click', () => $('uploadInput').click());
$('navUpload').addEventListener('click', (e) => { e.preventDefault(); $('uploadInput').click(); });
$('uploadInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) handleUpload(file);
});
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && importJob) importJob.abort(); });

async function handleUpload(file) {
    if (importJob) { toast('A conversion is already running.'); return; }
    const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv)$/i.test(file.name);
    setPipe('Upload', 'done', file.name);
    setPipe('Convert', 'busy', isVideo ? 'Loading pose model… (Esc to cancel)' : 'Reading the file…', isVideo ? 0 : null);
    importJob = new AbortController();
    try {
        const meta = isVideo
            ? await importVideo(file, {
                signal: importJob.signal,
                onProgress: (stage, fraction) => setPipe('Convert', 'busy', `${stage}… ${Math.round(fraction * 100)}%`, fraction),
            })
            : await importDanceFile(file);
        setPipe('Convert', 'done', `${countsSummary(meta)} · ${Math.round(meta.rhythm.bpm)} BPM${meta.detectedFrames != null && meta.frameCount ? ` · dancer found in ${Math.round((meta.detectedFrames / meta.frameCount) * 100)}% of frames` : ''}`, null);
        $('pipeLearn').href = `practice.html?routine=${encodeURIComponent(meta.id)}`;
        $('pipeLearnNote').textContent = `Practise “${meta.name}” now`;
        routines = await listRoutines();
        filter = 'all';
        await select(meta.id);
        toast(`“${meta.name}” is in your library.`, { tone: 'good' });
    } catch (err) {
        console.error(err);
        const cancelled = err.name === 'AbortError';
        setPipe('Convert', '', cancelled ? 'Cancelled' : `Could not convert: ${err.message}`, null);
        if (!cancelled) toast(`Could not convert ${file.name}: ${err.message}`, { tone: 'bad', ms: 7000 });
    } finally {
        importJob = null;
    }
}

// ── Background analysis of routines not analysed yet ────────────────

async function analyseRemaining() {
    for (const m of routines) {
        if (analysed(m) && m.thumbnail) continue;
        try {
            const routine = await loadRoutine(m.id);
            const i = routines.findIndex((r) => r.id === m.id);
            if (i >= 0) routines[i] = routine.meta;
            renderLibrary();
            renderProgress();
        } catch (err) {
            console.warn(`Could not analyse ${m.name}:`, err);
        }
    }
}

// ── Frame loop ──────────────────────────────────────────────────────

let last = performance.now();
function animate(now) {
    requestAnimationFrame(animate);
    transport.tick(Math.min(0.1, (now - last) / 1000));
    last = now;
    if (!preview) return;
    syncPreviewVideo();
    stage?.render();
    drawKinematic();
    drawVideoOverlay();
    timeline.setTime(transport.currentTime);
    const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
    $('pvTime').textContent = `${fmt(transport.currentTime)} / ${fmt(preview.routine.meta.duration)}`;
}

function renderAll() {
    renderLibrary();
    renderProgress();
}

async function init() {
    routines = await listRoutines();
    renderAll();
    if (location.hash === '#upload') $('pipeUpload').focus();
    await select(defaultRoutineId());
    requestAnimationFrame(animate);
    analyseRemaining();
}

init();
