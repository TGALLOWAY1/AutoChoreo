// AutoChoreo — Sequence editor (side panel + timeline strip)
//
// Builds a sequence of dance clips, the transitions between them and rhythmic
// speed changes, and hands the compiled result to the host (main.js), which
// performs it like any other dance. The editor never touches the scene or the
// transport directly: everything goes through the `host` callbacks.

import {
    createSequence, createClip, createSpeedChange, compileSequence, normalizeClip,
    suggestInPoint, suggestLoopOutPoint, sequenceToJSON, barBeat, beatIndex,
    speedChangeShift, clipRate, TRANSITION_STYLES,
} from './choreo/sequence.js';

const BLEND_BEATS = [[0.25, '¼ beat'], [0.5, '½ beat'], [1, '1 beat'], [2, '2 beats'], [4, '1 bar (4)'], [8, '2 bars (8)']];
const SPEEDS = [
    [0, 'Hold (0×)'],
    [0.25, 'Quarter time (¼×)'],
    [0.5, 'Half time (½×)'],
    [0.75, 'Three-quarter (¾×)'],
    [1.5, 'One and a half (1½×)'],
    [2, 'Double time (2×)'],
];
const RAMPS = [[0, 'no ramp'], [0.25, '¼-beat ramp'], [0.5, '½-beat ramp'], [1, '1-beat ramp']];
const CLIP_HUES = [190, 280, 140, 30, 330, 60];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const fmtNum = (x) => String(round(x, 2));
const plural = (n, word) => `${fmtNum(n)} ${word}${Math.abs(n - 1) < 1e-9 ? '' : 's'}`;
const fmtClock = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

function options(list, selected) {
    let found = list.some(([v]) => Math.abs(v - selected) < 1e-9);
    const extra = found ? '' : `<option value="${selected}" selected>${fmtNum(selected)}</option>`;
    return extra + list.map(([v, label]) => `<option value="${v}"${Math.abs(v - selected) < 1e-9 ? ' selected' : ''}>${esc(label)}</option>`).join('');
}

export class SequenceEditor {
    /**
     * @param {object} o
     * @param {HTMLElement} o.panel         Container for the editor panel.
     * @param {HTMLCanvasElement} o.strip   Timeline strip drawn above the scrubber.
     * @param {HTMLElement} o.scrubber      The scrubber the strip lines up with.
     * @param {Array<[string, string]>} o.presets  [url, label] dances that can be added.
     * @param {object} o.host               Callbacks into the app (see main.js).
     */
    constructor({ panel, strip, scrubber, presets, host }) {
        this.panel = panel;
        this.strip = strip;
        this.scrubber = scrubber;
        this.presets = presets;
        this.host = host;
        this.seq = createSequence();
        this.compiled = null;
        this.active = false;
        this.taps = [];
        this.compileTimer = null;

        this.fileInput = document.createElement('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.fbx,.json';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', () => this._addFromFile());
        document.body.appendChild(this.fileInput);

        panel.addEventListener('click', (e) => this._onClick(e));
        panel.addEventListener('change', (e) => this._onChange(e));
        strip.addEventListener('click', (e) => this._onStripClick(e));
        strip.addEventListener('mousemove', (e) => {
            const hit = this._stripHit(e);
            strip.style.cursor = hit ? 'pointer' : 'ew-resize';
            strip.title = hit ? hit.title : '';
        });
        this.render();
    }

    // ── Visibility & state ──────────────────────────────────────────

    get isOpen() { return this.panel.classList.contains('open'); }
    open() { this.panel.classList.add('open'); }
    close() { this.panel.classList.remove('open'); }
    toggle() { this.panel.classList.toggle('open'); }

    /** The host calls this when the sequence starts or stops being the current dance. */
    setActive(active) {
        this.active = active;
        this.strip.style.display = active ? 'block' : 'none';
        const btn = this.panel.querySelector('[data-act="play"]');
        if (btn) btn.textContent = active ? 'Restart' : 'Play sequence';
    }

    setSequence(seq) {
        this.seq = seq;
        this.render();
        this._compileNow({ notify: false });
    }

    play() {
        const compiled = this._compileNow({ notify: false });
        if (!compiled) {
            this.host.message('Add at least one clip to the sequence first.');
            return;
        }
        this.host.play(compiled);
    }

    // ── Rendering ───────────────────────────────────────────────────

    render() {
        const s = this.seq;
        const t = s.tempo;
        const clips = s.clips.map((c, i) => this._clipHTML(c, i)).join('');
        const speeds = s.speedChanges.map((c, k) => this._speedHTML(c, k)).join('');
        this.panel.innerHTML = `
<div class="seq-head">
  <input class="seq-title" data-field="name" value="${esc(s.name)}" aria-label="Sequence name">
  <button class="seq-btn primary" data-act="play">${this.active ? 'Restart' : 'Play sequence'}</button>
  <button class="seq-btn icon" data-act="close" title="Close panel">✕</button>
</div>

<section>
  <h3>Tempo</h3>
  <div class="seq-row">
    <label>BPM <input type="number" data-field="bpm" min="20" max="300" step="0.1" value="${t.bpm}"></label>
    <button class="seq-btn" data-act="tap" title="Tap along with the beat">Tap</button>
    <label>Beats/bar <input type="number" data-field="bpb" min="1" max="12" step="1" value="${t.beatsPerBar}"></label>
  </div>
  <div class="seq-row">
    <label>First downbeat at <input type="number" data-field="offset" min="0" step="0.01" value="${round(t.offset, 3)}"> s</label>
    <button class="seq-btn" data-act="downbeat-now" title="Use the current playback position">Now</button>
  </div>
  <p class="seq-hint">The dance starts on the first downbeat and holds its opening pose before it.</p>
</section>

<section>
  <h3>Joins</h3>
  <label class="seq-check"><input type="checkbox" data-field="matchHeading"${s.matchHeading ? ' checked' : ''}> Turn each clip to face the way the last one ended</label>
  <div class="seq-row">
    <span>Neutral pose: <b data-info="neutral">${s.neutralPose ? 'captured' : 'standing'}</b></span>
    <button class="seq-btn" data-act="capture-neutral" title="Use the pose on screen right now">Capture current pose</button>
    ${s.neutralPose ? '<button class="seq-btn" data-act="reset-neutral">Reset</button>' : ''}
  </div>
</section>

<section>
  <h3>Clips</h3>
  <div class="seq-row">
    <button class="seq-btn" data-act="add-current" title="Add the dance that is loaded now (including dances learned from video)">+ Current dance</button>
    <select class="seq-select" data-field="add-preset">
      <option value="">+ Preset…</option>
      ${this.presets.map(([url, label]) => `<option value="${esc(url)}">${esc(label)}</option>`).join('')}
    </select>
    <button class="seq-btn" data-act="add-file" title="FBX mocap or a saved .choreo.json">+ File…</button>
  </div>
  ${clips || '<p class="seq-hint">No clips yet. Add a few dances, trim them, and choose how each one hands over to the next.</p>'}
</section>

<section>
  <h3>Speed changes</h3>
  <p class="seq-hint">Measured in song beats. Ramps are centred on the beat, so everything after stays on the grid.</p>
  ${speeds}
  <button class="seq-btn" data-act="speed-add">+ Speed change</button>
</section>

<div class="seq-foot">
  <span data-info="total"></span>
  <span class="seq-spacer"></span>
  <button class="seq-btn" data-act="save">Save sequence</button>
  <button class="seq-btn" data-act="clear">Clear</button>
</div>`;
        this._refreshInfo();
    }

    _clipHTML(c, i) {
        const n = this.seq.clips.length;
        const loopJoin = c.loops > 1 ? `
  <div class="seq-join loop" data-join="loop-${i}">
    <span class="seq-join-label">⟲ each repeat</span>
    ${this._joinControls('loop', i, c.loopTransition)}
    <button class="seq-btn small" data-act="match-loop" data-i="${i}" title="Move the out point to where the pose flows back into the in point">Match loop</button>
  </div>` : '';
        const nextJoin = i < n - 1 ? `
<div class="seq-join" data-join="clip-${i}">
  <span class="seq-join-label">↓ into ${esc(this.seq.clips[i + 1].name)}</span>
  ${this._joinControls('trans', i, c.transition)}
  <button class="seq-btn small" data-act="match-in" data-i="${i}" title="Move the next clip's in point to the pose that best matches how this clip ends">Match pose</button>
</div>` : '';
        return `
<div class="seq-clip" style="--hue:${CLIP_HUES[i % CLIP_HUES.length]}">
  <div class="seq-clip-head">
    <span class="seq-num">${i + 1}</span>
    <span class="seq-name" title="${esc(c.name)}">${esc(c.name)}</span>
    <button class="seq-btn icon" data-act="clip-up" data-i="${i}" title="Move up"${i === 0 ? ' disabled' : ''}>↑</button>
    <button class="seq-btn icon" data-act="clip-down" data-i="${i}" title="Move down"${i === n - 1 ? ' disabled' : ''}>↓</button>
    <button class="seq-btn icon" data-act="clip-remove" data-i="${i}" title="Remove">✕</button>
  </div>
  <div class="seq-row">
    <label>In <input type="number" data-field="clip.in" data-i="${i}" min="0" step="0.05" value="${round(c.in, 3)}"></label>
    <label>Out <input type="number" data-field="clip.out" data-i="${i}" min="0" step="0.05" value="${round(c.out, 3)}"></label>
    <label>× <input type="number" data-field="clip.loops" data-i="${i}" min="1" max="64" step="1" value="${c.loops}" title="Times to play"></label>
  </div>
  <div class="seq-row">
    <label title="The dance's own tempo. When set, it is sped up or slowed down to the song's tempo.">Dance BPM <input type="number" data-field="clip.sourceBpm" data-i="${i}" min="0" step="0.1" value="${c.sourceBpm || ''}" placeholder="—"></label>
    <button class="seq-btn small" data-act="snap-out" data-i="${i}" title="Move the out point so the clip lasts a whole number of beats">Snap to beats</button>
  </div>
  <div class="seq-info" data-info="clip-${i}"></div>
  ${loopJoin}
</div>${nextJoin}`;
    }

    _joinControls(kind, i, tr) {
        const styles = Object.entries(TRANSITION_STYLES)
            .map(([v, label]) => `<option value="${v}"${tr.style === v ? ' selected' : ''}>${label}</option>`).join('');
        return `<select class="seq-select" data-field="${kind}.style" data-i="${i}">${styles}</select>
    <select class="seq-select" data-field="${kind}.beats" data-i="${i}"${tr.style === 'cut' ? ' disabled' : ''}>${options(BLEND_BEATS, tr.beats)}</select>`;
    }

    _speedHTML(c, k) {
        const { bar, beat } = barBeat(c.startBeat, this.seq.tempo.beatsPerBar);
        return `
<div class="seq-speed" data-speed="${k}">
  <div class="seq-row">
    <label>Bar <input type="number" data-field="speed.bar" data-i="${k}" min="1" step="1" value="${bar}"></label>
    <label>beat <input type="number" data-field="speed.beat" data-i="${k}" min="1" step="0.5" value="${round(beat, 3)}"></label>
    <label>for <input type="number" data-field="speed.beats" data-i="${k}" min="0.25" step="0.25" value="${c.beats}"> beats</label>
    <button class="seq-btn icon" data-act="speed-remove" data-i="${k}" title="Remove">✕</button>
  </div>
  <div class="seq-row">
    <select class="seq-select" data-field="speed.speed" data-i="${k}">${options(SPEEDS, c.speed)}</select>
    <select class="seq-select" data-field="speed.ramp" data-i="${k}">${options(RAMPS, c.rampBeats)}</select>
  </div>
  <div class="seq-info" data-info="speed-${k}"></div>
</div>`;
    }

    /** Update the derived labels (positions, lengths) without rebuilding the inputs. */
    _refreshInfo() {
        const tl = this.compiled && this.compiled.timeline;
        const bpb = this.seq.tempo.beatsPerBar;
        const pos = (songTime) => {
            const { bar, beat } = barBeat(round((songTime - tl.offset) / tl.beat, 3), bpb);
            return `bar ${bar}, beat ${fmtNum(beat)}`;
        };
        this.panel.querySelectorAll('[data-info]').forEach((el) => {
            const key = el.dataset.info;
            if (key === 'neutral') return;
            if (key === 'total') {
                if (!tl) { el.textContent = ''; return; }
                const beats = (tl.duration - tl.offset) / tl.beat;
                const bars = Math.floor(beats / bpb + 1e-6);
                const rest = round(beats - bars * bpb, 2);
                el.textContent = `${plural(bars, 'bar')}${rest > 0 ? ` ${plural(rest, 'beat')}` : ''} · ${fmtClock(tl.duration)}`;
                return;
            }
            const [kind, idx] = key.split('-');
            const i = Number(idx);
            if (kind === 'clip') {
                if (!tl) { el.textContent = ''; return; }
                const parts = tl.clips.filter((c) => c.clipIndex === i);
                if (!parts.length) return;
                const start = parts[0].start;
                const end = parts[parts.length - 1].end;
                const clip = this.seq.clips[i];
                const rate = clipRate(clip, this.seq.tempo);
                el.textContent = `${pos(start)} · ${plural(round((end - start) / tl.beat, 2), 'beat')}` +
                    (Math.abs(rate - 1) > 1e-6 ? ` · ×${round(rate, 2)}` : '');
            } else if (kind === 'speed') {
                const change = this.seq.speedChanges[i];
                if (!change) return;
                const shift = round(speedChangeShift(change), 3);
                const offBeat = Math.abs(shift - Math.round(shift)) > 1e-6;
                el.textContent = shift === 0 ? 'Later material stays where it is.'
                    : `Moves what follows ${shift > 0 ? 'later' : 'earlier'} by ${plural(Math.abs(shift), 'beat')}` +
                      (offBeat ? ' — not a whole beat, so later moves land off the beat.' : '.');
                el.classList.toggle('warn', offBeat);
            }
        });
    }

    // ── Editing ─────────────────────────────────────────────────────

    _changed({ rerender = false } = {}) {
        if (rerender) this.render();
        clearTimeout(this.compileTimer);
        this.compileTimer = setTimeout(() => this._compileNow(), 120);
    }

    _compileNow({ notify = true } = {}) {
        clearTimeout(this.compileTimer);
        try {
            this.compiled = compileSequence(this.seq);
        } catch (err) {
            console.error(err);
            this.host.message(`Could not build the sequence: ${err.message}`);
            this.compiled = null;
        }
        this._refreshInfo();
        if (notify && this.compiled) this.host.update(this.compiled);
        return this.compiled;
    }

    _addClip(choreo, name) {
        this.seq.clips.push(createClip(choreo, { name: name || choreo.name }));
        this._changed({ rerender: true });
    }

    async _addFromFile() {
        const file = this.fileInput.files[0];
        this.fileInput.value = '';
        if (!file) return;
        try {
            const result = await this.host.loadDanceFile(file);
            if (result.sequence) {
                this.setSequence(result.sequence);
                this.play();
            } else {
                this._addClip(result.choreo, result.name);
            }
        } catch (err) {
            this.host.message(`Could not add ${file.name}: ${err.message}`);
        }
    }

    _onClick(e) {
        const btn = e.target.closest('[data-act]');
        if (!btn || btn.disabled) return;
        const i = Number(btn.dataset.i);
        const s = this.seq;
        switch (btn.dataset.act) {
            case 'play': this.play(); break;
            case 'close': this.close(); break;
            case 'tap': this._tap(); break;
            case 'downbeat-now':
                s.tempo.offset = round(this.host.songTime(), 3);
                this.panel.querySelector('[data-field="offset"]').value = s.tempo.offset;
                this._changed();
                break;
            case 'capture-neutral':
                try {
                    s.neutralPose = this.host.capturePose();
                    this._changed({ rerender: true });
                } catch (err) {
                    this.host.message(err.message);
                }
                break;
            case 'reset-neutral':
                s.neutralPose = null;
                this._changed({ rerender: true });
                break;
            case 'add-current':
                try {
                    const { choreo, name } = this.host.currentDance();
                    this._addClip(choreo, name);
                } catch (err) {
                    this.host.message(err.message);
                }
                break;
            case 'add-file': this.fileInput.click(); break;
            case 'clip-up':
            case 'clip-down': {
                const j = btn.dataset.act === 'clip-up' ? i - 1 : i + 1;
                [s.clips[i], s.clips[j]] = [s.clips[j], s.clips[i]];
                this._changed({ rerender: true });
                break;
            }
            case 'clip-remove':
                s.clips.splice(i, 1);
                this._changed({ rerender: true });
                break;
            case 'match-in': {
                const t = suggestInPoint(s, i);
                if (t === null) break;
                const next = s.clips[i + 1];
                const moved = round(t - next.in, 3);
                next.in = t;
                normalizeClip(next);
                this.host.message(moved === 0 ? 'The in point already gives the closest match.'
                    : `Moved ${next.name}'s in point to ${fmtNum(next.in)} s.`, 2500);
                this._changed({ rerender: true });
                break;
            }
            case 'match-loop': {
                const t = suggestLoopOutPoint(s, i);
                if (t === null) break;
                const clip = s.clips[i];
                const moved = round(t - clip.out, 3);
                clip.out = t;
                normalizeClip(clip);
                this.host.message(moved === 0 ? 'The out point already loops most smoothly.'
                    : `Moved ${clip.name}'s out point to ${fmtNum(clip.out)} s.`, 2500);
                this._changed({ rerender: true });
                break;
            }
            case 'snap-out': {
                const clip = s.clips[i];
                const beat = 60 / s.tempo.bpm;
                const rate = clipRate(clip, s.tempo);
                const room = (clip.choreo.duration - clip.in) / rate / beat; // most beats the dance has left
                let beats = Math.max(1, Math.round((clip.out - clip.in) / rate / beat));
                if (beats > room + 1e-6) beats = Math.floor(room + 1e-6);
                if (beats < 1) {
                    this.host.message('Too little of this dance is left after the in point for a whole beat.', 3000);
                    break;
                }
                clip.out = clip.in + beats * beat * rate;
                normalizeClip(clip);
                this._changed({ rerender: true });
                break;
            }
            case 'speed-add':
                s.speedChanges.push(createSpeedChange({ startBeat: this._nextBarBeat() }));
                this._changed({ rerender: true });
                break;
            case 'speed-remove':
                s.speedChanges.splice(i, 1);
                this._changed({ rerender: true });
                break;
            case 'save':
                if (!s.clips.length) {
                    this.host.message('Nothing to save yet.', 2500);
                    break;
                }
                this.host.download(sequenceToJSON(s), `${s.name || 'sequence'}.sequence.json`);
                break;
            case 'clear':
                if (!s.clips.length && !s.speedChanges.length) break;
                if (!window.confirm('Remove every clip and speed change from the sequence?')) break;
                s.clips = [];
                s.speedChanges = [];
                this._changed({ rerender: true });
                break;
        }
    }

    _onChange(e) {
        const el = e.target;
        const field = el.dataset.field;
        if (!field) return;
        const i = Number(el.dataset.i);
        const num = parseFloat(el.value);
        const s = this.seq;
        switch (field) {
            case 'name': s.name = el.value.trim() || 'Sequence'; return; // no recompile needed
            case 'bpm':
                if (num >= 20 && num <= 300) s.tempo.bpm = num;
                el.value = s.tempo.bpm;
                break;
            case 'bpb':
                if (num >= 1) s.tempo.beatsPerBar = Math.round(num);
                this._changed({ rerender: true });
                return;
            case 'offset':
                s.tempo.offset = num >= 0 ? num : 0;
                el.value = s.tempo.offset;
                break;
            case 'matchHeading': s.matchHeading = el.checked; break;
            case 'add-preset': {
                const url = el.value;
                const label = el.selectedOptions[0]?.textContent || '';
                el.value = '';
                if (!url) return;
                this.host.loadPresetDance(url)
                    .then((choreo) => this._addClip(choreo, label))
                    .catch((err) => this.host.message(`Could not add ${label}: ${err.message}`));
                return;
            }
            case 'clip.in':
            case 'clip.out':
            case 'clip.sourceBpm': {
                const clip = s.clips[i];
                const key = field.split('.')[1];
                clip[key] = Number.isFinite(num) ? num : (key === 'sourceBpm' ? 0 : clip[key]);
                normalizeClip(clip);
                el.value = key === 'sourceBpm' ? (clip.sourceBpm || '') : round(clip[key], 3);
                break;
            }
            case 'clip.loops':
                s.clips[i].loops = num;
                normalizeClip(s.clips[i]);
                this._changed({ rerender: true });
                return;
            case 'trans.style':
            case 'loop.style':
            case 'trans.beats':
            case 'loop.beats': {
                const [kind, key] = field.split('.');
                const tr = kind === 'trans' ? s.clips[i].transition : s.clips[i].loopTransition;
                tr[key] = key === 'beats' ? num : el.value;
                this._changed({ rerender: key === 'style' });
                return;
            }
            case 'speed.bar':
            case 'speed.beat': {
                const c = s.speedChanges[i];
                const bpb = s.tempo.beatsPerBar;
                const cur = barBeat(c.startBeat, bpb);
                const bar = field === 'speed.bar' ? Math.max(1, Math.round(num) || 1) : cur.bar;
                const beat = field === 'speed.beat' ? Math.max(1, num || 1) : cur.beat;
                c.startBeat = beatIndex(bar, beat, bpb);
                this._changed({ rerender: true }); // beat past the bar end rolls over into the next bar
                return;
            }
            case 'speed.beats':
                s.speedChanges[i].beats = num > 0 ? num : 1;
                el.value = s.speedChanges[i].beats;
                break;
            case 'speed.speed': s.speedChanges[i].speed = num; break;
            case 'speed.ramp': s.speedChanges[i].rampBeats = num; break;
            default: return;
        }
        this._changed();
    }

    _tap() {
        const now = performance.now();
        if (this.taps.length && now - this.taps[this.taps.length - 1] > 2000) this.taps = [];
        this.taps.push(now);
        if (this.taps.length > 8) this.taps.shift();
        if (this.taps.length < 3) return;
        const span = (this.taps[this.taps.length - 1] - this.taps[0]) / (this.taps.length - 1);
        this.seq.tempo.bpm = round(60000 / span, 1);
        this.panel.querySelector('[data-field="bpm"]').value = this.seq.tempo.bpm;
        this._changed();
    }

    /** Start of the bar after the playhead (or after the last speed change). */
    _nextBarBeat() {
        const bpb = this.seq.tempo.beatsPerBar;
        const tl = this.compiled && this.compiled.timeline;
        let beat = 0;
        if (this.active && tl) beat = Math.max(0, (this.host.songTime() - tl.offset) / tl.beat);
        for (const c of this.seq.speedChanges) beat = Math.max(beat, c.startBeat + c.beats);
        return Math.ceil(beat / bpb - 1e-6) * bpb;
    }

    /** Scroll the panel to a join or speed change and flash it. */
    focus(selector) {
        this.open();
        const el = this.panel.querySelector(selector);
        if (!el) return;
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.remove('flash');
        void el.offsetWidth; // restart the animation
        el.classList.add('flash');
    }

    // ── Timeline strip ──────────────────────────────────────────────

    /** Lay the strip over the scrubber's track so their times line up. */
    _stripGeometry() {
        const r = this.scrubber.getBoundingClientRect();
        const inset = 7; // half the thumb width: where the thumb's centre can reach
        return { left: r.left + inset, width: Math.max(1, r.width - inset * 2) };
    }

    draw(currentTime, duration) {
        if (!this.active) return;
        const tl = this.compiled && this.compiled.timeline;
        const { left, width } = this._stripGeometry();
        const strip = this.strip;
        const dpr = window.devicePixelRatio || 1;
        const cssH = strip.clientHeight || 40;
        const pad = 4;
        strip.style.left = `${left - pad}px`;
        strip.style.width = `${width + pad * 2}px`;
        if (strip.width !== Math.round((width + pad * 2) * dpr) || strip.height !== Math.round(cssH * dpr)) {
            strip.width = Math.round((width + pad * 2) * dpr);
            strip.height = Math.round(cssH * dpr);
        }
        const ctx = strip.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width + pad * 2, cssH);
        if (!tl || !(duration > 0)) return;
        const x = (t) => pad + (t / duration) * width;
        const top = 3;
        const blockH = cssH - 16;
        const bandY = top + blockH + 2;

        // Bar lines
        const barLen = tl.beat * tl.beatsPerBar;
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        for (let t = tl.offset; t <= duration; t += barLen) ctx.fillRect(Math.round(x(t)), top, 1, cssH - top);

        // Clips (repeats slightly darker)
        ctx.font = '10px -apple-system, "Segoe UI", sans-serif';
        ctx.textBaseline = 'middle';
        for (const c of tl.clips) {
            const hue = CLIP_HUES[c.clipIndex % CLIP_HUES.length];
            const x0 = x(c.start);
            const w = Math.max(1, x(c.end) - x0);
            ctx.fillStyle = `hsla(${hue}, 70%, ${c.loop ? 32 : 40}%, 0.85)`;
            ctx.fillRect(x0, top, w, blockH);
            if (w > 24) {
                ctx.save();
                ctx.beginPath();
                ctx.rect(x0 + 2, top, w - 4, blockH);
                ctx.clip();
                ctx.fillStyle = 'rgba(255,255,255,0.9)';
                ctx.fillText(c.loop ? `⟲ ${c.loop + 1}` : c.name, x0 + 5, top + blockH / 2);
                ctx.restore();
            }
        }

        // Transitions
        for (const tr of tl.transitions) {
            const xc = x(tr.time);
            if (tr.style === 'crossfade') {
                const x0 = x(tr.start);
                const x1 = x(tr.end);
                ctx.fillStyle = 'rgba(255,255,255,0.22)';
                ctx.beginPath();
                ctx.moveTo(x0, top + blockH);
                ctx.lineTo(x1, top);
                ctx.lineTo(x1, top + blockH);
                ctx.closePath();
                ctx.fill();
                ctx.strokeStyle = 'rgba(255,255,255,0.8)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(x0, top + blockH);
                ctx.lineTo(x1, top);
                ctx.moveTo(x0, top);
                ctx.lineTo(x1, top + blockH);
                ctx.stroke();
            } else if (tr.style === 'neutral') {
                ctx.fillStyle = 'rgba(255,255,255,0.18)';
                ctx.fillRect(x(tr.start), top, x(tr.end) - x(tr.start), blockH);
                const r = Math.min(6, blockH / 2 - 1);
                ctx.fillStyle = '#ffffff';
                ctx.beginPath();
                ctx.moveTo(xc, top + blockH / 2 - r);
                ctx.lineTo(xc + r, top + blockH / 2);
                ctx.lineTo(xc, top + blockH / 2 + r);
                ctx.lineTo(xc - r, top + blockH / 2);
                ctx.closePath();
                ctx.fill();
            } else {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(Math.round(xc) - 1, top, 2, blockH);
            }
        }

        // Speed changes
        for (const c of tl.speedChanges) {
            const x0 = x(c.start);
            const w = Math.max(2, x(c.end) - x0);
            ctx.fillStyle = c.speed < 1 ? 'rgba(255, 170, 60, 0.9)' : 'rgba(255, 90, 140, 0.9)';
            ctx.fillRect(x0, bandY, w, 8);
            if (w > 18) {
                ctx.fillStyle = '#111';
                ctx.font = 'bold 8px -apple-system, "Segoe UI", sans-serif';
                ctx.fillText(`${fmtNum(c.speed)}×`, x0 + 3, bandY + 4.5);
            }
        }

        // Past the end of the sequence (the dance loops if the song is longer)
        if (tl.duration < duration) {
            ctx.fillStyle = 'rgba(0,0,0,0.45)';
            ctx.fillRect(x(tl.duration), 0, x(duration) - x(tl.duration), cssH);
        }

        // Playhead
        ctx.fillStyle = '#00d9ff';
        ctx.fillRect(Math.round(x(Math.min(currentTime, duration))) - 1, 0, 2, cssH);
    }

    /** What (if anything) is under the pointer: a join or a speed change. */
    _stripHit(e) {
        const tl = this.compiled && this.compiled.timeline;
        const duration = this.host.duration();
        if (!tl || !(duration > 0)) return null;
        const rect = this.strip.getBoundingClientRect();
        const { left, width } = this._stripGeometry();
        const px = e.clientX;
        const xOf = (t) => left + (t / duration) * width;
        let best = null;
        let bestDist = 7;
        tl.transitions.forEach((tr) => {
            const d = Math.abs(px - xOf(tr.time));
            if (d < bestDist) {
                bestDist = d;
                best = {
                    selector: `[data-join="${tr.kind}-${tr.clipIndex}"]`,
                    title: `${TRANSITION_STYLES[tr.style]} — click to edit`,
                };
            }
        });
        if (best) return best;
        if (e.clientY - rect.top >= rect.height - 13) {
            const k = tl.speedChanges.findIndex((c) => px >= xOf(c.start) - 2 && px <= xOf(c.end) + 2);
            if (k >= 0) {
                const index = this.seq.speedChanges.findIndex((c) => c.id === tl.speedChanges[k].id);
                return { selector: `[data-speed="${index}"]`, title: `${fmtNum(tl.speedChanges[k].speed)}× — click to edit` };
            }
        }
        return null;
    }

    _onStripClick(e) {
        const hit = this._stripHit(e);
        if (hit) {
            this.focus(hit.selector);
            return;
        }
        const { left, width } = this._stripGeometry();
        const frac = Math.max(0, Math.min(1, (e.clientX - left) / width));
        this.host.seek(frac * this.host.duration());
    }
}
