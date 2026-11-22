// AutoChoreo — Practice timeline
//
// The routine laid out on its musical grid: the music's waveform (or, without
// music, how much the dancer moves), every count numbered in eights, the
// sections, the loop being practised (drag its edges, or drag across the
// timeline to loop any stretch — always snapped to whole beats), how well each
// count went in the last pass, and the playhead. Click to jump.

import { beatSeconds, beatIndexAt, beatTime } from '../choreo/rhythm.js';
import { scoreColor } from './overlay.js';

const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** Peak amplitude per column, for drawing a waveform. */
export function waveformPeaks(buffer, columns = 1200) {
    const data = buffer.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / columns));
    const peaks = new Float32Array(columns);
    let max = 0;
    for (let c = 0; c < columns; c++) {
        let m = 0;
        const end = Math.min(data.length, (c + 1) * step);
        for (let i = c * step; i < end; i += 4) m = Math.max(m, Math.abs(data[i]));
        peaks[c] = m;
        max = Math.max(max, m);
    }
    if (max > 0) for (let c = 0; c < columns; c++) peaks[c] /= max;
    return { peaks, duration: buffer.duration };
}

export class PracticeTimeline {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {object} o
     * @param {(time: number) => void} o.onSeek
     * @param {(range: {start, end}) => void} o.onRangeChange
     */
    constructor(canvas, { onSeek, onRangeChange }) {
        this.canvas = canvas;
        this.onSeek = onSeek;
        this.onRangeChange = onRangeChange;
        this.duration = 1;
        this.rhythm = null;
        this.sections = [];
        this.wave = null;       // { peaks, duration }
        this.energy = null;     // { values, rate } (movement), when there is no music
        this.range = null;
        this.time = 0;
        this.beatScores = new Map();
        this.drag = null;
        canvas.addEventListener('pointerdown', (e) => this._down(e));
        canvas.addEventListener('pointermove', (e) => this._move(e));
        canvas.addEventListener('pointerup', (e) => this._up(e));
        canvas.addEventListener('pointercancel', () => { this.drag = null; });
        new ResizeObserver(() => this.draw()).observe(canvas);
    }

    setData({ duration, rhythm, sections, wave = null, energy = null }) {
        this.duration = duration || 1;
        this.rhythm = rhythm;
        this.sections = sections || [];
        this.wave = wave;
        this.energy = energy;
        this.draw();
    }

    setRange(range) { this.range = range; this.draw(); }
    setTime(t) { this.time = t; this.draw(); }
    /** Map of 0-based beat → 0–100 score from the latest pass. */
    setBeatScores(map) { this.beatScores = map; this.draw(); }

    // ── Geometry ────────────────────────────────────────────────────

    get pad() { return 14; }
    x(t) { return this.pad + (t / this.duration) * (this.canvas.clientWidth - 2 * this.pad); }
    t(x) { return Math.max(0, Math.min(this.duration, ((x - this.pad) / (this.canvas.clientWidth - 2 * this.pad)) * this.duration)); }

    snap(t) {
        if (!this.rhythm) return t;
        const b = Math.round((t - this.rhythm.offset) / beatSeconds(this.rhythm));
        return Math.max(0, Math.min(this.duration, beatTime(b, this.rhythm)));
    }

    // ── Interaction ─────────────────────────────────────────────────

    _local(e) {
        const r = this.canvas.getBoundingClientRect();
        return e.clientX - r.left;
    }

    _down(e) {
        const x = this._local(e);
        this.canvas.setPointerCapture(e.pointerId);
        if (this.range) {
            const a = this.x(this.range.start);
            const b = this.x(this.range.end);
            if (Math.abs(x - a) < 9) { this.drag = { kind: 'start', x }; return; }
            if (Math.abs(x - b) < 9) { this.drag = { kind: 'end', x }; return; }
        }
        this.drag = { kind: 'new', x, t0: this.t(x), moved: false };
    }

    _move(e) {
        const x = this._local(e);
        if (!this.drag) {
            const near = this.range && (Math.abs(x - this.x(this.range.start)) < 9 || Math.abs(x - this.x(this.range.end)) < 9);
            this.canvas.style.cursor = near ? 'ew-resize' : 'pointer';
            return;
        }
        const beat = this.rhythm ? beatSeconds(this.rhythm) : 0.25;
        const t = this.snap(this.t(x));
        if (this.drag.kind === 'start') {
            this.range = { start: Math.min(t, this.range.end - beat), end: this.range.end };
        } else if (this.drag.kind === 'end') {
            this.range = { start: this.range.start, end: Math.max(t, this.range.start + beat) };
        } else if (Math.abs(x - this.drag.x) > 6) {
            this.drag.moved = true;
            const a = this.snap(Math.min(this.drag.t0, this.t(x)));
            const b = this.snap(Math.max(this.drag.t0, this.t(x)));
            this.range = { start: a, end: Math.max(b, a + beat) };
        }
        this.draw();
    }

    _up(e) {
        const drag = this.drag;
        this.drag = null;
        if (!drag) return;
        if (drag.kind === 'new' && !drag.moved) {
            this.onSeek(this.t(this._local(e)));
            return;
        }
        if (this.range) this.onRangeChange({ ...this.range });
    }

    // ── Drawing ─────────────────────────────────────────────────────

    draw() {
        const canvas = this.canvas;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (!w || !h) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
        }
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const accent = css('--accent', '#a855f7');
        const muted = css('--text-muted', '#8b84a8');
        const labelsH = 18;
        const scoreH = 6;
        const waveTop = labelsH + 4;
        const waveBottom = h - scoreH - 6;
        const mid = (waveTop + waveBottom) / 2;
        const half = (waveBottom - waveTop) / 2;
        const inRange = (t) => !this.range || (t >= this.range.start && t <= this.range.end);

        // Waveform / movement energy
        const cols = Math.max(1, Math.floor((w - 2 * this.pad) / 3));
        for (let c = 0; c < cols; c++) {
            const t = ((c + 0.5) / cols) * this.duration;
            let v = 0;
            if (this.wave) {
                const i = Math.floor((t / this.wave.duration) * this.wave.peaks.length);
                v = this.wave.peaks[Math.min(this.wave.peaks.length - 1, i)] || 0;
            } else if (this.energy) {
                const i = Math.floor(t * this.energy.rate);
                v = this.energy.values[Math.min(this.energy.values.length - 1, i)] || 0;
            }
            const bh = Math.max(1, v * half * 0.95);
            ctx.fillStyle = inRange(t) ? accent : 'rgba(168, 133, 247, 0.32)';
            ctx.globalAlpha = inRange(t) ? 0.95 : 1;
            ctx.fillRect(this.x(t) - 1, mid - bh, 2, bh * 2);
        }
        ctx.globalAlpha = 1;

        // Beats, counts, sections
        if (this.rhythm) {
            const beat = beatSeconds(this.rhythm);
            const pxPerBeat = (w - 2 * this.pad) * beat / this.duration;
            const every = pxPerBeat >= 16 ? 1 : pxPerBeat >= 8 ? 2 : pxPerBeat >= 4 ? 4 : 8;
            const first = Math.max(0, beatIndexAt(0, this.rhythm));
            const last = beatIndexAt(this.duration, this.rhythm);
            ctx.font = '600 11px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            for (let b = first; b <= last; b++) {
                const t = beatTime(b, this.rhythm);
                if (t < 0 || t > this.duration) continue;
                const x = this.x(t);
                const count = (b % 8) + 1;
                const isOne = count === 1;
                ctx.fillStyle = isOne ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.08)';
                ctx.fillRect(x - 0.5, waveTop, 1, waveBottom - waveTop);
                if (b % every === 0 || isOne) {
                    ctx.fillStyle = isOne ? '#fff' : muted;
                    ctx.fillText(String(count), x, labelsH / 2 + 1);
                }
                // Score of that count in the last pass
                const s = this.beatScores.get(b);
                if (s != null) {
                    ctx.fillStyle = scoreColor(s / 100);
                    ctx.fillRect(x + 1, h - scoreH - 2, Math.max(2, pxPerBeat - 2), scoreH);
                }
            }
            // Section letters
            ctx.textAlign = 'left';
            ctx.font = '700 10px system-ui, sans-serif';
            for (const s of this.sections) {
                ctx.fillStyle = 'rgba(255,255,255,0.45)';
                ctx.fillText(String.fromCharCode(65 + s.index), this.x(s.start) + 4, waveTop + 9);
            }
        }

        // Loop range
        if (this.range) {
            const a = this.x(this.range.start);
            const b = this.x(this.range.end);
            ctx.fillStyle = 'rgba(168, 85, 247, 0.16)';
            ctx.strokeStyle = '#d8b4fe';
            ctx.lineWidth = 2;
            roundRect(ctx, a, waveTop - 2, b - a, waveBottom - waveTop + 4, 6);
            ctx.fill();
            ctx.stroke();
            for (const x of [a, b]) {
                ctx.fillStyle = '#f5f3ff';
                roundRect(ctx, x - 4, mid - 11, 8, 22, 3);
                ctx.fill();
                ctx.fillStyle = '#7c3aed';
                ctx.fillRect(x - 1, mid - 5, 2, 10);
            }
        }

        // Playhead
        const px = this.x(this.time);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(px - 1, waveTop - 4, 2, waveBottom - waveTop + 8);
        ctx.beginPath();
        ctx.arc(px, waveTop - 4, 4, 0, Math.PI * 2);
        ctx.fill();
    }
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}
