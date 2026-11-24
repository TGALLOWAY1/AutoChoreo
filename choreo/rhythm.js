// AutoChoreo — Rhythm: tempo, beats and counts
//
// Dancers learn in counts: "5, 6, 7, 8" and phrases of eight. To cut a routine
// into teachable sections that line up with the music, we need its tempo and
// where count 1 falls. This module estimates both from an "onset envelope" — a
// curve that peaks where something rhythmic happens:
//
//   music  → spectral flux (energy appearing in the spectrum: drum hits, notes)
//   motion → moments where the dancer's movement stops or hits (for dances
//            without music, e.g. mocap clips)
//
//   envelope ──► autocorrelation ──► tempo (BPM) ──► comb over phases ──► first beat
//
// It assumes a steady tempo (true for most dance tracks). Estimates are only a
// starting point: the UI shows where they came from and lets the dancer
// correct the BPM or move count 1.

import { trackMotionEnergy } from './compare.js';

// ── FFT (radix-2, in place) ─────────────────────────────────────────

export function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = (-2 * Math.PI) / len;
        const wr = Math.cos(ang);
        const wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1;
            let ci = 0;
            for (let k = 0; k < len / 2; k++) {
                const a = i + k;
                const b = a + len / 2;
                const xr = re[b] * cr - im[b] * ci;
                const xi = re[b] * ci + im[b] * cr;
                re[b] = re[a] - xr;
                im[b] = im[a] - xi;
                re[a] += xr;
                im[a] += xi;
                const t = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = t;
            }
        }
    }
}

// ── Onset envelopes ─────────────────────────────────────────────────

/** Mono samples from an AudioBuffer (or anything with numberOfChannels / getChannelData). */
export function mixToMono(buffer) {
    const n = buffer.length;
    const out = new Float32Array(n);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
        const data = buffer.getChannelData(c);
        for (let i = 0; i < n; i++) out[i] += data[i] / buffer.numberOfChannels;
    }
    return out;
}

/** Remove the slowly varying part and keep what rises above it, then scale to unit peak. */
function normalizeEnvelope(env, rate, windowSeconds = 0.5) {
    const n = env.length;
    const out = new Float32Array(n);
    const r = Math.max(1, Math.round(windowSeconds * rate / 2));
    let sum = 0;
    let count = 0;
    let lo = 0;
    let hi = -1;
    for (let i = 0; i < n; i++) {
        while (hi < Math.min(n - 1, i + r)) { hi++; sum += env[hi]; count++; }
        while (lo < i - r) { sum -= env[lo]; lo++; count--; }
        out[i] = Math.max(0, env[i] - sum / count);
    }
    let max = 0;
    for (let i = 0; i < n; i++) max = Math.max(max, out[i]);
    if (max > 0) for (let i = 0; i < n; i++) out[i] /= max;
    return out;
}

/**
 * Spectral-flux onset envelope of a mono signal, overall and per frequency band
 * (bass, low-mids … highs). The bands keep apart what the instruments do, which
 * the overall envelope blurs together — useful for lining recordings up.
 * @returns {{ envelope: Float32Array, bands: Float32Array[], rate: number, start: number }}
 *   rate = envelope samples per second; start = time (s) of envelope sample 0
 */
export function audioOnsetEnvelope(samples, sampleRate, { size = 1024, hop = 256, bandCount = 6 } = {}) {
    // Above ~30 kHz, halve the rate: beats live well below 11 kHz
    let x = samples;
    let sr = sampleRate;
    while (sr > 30000) {
        const half = new Float32Array(x.length >> 1);
        for (let i = 0; i < half.length; i++) half[i] = (x[2 * i] + x[2 * i + 1]) / 2;
        x = half;
        sr /= 2;
    }
    const frames = Math.max(0, Math.floor((x.length - size) / hop) + 1);
    const envelope = new Float32Array(frames);
    const window = new Float32Array(size);
    for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    const re = new Float32Array(size);
    const im = new Float32Array(size);
    const bins = size / 2;
    // Log-spaced band edges from ~60 Hz to Nyquist
    const lowBin = Math.max(1, Math.round((60 / sr) * size));
    const edges = Array.from({ length: bandCount + 1 }, (_, b) => Math.round(lowBin * (bins / lowBin) ** (b / bandCount)));
    const bandOf = new Int8Array(bins).fill(-1);
    for (let b = 0; b < bandCount; b++) for (let k = edges[b]; k < edges[b + 1]; k++) bandOf[k] = b;
    const bands = Array.from({ length: bandCount }, () => new Float32Array(frames));
    let prev = new Float32Array(bins);
    let cur = new Float32Array(bins);
    for (let f = 0; f < frames; f++) {
        const o = f * hop;
        for (let i = 0; i < size; i++) { re[i] = x[o + i] * window[i]; im[i] = 0; }
        fft(re, im);
        let flux = 0;
        for (let k = 1; k < bins; k++) {
            cur[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
            if (f > 0) {
                const d = Math.max(0, cur[k] - prev[k]);
                flux += d;
                if (bandOf[k] >= 0) bands[bandOf[k]][f] += d;
            }
        }
        envelope[f] = flux;
        [prev, cur] = [cur, prev];
    }
    const rate = sr / hop;
    // A frame's flux is the change from the previous frame; an onset shows up
    // once it is inside the window, so date each frame by its window's centre.
    return {
        envelope: normalizeEnvelope(envelope, rate),
        bands: bands.map((band) => normalizeEnvelope(band, rate)),
        rate,
        start: size / 2 / sr,
    };
}

/**
 * Onset envelope of a dance's movement (a reference track from ./compare.js):
 * peaks where the body's motion drops below its local average — the stops and
 * hits dancers place on the beat.
 */
export function motionOnsetEnvelope(track) {
    const speed = trackMotionEnergy(track);
    const rate = track.rate;
    // Light smoothing so pose noise does not read as stops
    const sm = new Float32Array(speed.length);
    for (let i = 0; i < speed.length; i++) {
        let s = 0;
        let c = 0;
        for (let k = -1; k <= 1; k++) {
            const j = i + k;
            if (j >= 0 && j < speed.length) { s += speed[j]; c++; }
        }
        sm[i] = s / c;
    }
    const inverted = new Float32Array(sm.length);
    let max = 0;
    for (let i = 0; i < sm.length; i++) max = Math.max(max, sm[i]);
    for (let i = 0; i < sm.length; i++) inverted[i] = max - sm[i];
    return { envelope: normalizeEnvelope(inverted, rate, 0.6), rate, start: 0 };
}

// ── Tempo and beat phase ────────────────────────────────────────────

function gaussianBlur(data, sigma) {
    if (!(sigma > 0.3)) return data;
    const r = Math.ceil(sigma * 3);
    const kernel = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-0.5 * ((i - r) / sigma) ** 2));
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
        let s = 0;
        let w = 0;
        for (let k = -r; k <= r; k++) {
            const j = i + k;
            if (j < 0 || j >= data.length) continue;
            s += kernel[k + r] * data[j];
            w += kernel[k + r];
        }
        out[i] = s / w;
    }
    return out;
}

/** Linear interpolation into an envelope at a fractional index (0 outside). */
function at(env, x) {
    if (x < 0 || x > env.length - 1) return 0;
    const i = Math.floor(x);
    const t = x - i;
    return i + 1 < env.length ? env[i] * (1 - t) + env[i + 1] * t : env[i];
}

/**
 * Estimate the tempo of an onset envelope by autocorrelation. Periods that
 * also line up at double length are favoured (they are the real beat, not a
 * subdivision), and a broad preference around `centerBpm` resolves the
 * remaining half/double-time ambiguity the way most dance counting does.
 *
 * @returns {{ bpm: number, confidence: number }}  confidence 0–1 (how periodic)
 */
export function estimateTempo(env, rate, { minBpm = 70, maxBpm = 180, centerBpm = 115, octaveWidth = 0.9 } = {}) {
    const n = env.length;
    if (n < rate * 2) return { bpm: centerBpm, confidence: 0 };
    // Onset spikes are a frame or two wide; widen them so the autocorrelation
    // still peaks when the beat period falls between two whole-frame lags.
    const smooth = gaussianBlur(env, 0.02 * rate);
    let mean = 0;
    for (let i = 0; i < n; i++) mean += smooth[i];
    mean /= n;
    const x = Float32Array.from(smooth, (v) => v - mean);
    const minLag = Math.floor((60 / maxBpm) * rate);
    const maxLag = Math.min(n - 1, Math.ceil((60 / minBpm) * rate * 2));
    const ac = new Float32Array(maxLag + 2);
    let zero = 0;
    for (let i = 0; i < n; i++) zero += x[i] * x[i];
    if (zero <= 0) return { bpm: centerBpm, confidence: 0 };
    for (let lag = 1; lag <= maxLag + 1 && lag < n; lag++) {
        let s = 0;
        for (let i = lag; i < n; i++) s += x[i] * x[i - lag];
        ac[lag] = s / zero * (n / (n - lag)); // unbiased
    }
    const acAt = (l) => at(ac, l);
    let best = -Infinity;
    let bestLag = minLag;
    const upper = Math.min(maxLag, Math.ceil((60 / minBpm) * rate));
    for (let lag = Math.max(2, minLag); lag <= upper; lag++) {
        const bpm = (60 * rate) / lag;
        const prior = Math.exp(-0.5 * (Math.log2(bpm / centerBpm) / octaveWidth) ** 2);
        const strength = acAt(lag) + 0.5 * acAt(2 * lag);
        const score = prior * strength;
        if (score > best) { best = score; bestLag = lag; }
    }
    // Sub-sample peak
    let lag = bestLag;
    const a = ac[bestLag - 1];
    const b = ac[bestLag];
    const c = ac[bestLag + 1];
    const den = a - 2 * b + c;
    if (bestLag > 1 && den < 0) lag += Math.max(-0.5, Math.min(0.5, (a - c) / (2 * den)));
    return { bpm: (60 * rate) / lag, confidence: Math.max(0, Math.min(1, ac[bestLag])) };
}

/**
 * Where the beats fall, for a known tempo: the phase whose beat positions
 * collect the most onset energy, moved to the first beat that is actually
 * played (skips silent lead-ins).
 * @returns {{ offset: number, strength: number }}  offset = time of the first beat (s)
 */
export function estimateBeatOffset(env, rate, bpm) {
    const period = (60 / bpm) * rate;
    let best = 0;
    let bestScore = -Infinity;
    const steps = Math.max(8, Math.ceil(period * 2));
    for (let s = 0; s < steps; s++) {
        const phase = (s / steps) * period;
        let score = 0;
        for (let x = phase; x < env.length; x += period) score += Math.max(at(env, x - 1), at(env, x), at(env, x + 1));
        if (score > bestScore) { bestScore = score; best = phase; }
    }
    const beats = [];
    for (let x = best; x < env.length; x += period) beats.push(Math.max(at(env, x - 1), at(env, x), at(env, x + 1)));
    const typical = beats.slice().sort((a, b) => a - b)[Math.floor(beats.length * 0.6)] || 0;
    let first = 0;
    while (first < beats.length - 1 && beats[first] < 0.3 * typical) first++;
    return { offset: (best + first * period) / rate, strength: beats.length ? bestScore / beats.length : 0 };
}

/**
 * Fine-tune a tempo estimate: over many beats even a small tempo error drifts
 * off the onsets, so the tempo whose best-phase beat comb collects the most
 * onset energy is very precise.
 */
export function refineTempo(env, rate, bpm, { range = 0.025, step = 0.05 } = {}) {
    let best = bpm;
    let bestScore = -Infinity;
    for (let b = bpm * (1 - range); b <= bpm * (1 + range); b += step) {
        const period = (60 / b) * rate;
        const phases = Math.max(8, Math.ceil(period));
        for (let p = 0; p < phases; p++) {
            const phase = (p / phases) * period;
            let score = 0;
            let count = 0;
            for (let x = phase; x < env.length; x += period) { score += at(env, x); count++; }
            score /= count || 1;
            if (score > bestScore) { bestScore = score; best = b; }
        }
    }
    return best;
}

/** Tempo and first beat from an onset envelope. */
export function analyzeEnvelope({ envelope, rate, start = 0 }, options) {
    const coarse = estimateTempo(envelope, rate, options);
    const bpm = refineTempo(envelope, rate, coarse.bpm);
    const { offset } = estimateBeatOffset(envelope, rate, bpm);
    return { bpm: Math.round(bpm * 10) / 10, offset: Math.round((offset + start) * 1000) / 1000, confidence: coarse.confidence };
}

// ── Counts and sections ─────────────────────────────────────────────

export const beatSeconds = (rhythm) => 60 / rhythm.bpm;

/** 0-based beat index at a time (negative before count 1). */
export function beatIndexAt(time, rhythm) {
    return Math.floor((time - rhythm.offset) / beatSeconds(rhythm) + 1e-6);
}

/** Time of a 0-based beat index. */
export function beatTime(index, rhythm) {
    return rhythm.offset + index * beatSeconds(rhythm);
}

/** The count (1–8) a dancer would call at a time, and which eight it belongs to. */
export function countAt(time, rhythm, counts = 8) {
    const b = beatIndexAt(time, rhythm);
    return { beat: b, count: ((b % counts) + counts) % counts + 1, eight: Math.floor(b / counts) };
}

/**
 * Cut a routine into sections of `counts` beats (an "eight" by default), on
 * the beat grid. A short leftover at the end joins the last section.
 * @returns {Array<{ index, startBeat, endBeat, start, end, label }>}  beats 0-based, end exclusive
 */
export function buildSections({ bpm, offset, duration, counts = 8 }) {
    const beat = 60 / bpm;
    const total = Math.floor((duration - offset) / beat + 1e-6);
    if (total < 2) return [{ index: 0, startBeat: 0, endBeat: Math.max(1, total), start: 0, end: duration, label: 'Whole routine' }];
    const sections = [];
    for (let s = 0; s < total; s += counts) {
        const e = Math.min(total, s + counts);
        if (sections.length && e - s < counts / 2) {
            sections[sections.length - 1].endBeat = e; // fold a short tail into the previous section
        } else {
            sections.push({ index: sections.length, startBeat: s, endBeat: e });
        }
    }
    for (const sec of sections) {
        sec.start = offset + sec.startBeat * beat;
        sec.end = Math.min(duration, offset + sec.endBeat * beat);
        sec.label = `Counts ${sec.startBeat + 1}–${sec.endBeat}`;
    }
    return sections;
}

/** First beat at or after a time. */
export function nextBeatTime(time, rhythm) {
    const beat = beatSeconds(rhythm);
    return rhythm.offset + Math.ceil((time - rhythm.offset) / beat - 1e-6) * beat;
}

// ── Lining up two recordings by their sound ─────────────────────────

/**
 * Find the shift between two recordings of the same music from their onset
 * envelopes (see audioOnsetEnvelope; same rate): reference time = other time + offset.
 * Used to place a dancer's recording on the routine's timeline. Per-band
 * envelopes are compared band by band when both have them.
 *
 * Looped music matches itself at every repeat, so the best few shifts are
 * returned as candidates for the caller to choose between (e.g. by movement).
 * @returns {{ offset, confidence, candidates: Array<{ offset, score }> }}
 *   confidence: how far the best peak stands out (z-score)
 */
export function alignOnsets(reference, other, maxShift = 60) {
    const rate = reference.rate;
    const A = reference.bands && other.bands ? reference.bands : [reference.envelope];
    const B = reference.bands && other.bands ? other.bands : [other.envelope];
    const lenA = A[0].length;
    const lenB = B[0].length;
    const maxLag = Math.round(maxShift * rate);
    const lags = [];
    const scores = [];
    for (let lag = -maxLag; lag <= maxLag; lag++) {
        // reference[i + lag] ↔ other[i]
        const i0 = Math.max(0, -lag);
        const i1 = Math.min(lenB, lenA - lag);
        if (i1 - i0 < rate * 2) continue;
        let total = 0;
        for (let band = 0; band < A.length; band++) {
            const a = A[band];
            const b = B[band];
            let s = 0;
            let na = 0;
            let nb = 0;
            for (let i = i0; i < i1; i++) {
                const x = a[i + lag];
                const y = b[i];
                s += x * y;
                na += x * x;
                nb += y * y;
            }
            total += na > 0 && nb > 0 ? s / Math.sqrt(na * nb) : 0;
        }
        lags.push(lag);
        scores.push(total / A.length);
    }
    if (!scores.length) return { offset: 0, confidence: 0, candidates: [] };
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const std = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length) || 1;
    // Local maxima, best first, at least a quarter second apart
    const peaks = [];
    for (let i = 0; i < scores.length; i++) {
        if ((i > 0 && scores[i - 1] > scores[i]) || (i < scores.length - 1 && scores[i + 1] > scores[i])) continue;
        peaks.push({ offset: lags[i] / rate, score: scores[i] });
    }
    peaks.sort((a, b) => b.score - a.score);
    const candidates = [];
    for (const p of peaks) {
        if (candidates.every((c) => Math.abs(c.offset - p.offset) >= 0.25)) candidates.push(p);
        if (candidates.length >= 6) break;
    }
    const best = candidates[0];
    return { offset: best.offset, confidence: (best.score - mean) / std, candidates };
}
