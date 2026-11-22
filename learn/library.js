// AutoChoreo — Choreography library
//
// Every routine the dancer can learn: the built-in mocap dances (TEST_DATA),
// dances learned from their videos, and choreography / sequence files or FBX
// mocap they import. Imported routines are stored in the browser (IndexedDB)
// with everything practice needs later — the choreography, the source video
// and its tracked landmarks, the soundtrack — so they are there next time.
//
// Each routine also gets analysed once: its tempo and count 1 (from the music
// when there is any, otherwise from the movement), and a stick-figure
// thumbnail drawn from its own motion.

import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { Choreography } from '../choreo/choreography.js';
import { prepareRig, choreographyFromClip } from '../choreo/retarget.js';
import { solveChoreography } from '../choreo/solver.js';
import { extractPoseFromVideo } from '../choreo/poseExtractor.js';
import { isSequenceJSON, sequenceFromJSON, compileSequence } from '../choreo/sequence.js';
import {
    referenceTrackFromChoreography, referenceTrackFromCapture, sampleTrackKeypoints, KP_BONES, KP_COUNT,
    NEUTRAL_FEATURES, FEATURE_SIZE, SEG_COUNT, SEGMENT_WEIGHTS, unitAngle,
} from '../choreo/compare.js';
import { audioOnsetEnvelope, motionOnsetEnvelope, analyzeEnvelope, mixToMono } from '../choreo/rhythm.js';

export const PRESETS = [
    { file: 'DancingMedium_mixamo.fbx', name: 'Dancing Medium', tags: ['Groove'] },
    { file: 'DoTheRobot_mixamo.fbx', name: 'Do The Robot', tags: ['Popping'] },
    { file: 'DoTheTwist_mixamo.fbx', name: 'Do The Twist', tags: ['Retro'] },
    { file: 'GentleSwayingDancing_mixamo.fbx', name: 'Gentle Swaying', tags: ['Foundation'] },
    { file: 'DancingwithDrink_mixamo.fbx', name: 'Dancing with Drink', tags: ['Party'] },
    { file: 'NPC_DancingParty_mixamo.fbx', name: 'NPC Dancing Party', tags: ['Party'] },
];
const DATA_DIR = new URL('../TEST_DATA/', import.meta.url).href;
export const DEFAULT_BODY_URL = `${DATA_DIR}DancingMedium_mixamo.fbx`;
const ANALYSIS_VERSION = 3; // bump to re-analyse stored routines after analysis changes

// ── IndexedDB ───────────────────────────────────────────────────────

const DB_NAME = 'autochoreo';
let dbPromise = null;
function openDb() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('routines')) db.createObjectStore('routines', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('payloads')) db.createObjectStore('payloads', { keyPath: 'id' });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
}

async function tx(store, mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req ? req.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('Storage transaction aborted'));
    });
}
const dbGet = (store, key) => tx(store, 'readonly', (s) => s.get(key));
const dbPut = (store, value) => tx(store, 'readwrite', (s) => s.put(value));
const dbDelete = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));
const dbAll = (store) => tx(store, 'readonly', (s) => s.getAll());

// ── Listing ─────────────────────────────────────────────────────────

const presetId = (p) => `preset:${p.file.replace(/_mixamo\.fbx$|\.fbx$/i, '')}`;

function presetMeta(p) {
    return {
        id: presetId(p), kind: 'preset', name: p.name, tags: p.tags, source: { fbx: `${DATA_DIR}${p.file}` },
        createdAt: 0, duration: null, rhythm: null, hasVideo: false, hasMusic: false, thumbnail: null,
    };
}

/** All routines: presets first (with any stored analysis), then the dancer's own, newest first. */
export async function listRoutines() {
    let stored = [];
    try {
        stored = await dbAll('routines');
    } catch (err) {
        console.warn('Library storage unavailable:', err);
    }
    const byId = new Map(stored.map((m) => [m.id, m]));
    const presets = PRESETS.map((p) => ({ ...presetMeta(p), ...(byId.get(presetId(p)) || {}) }));
    const own = stored.filter((m) => m.kind !== 'preset').sort((a, b) => b.createdAt - a.createdAt);
    return [...own, ...presets];
}

export async function getRoutineMeta(id) {
    const preset = PRESETS.find((p) => presetId(p) === id);
    let stored = null;
    try { stored = await dbGet('routines', id); } catch (_) { /* storage unavailable */ }
    if (preset) return { ...presetMeta(preset), ...(stored || {}) };
    return stored || null;
}

export async function saveRoutineMeta(meta) {
    await dbPut('routines', meta);
    return meta;
}

export async function deleteRoutine(id) {
    await dbDelete('routines', id);
    await dbDelete('payloads', id);
}

/** Override a routine's tempo / count 1 (the dancer knows better than the estimate). */
export async function setRoutineRhythm(id, rhythm) {
    const meta = await getRoutineMeta(id);
    if (!meta) throw new Error('Unknown routine');
    meta.rhythm = { ...meta.rhythm, ...rhythm, source: 'manual' };
    return saveRoutineMeta(meta);
}

// ── Loading ─────────────────────────────────────────────────────────

const fbxLoader = new FBXLoader();
const fbxCache = new Map(); // url → Promise<THREE.Group>

/** Load an FBX once per page (it is both a body to render and, for presets, the dance). */
export function loadFbx(url) {
    if (!fbxCache.has(url)) {
        const job = fbxLoader.loadAsync(url).then((fbx) => {
            prepareRig(fbx); // record the rest pose before anything animates it
            return fbx;
        });
        job.catch(() => fbxCache.delete(url));
        fbxCache.set(url, job);
    }
    return fbxCache.get(url);
}

function choreographyFromFbx(fbx, name) {
    if (!fbx.animations || !fbx.animations.length) throw new Error('This FBX contains no animation');
    return choreographyFromClip(fbx.animations[0], fbx, { name });
}

/**
 * Everything needed to practise a routine.
 * @returns {Promise<{ meta, choreo, capture, video: Blob|null, music: Blob|null, musicName, bodyUrl }>}
 */
export async function loadRoutine(id) {
    const meta = await getRoutineMeta(id);
    if (!meta) throw new Error('This routine is no longer in your library');
    if (meta.kind === 'preset') {
        const fbx = await loadFbx(meta.source.fbx);
        const choreo = choreographyFromFbx(fbx, meta.name);
        const routine = { meta, choreo, capture: null, video: null, music: null, musicName: null, bodyUrl: meta.source.fbx };
        await ensureAnalysis(routine);
        return routine;
    }
    const payload = await dbGet('payloads', id);
    if (!payload) throw new Error('This routine’s data is missing from this browser');
    const routine = {
        meta,
        choreo: Choreography.fromJSON(payload.choreo),
        capture: payload.capture || null,
        video: payload.video || null,
        music: payload.music || (meta.musicFromVideo ? payload.video : null),
        musicName: meta.musicName || null,
        bodyUrl: DEFAULT_BODY_URL,
    };
    await ensureAnalysis(routine);
    return routine;
}

// ── Analysis: duration, rhythm, thumbnail ───────────────────────────

let audioCtx = null;
async function decodeAudio(blob) {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx.decodeAudioData(await blob.arrayBuffer());
}

/** The reference track to compare against: the source video's landmarks if known, else the choreography. */
export function buildReferenceTrack(routine, { mirror = false } = {}) {
    if (routine.capture) {
        const track = referenceTrackFromCapture(routine.capture, { mirror, root: routine.choreo });
        if (track) return track;
    }
    return referenceTrackFromChoreography(routine.choreo, { mirror });
}

async function ensureAnalysis(routine) {
    const { meta } = routine;
    const manual = meta.rhythm && meta.rhythm.source === 'manual';
    if (meta.analysisVersion === ANALYSIS_VERSION && meta.duration && meta.rhythm && meta.thumbnail) return meta;
    meta.duration = routine.choreo.duration;
    meta.fps = routine.choreo.fps;
    const track = buildReferenceTrack(routine);
    if (!manual) {
        let rhythm = null;
        if (meta.sequenceTempo) {
            rhythm = { bpm: meta.sequenceTempo.bpm, offset: meta.sequenceTempo.offset, confidence: 1, source: 'sequence' };
        } else if (routine.music) {
            try {
                const buffer = await decodeAudio(routine.music);
                const env = audioOnsetEnvelope(mixToMono(buffer), buffer.sampleRate);
                rhythm = { ...analyzeEnvelope(env), source: 'music' };
            } catch (err) {
                console.warn('Could not analyse the music:', err);
            }
        }
        if (!rhythm) rhythm = { ...analyzeEnvelope(motionOnsetEnvelope(track)), source: 'movement' };
        meta.rhythm = rhythm;
    }
    meta.thumbnail = drawThumbnail(track);
    meta.analysisVersion = ANALYSIS_VERSION;
    try {
        await saveRoutineMeta(meta);
    } catch (err) {
        console.warn('Could not store routine analysis:', err);
    }
    return meta;
}

/** The most expressive moment of a dance: the frame furthest from a neutral stance. */
function signatureTime(track) {
    let best = track.duration / 2;
    let bestValue = -1;
    const step = Math.max(1, Math.floor(track.frameCount / 60));
    for (let f = 0; f < track.frameCount; f += step) {
        let v = 0;
        for (let s = 0; s < SEG_COUNT; s++) v += SEGMENT_WEIGHTS[s] * unitAngle(track.features, f * FEATURE_SIZE + s * 3, NEUTRAL_FEATURES, s * 3);
        if (v > bestValue) { bestValue = v; best = f / track.rate; }
    }
    return best;
}

/** A small stick-figure image of the dance's most expressive moment. */
export function drawThumbnail(track, { width = 160, height = 160 } = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const bg = ctx.createLinearGradient(0, 0, width, height);
    bg.addColorStop(0, '#2a1650');
    bg.addColorStop(1, '#0d0a1f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);
    const kp = sampleTrackKeypoints(track, signatureTime(track));
    drawStickFigure(ctx, kp, { width, height, color: '#c9a5ff', joint: '#ffffff' });
    return canvas.toDataURL('image/png');
}

/** Draw canonical keypoints (front view) fitted into a box. */
export function drawStickFigure(ctx, kp, { width, height, color = '#b388ff', joint = '#fff', lineWidth = null, x0 = 0, y0 = 0, scale = null, center = null }) {
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (let k = 0; k < KP_COUNT; k++) {
        minX = Math.min(minX, kp[k * 3]); maxX = Math.max(maxX, kp[k * 3]);
        minY = Math.min(minY, kp[k * 3 + 1]); maxY = Math.max(maxY, kp[k * 3 + 1]);
    }
    const s = scale ?? Math.min(width / (maxX - minX + 0.6), height / (maxY - minY + 0.5));
    const cx = center ? center[0] : (minX + maxX) / 2;
    const cy = center ? center[1] : (minY + maxY) / 2;
    const px = (k) => [x0 + width / 2 + (kp[k * 3] - cx) * s, y0 + height / 2 - (kp[k * 3 + 1] - cy) * s];
    ctx.lineCap = 'round';
    ctx.lineWidth = lineWidth ?? Math.max(2, s * 0.035);
    ctx.strokeStyle = color;
    ctx.beginPath();
    for (const [a, b] of KP_BONES) {
        ctx.moveTo(...px(a));
        ctx.lineTo(...px(b));
    }
    // neck to head
    const ls = px(1); const rs = px(2); const nose = px(0);
    ctx.moveTo((ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2);
    ctx.lineTo(nose[0], nose[1]);
    ctx.stroke();
    ctx.fillStyle = joint;
    for (let k = 1; k < KP_COUNT; k++) {
        const [x, y] = px(k);
        ctx.beginPath();
        ctx.arc(x, y, ctx.lineWidth * 0.75, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(nose[0], nose[1], ctx.lineWidth * 2.2, 0, Math.PI * 2);
    ctx.stroke();
}

// ── Importing ───────────────────────────────────────────────────────

const newId = (kind) => `${kind}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const baseName = (name) => String(name || 'Routine').split(/[\\/]/).pop().replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();

async function storeRoutine(meta, payload) {
    await dbPut('payloads', { id: meta.id, ...payload });
    await dbPut('routines', meta);
    return meta;
}

function compactCapture(capture) {
    return {
        name: capture.name, fps: capture.fps, frameCount: capture.frameCount, duration: capture.duration,
        width: capture.width, height: capture.height, world: capture.world, image: capture.image,
    };
}

/**
 * Learn a routine from a dance video: track the dancer, solve the choreography,
 * keep the video, its landmarks and its soundtrack.
 * @param {File} file
 * @param {{ onProgress?: (stage: string, fraction: number) => void, signal?: AbortSignal }} [o]
 */
export async function importVideo(file, { onProgress = () => {}, signal } = {}) {
    const capture = await extractPoseFromVideo(file, {
        signal,
        onProgress: ({ stage, fraction }) => onProgress(stage, fraction),
    });
    onProgress('Converting to motion data', 1);
    await new Promise((r) => setTimeout(r, 0));
    const choreo = solveChoreography(capture);
    choreo.name = baseName(file.name);
    let hasMusic = false;
    try {
        await decodeAudio(file);
        hasMusic = true;
    } catch (_) { /* silent video */ }
    const meta = {
        id: newId('video'), kind: 'video', name: choreo.name, tags: ['From video'], createdAt: Date.now(),
        hasVideo: true, hasMusic, musicFromVideo: hasMusic, musicName: hasMusic ? file.name : null,
        detectedFrames: choreo.source.detectedFrames, frameCount: capture.frameCount,
    };
    await storeRoutine(meta, { choreo: choreo.toJSON(), capture: compactCapture(capture), video: file, music: null });
    onProgress('Analysing rhythm', 1);
    await loadRoutine(meta.id); // runs the analysis and stores it
    return getRoutineMeta(meta.id);
}

/** Import a choreography (.json), a sequence (.json) or a mocap FBX. */
export async function importDanceFile(file) {
    const lower = file.name.toLowerCase();
    let choreo;
    let sequenceTempo = null;
    let kind = 'choreo';
    let tags = ['Imported'];
    if (lower.endsWith('.fbx')) {
        const fbx = new FBXLoader().parse(await file.arrayBuffer(), '');
        prepareRig(fbx);
        choreo = choreographyFromFbx(fbx, baseName(file.name));
        kind = 'mocap';
        tags = ['Mocap'];
    } else if (lower.endsWith('.json')) {
        const data = JSON.parse(await file.text());
        if (isSequenceJSON(data)) {
            const seq = sequenceFromJSON(data);
            const compiled = compileSequence(seq);
            if (!compiled) throw new Error('This sequence has no clips');
            choreo = compiled.choreo;
            sequenceTempo = { bpm: seq.tempo.bpm, offset: seq.tempo.offset };
            tags = ['Sequence'];
        } else {
            choreo = Choreography.fromJSON(data);
        }
    } else {
        throw new Error('Choose a dance video, a choreography .json or a mocap .fbx');
    }
    const meta = {
        id: newId(kind), kind, name: choreo.name || baseName(file.name), tags, createdAt: Date.now(),
        hasVideo: false, hasMusic: false, sequenceTempo,
    };
    await storeRoutine(meta, { choreo: choreo.toJSON(), capture: null, video: null, music: null });
    await loadRoutine(meta.id);
    return getRoutineMeta(meta.id);
}

/**
 * Add the dance currently open in the Choreograph view to the library.
 * @param {object} o { choreo, name, music?: Blob, musicName?, video?: Blob, capture?, sequenceTempo? }
 */
export async function addRoutine({ choreo, name, music = null, musicName = null, video = null, capture = null, sequenceTempo = null }) {
    const meta = {
        id: newId('choreo'), kind: video ? 'video' : 'choreo', name: name || choreo.name, createdAt: Date.now(),
        tags: [sequenceTempo ? 'Sequence' : video ? 'From video' : 'Choreograph'],
        hasVideo: !!video, hasMusic: !!music, musicName, sequenceTempo,
    };
    await storeRoutine(meta, { choreo: choreo.toJSON(), capture: capture ? compactCapture(capture) : null, video, music });
    await loadRoutine(meta.id);
    return getRoutineMeta(meta.id);
}
