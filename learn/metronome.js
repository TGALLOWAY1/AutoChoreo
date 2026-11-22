// AutoChoreo — Metronome and count-in
//
// Clicks on the routine's beat grid, in step with the transport at any tempo,
// for routines without music (and on request with music). Before each pass it
// counts the dancer in — "5, 6, 7, 8" — so the first move lands on count 1.

import { beatSeconds, beatIndexAt, nextBeatTime } from '../choreo/rhythm.js';

const LOOKAHEAD = 0.12; // seconds of song time scheduled ahead

export class Metronome {
    /** @param {import('../sync.js').TransportController} transport */
    constructor(transport) {
        this.transport = transport;
        this.enabled = false;
        this.rhythm = null;
        this.volume = 0.5;
        this._scheduledBeat = -Infinity;
        this._nodes = [];
        const reset = () => this.reset();
        transport.on('seek', reset);
        transport.on('pause', reset);
        transport.on('speedchange', reset);
    }

    get ctx() {
        return this.transport.audioContext;
    }

    setRhythm(rhythm) {
        this.rhythm = rhythm;
        this.reset();
    }

    setEnabled(on) {
        this.enabled = on;
        this.reset();
    }

    reset() {
        for (const n of this._nodes) {
            try { n.stop(); } catch (_) { /* already stopped */ }
        }
        this._nodes = [];
        this._scheduledBeat = this.rhythm ? beatIndexAt(this.transport.currentTime - 1e-3, this.rhythm) : -Infinity;
    }

    /** Call every frame: schedules the clicks of the next few beats. */
    tick() {
        if (!this.enabled || !this.rhythm || !this.transport.playing) return;
        const t = this.transport.currentTime;
        const speed = this.transport.speed || 1;
        const beat = beatSeconds(this.rhythm);
        const ctxNow = this.ctx.currentTime;
        for (let b = this._scheduledBeat + 1; ; b++) {
            const songTime = this.rhythm.offset + b * beat;
            if (songTime > t + LOOKAHEAD * speed) break;
            this._scheduledBeat = b;
            if (songTime < t - 0.02 || b < 0) continue; // missed (e.g. a tab was in the background)
            this.click(ctxNow + (songTime - t) / speed, ((b % 8) + 8) % 8 === 0);
        }
        this._nodes = this._nodes.filter((n) => !n._done);
    }

    /** One click at an AudioContext time; the first count of an eight is accented. */
    click(when, accent = false, list = this._nodes) {
        const ctx = this.ctx;
        if (ctx.state === 'suspended') ctx.resume();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = accent ? 1568 : 1046;
        gain.gain.setValueAtTime(0.0001, when);
        gain.gain.exponentialRampToValueAtTime(this.volume * (accent ? 1 : 0.7), when + 0.003);
        gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);
        osc.connect(gain).connect(ctx.destination);
        osc.start(when);
        osc.stop(when + 0.08);
        osc.onended = () => { osc._done = true; };
        list.push(osc);
        return osc;
    }

    /**
     * Count the dancer in to a pass that starts at song time `start`: clicks on
     * the `beats` beats before the first beat at or after `start`, at the
     * current tempo. Resolves when playback should begin (so count 1 lands on
     * the beat); rejects with AbortError if cancelled.
     *
     * @param {number} start  Song time the pass starts from.
     * @param {object} o
     * @param {number} [o.beats=4]
     * @param {(label: string, index: number) => void} [o.onCount]  Called as each count sounds ("5" … "8").
     * @param {AbortSignal} [o.signal]
     */
    countIn(start, { beats = 4, onCount = () => {}, signal } = {}) {
        const rhythm = this.rhythm;
        if (!rhythm || beats <= 0) return Promise.resolve();
        const ctx = this.ctx;
        if (ctx.state === 'suspended') ctx.resume();
        const speed = this.transport.speed || 1;
        const beat = beatSeconds(rhythm);
        const first = nextBeatTime(start, rhythm);
        const counts = Array.from({ length: beats }, (_, i) => first - (beats - i) * beat);
        const lead = 0.15;
        const t0 = ctx.currentTime + lead;              // AudioContext time of the first click
        const startAt = t0 + (start - counts[0]) / speed; // when playback should begin
        const timers = [];
        const countNodes = []; // kept apart: a seek right before playback must not silence the count
        counts.forEach((c, i) => {
            const when = t0 + (c - counts[0]) / speed;
            this.click(when, false, countNodes);
            const label = String(8 - beats + 1 + i);
            timers.push(setTimeout(() => onCount(label, i), Math.max(0, (when - ctx.currentTime) * 1000)));
        });
        return new Promise((resolve, reject) => {
            const done = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, Math.max(0, (startAt - ctx.currentTime) * 1000));
            const abort = () => {
                timers.forEach(clearTimeout);
                clearTimeout(done);
                for (const n of countNodes) { try { n.stop(); } catch (_) { /* already stopped */ } }
                reject(new DOMException('Count-in cancelled', 'AbortError'));
            };
            if (signal) {
                if (signal.aborted) abort();
                else signal.addEventListener('abort', abort, { once: true });
            }
        });
    }
}
