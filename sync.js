// AutoChoreo — Transport Sync Engine
// Single source of truth for playback state: the musical timeline.
// Music, the animation mixer, reference / recording videos, the scrubber and
// the practice scorer all follow this one clock.
//
// Music plays through an <audio> element with pitch preservation, so slowing a
// routine down to practise it keeps the song in its key (the browser
// time-stretches it). The decoded AudioBuffer is kept as well, for waveforms
// and rhythm analysis.

export class TransportController {
    constructor() {
        // Playback state
        this.playing = false;
        this.speed = 1.0;
        this.currentTime = 0;
        this.duration = 0;
        /** Optional practice range { start, end }: playback stops at its end ('rangeend'). */
        this.range = null;

        // Subscribers keyed by event name
        this._listeners = {};

        // Audio state
        this._audioCtx = null;
        this._audioBuffer = null;
        this._media = null;         // HTMLAudioElement that plays the music
        this._mediaUrl = null;
        this._audioTrackName = null;
        this._anchorTime = 0;       // smooth clock: song time at …
        this._anchorPerf = 0;       // … this performance.now()

        // Animation state
        this._mixer = null;
        this._action = null;
        this._clipDuration = 0;
    }

    // ── Event system ─────────────────────────────────────────────────

    on(event, fn) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(fn);
    }

    off(event, fn) {
        const list = this._listeners[event];
        if (!list) return;
        this._listeners[event] = list.filter(f => f !== fn);
    }

    _emit(event, data) {
        const list = this._listeners[event];
        if (list) list.forEach(fn => fn(data));
    }

    // ── Animation binding ────────────────────────────────────────────

    setAnimation(mixer, action, duration) {
        this._mixer = mixer;
        this._action = action;
        this._clipDuration = action ? duration : 0;
        if (action) {
            // The transport drives the action's time directly (see _syncAnimation),
            // so the action itself never advances on its own.
            action.paused = false;
            action.setEffectiveTimeScale(0);
            // Audio, when loaded, is the master timeline; otherwise the dance is.
            this.duration = this._audioBuffer ? this._audioBuffer.duration : duration;
            if (this.currentTime > this.duration) this.seek(0);
            this._syncAnimation();
            this._emit('durationchange', { duration: this.duration });
        }
    }

    // Pose the animation at the transport's current time. A dance shorter than
    // the master timeline (e.g. a long audio track) loops.
    _syncAnimation() {
        if (!this._mixer || !this._action) return;
        const clip = this._clipDuration;
        let t = Math.max(0, this.currentTime);
        if (clip > 0 && t >= clip) {
            // Hold the final pose when the dance itself is the whole timeline; otherwise loop
            t = this.duration <= clip + 1e-6 ? clip : t % clip;
        }
        this._action.time = t;
        this._mixer.update(0);
    }

    // ── Audio binding ────────────────────────────────────────────────

    get audioContext() {
        if (!this._audioCtx) this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        return this._audioCtx;
    }

    /** Load music (an audio file, or a video whose soundtrack to use). Throws if it has no decodable audio. */
    async loadAudio(file, name = file.name) {
        const arrayBuffer = await file.arrayBuffer();
        const buffer = await this.audioContext.decodeAudioData(arrayBuffer);

        this._releaseMedia();
        this._audioBuffer = buffer;
        this._audioTrackName = name;
        this._mediaUrl = URL.createObjectURL(file);
        const media = new Audio();
        media.preload = 'auto';
        media.preservesPitch = true;
        media.mozPreservesPitch = true;
        media.webkitPreservesPitch = true;
        media.src = this._mediaUrl;
        this._media = media;

        // Audio duration becomes the master duration
        this.duration = buffer.duration;
        if (this.currentTime > this.duration) this.seek(0);
        this._emit('durationchange', { duration: this.duration });
        this._emit('audioloaded', { name, duration: buffer.duration });

        if (this.playing) this._startMedia(this.currentTime);
    }

    /** Remove the loaded audio; the dance becomes the master timeline again. */
    clearAudio() {
        this._releaseMedia();
        this._audioBuffer = null;
        this._audioTrackName = null;
        if (this._action) {
            this.duration = this._clipDuration;
            if (this.currentTime > this.duration) this.seek(0);
            this._emit('durationchange', { duration: this.duration });
        }
        this._emit('audioloaded', { name: '', duration: 0 });
    }

    _releaseMedia() {
        if (this._media) {
            this._media.pause();
            this._media.removeAttribute('src');
            this._media.load();
            this._media = null;
        }
        if (this._mediaUrl) {
            URL.revokeObjectURL(this._mediaUrl);
            this._mediaUrl = null;
        }
    }

    _anchor(time) {
        this._anchorTime = time;
        this._anchorPerf = performance.now();
    }

    _startMedia(offset) {
        const media = this._media;
        if (!media) return;
        media.playbackRate = this.speed;
        if (Math.abs(media.currentTime - offset) > 0.005) media.currentTime = offset;
        const started = media.play();
        if (started && started.catch) {
            started.catch((err) => {
                if (err.name === 'AbortError') return; // paused / seeked before it began
                console.warn('Music could not start:', err);
                this._emit('error', { message: `Music could not start (${err.message}). Click play again.` });
                this.pause();
            });
        }
        this._anchor(offset);
    }

    // ── Transport controls ───────────────────────────────────────────

    play() {
        if (this.playing) return;
        // Pressing play at the end starts over (from the range start, if any)
        const start = this.range ? this.range.start : 0;
        const end = this.range ? this.range.end : this.duration;
        if (this.duration > 0 && (this.currentTime >= end - 1e-3 || this.currentTime < start - 1e-3)) this.seek(start);
        this.playing = true;

        // Resume audio context if suspended (browser autoplay policy)
        if (this._audioCtx && this._audioCtx.state === 'suspended') {
            this._audioCtx.resume();
        }

        this._startMedia(this.currentTime);
        this._anchor(this.currentTime);
        this._tickPerf = performance.now();
        this._emit('play', { currentTime: this.currentTime });
    }

    pause() {
        if (!this.playing) return;
        this.playing = false;
        if (this._media) {
            this._media.pause();
            this.currentTime = Math.min(this._media.currentTime, this.range ? this.range.end : this.duration);
        }
        this._emit('pause', { currentTime: this.currentTime });
    }

    togglePlayPause() {
        if (this.playing) {
            this.pause();
        } else {
            this.play();
        }
    }

    setSpeed(speed) {
        this.speed = speed;
        if (this._media) this._media.playbackRate = speed;
        this._anchor(this.currentTime);
        this._emit('speedchange', { speed });
    }

    seek(time) {
        time = Math.max(0, Math.min(time, this.duration));
        this.currentTime = time;

        // Seek animation
        this._syncAnimation();

        if (this._media) this._media.currentTime = time;
        this._anchor(time);

        this._emit('seek', { currentTime: time });
    }

    /** Limit playback to [start, end]; it stops (and emits 'rangeend') at the end. null clears it. */
    setRange(range) {
        this.range = range ? { start: Math.max(0, range.start), end: Math.min(range.end, this.duration || range.end) } : null;
        this._emit('rangechange', { range: this.range });
    }

    // ── Tick — call every frame ──────────────────────────────────────

    tick(delta) {
        if (!this.playing) return;
        this._tickPerf = performance.now();

        const media = this._media;
        if (media) {
            // Follow the music. Its reported position can be coarse, so run a
            // smooth clock that is steered toward it — never backwards, which
            // would look like a seek to everything following the clock.
            const predicted = this._anchorTime + ((performance.now() - this._anchorPerf) / 1000) * this.speed;
            const actual = media.currentTime;
            const diff = actual - predicted;
            if (media.seeking || media.readyState < 3 || diff > 0.08) {
                if (actual >= this.currentTime || media.seeking) this.currentTime = actual;
            } else if (diff >= -0.08) {
                this.currentTime = Math.max(this.currentTime, predicted + 0.15 * diff);
            } // else: the music is still starting up — hold until it catches up
            this._anchor(this.currentTime);
            if (media.ended) this.currentTime = this.duration;
        } else {
            this.currentTime += delta * this.speed;
        }

        // Clamp
        const end = this.range ? this.range.end : this.duration;
        const ended = this.currentTime >= end;
        if (ended) this.currentTime = end;

        // The animation follows the transport clock, so it can never drift from the audio
        this._syncAnimation();

        if (ended) {
            this.pause();
            this.currentTime = end;
            this._emit(this.range ? 'rangeend' : 'ended', {});
        }

        this._emit('timeupdate', { currentTime: this.currentTime, duration: this.duration });
    }

    /**
     * Song time at a moment given in performance.now() milliseconds (e.g. when
     * a camera frame was captured), extrapolated from the running clock.
     */
    songTimeAt(perfMs) {
        if (!this.playing) return this.currentTime;
        // currentTime was set at the last tick, which may be a while ago when the
        // page is busy (e.g. running the pose model): extrapolate from that moment.
        const since = this._tickPerf != null ? this._tickPerf : performance.now();
        return this.currentTime + ((perfMs - since) / 1000) * this.speed;
    }

    /** Seconds between the music leaving the browser and reaching the speakers (when the browser reports it). */
    get outputLatency() {
        const ctx = this._audioCtx;
        if (!ctx) return 0;
        return (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    }

    // ── Getters ──────────────────────────────────────────────────────

    get audioTrackName() {
        return this._audioTrackName;
    }

    get hasAudio() {
        return this._audioBuffer !== null;
    }

    get audioBuffer() {
        return this._audioBuffer;
    }

    get hasAnimation() {
        return this._action !== null;
    }

    /** Time within the dance clip being shown (differs from currentTime when the dance loops). */
    get animationTime() {
        return this._action ? this._action.time : 0;
    }
}
