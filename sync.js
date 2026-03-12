// AutoChoreo — Transport Sync Engine
// Single source of truth for playback state.
// Animation mixer, audio, scrubber, and UI all subscribe to this controller.

export class TransportController {
    constructor() {
        // Playback state
        this.playing = false;
        this.speed = 1.0;
        this.currentTime = 0;
        this.duration = 0;

        // Subscribers keyed by event name
        this._listeners = {};

        // Audio state
        this._audioCtx = null;
        this._audioBuffer = null;
        this._sourceNode = null;
        this._audioStartOffset = 0; // where in the buffer we started
        this._audioStartWhen = 0;   // audioCtx.currentTime when we started
        this._audioTrackName = null;

        // Animation state
        this._mixer = null;
        this._action = null;
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
        this.duration = Math.max(this.duration, duration);
        if (action) {
            action.setEffectiveTimeScale(this.speed);
        }
        this._emit('durationchange', { duration: this.duration });
    }

    // ── Audio binding ────────────────────────────────────────────────

    async loadAudio(file) {
        if (!this._audioCtx) {
            this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        // Stop any current playback
        this._stopAudioSource();

        const arrayBuffer = await file.arrayBuffer();
        this._audioBuffer = await this._audioCtx.decodeAudioData(arrayBuffer);
        this._audioTrackName = file.name;

        // Audio duration becomes the master duration
        this.duration = this._audioBuffer.duration;
        this._emit('durationchange', { duration: this.duration });
        this._emit('audioloaded', { name: file.name, duration: this._audioBuffer.duration });

        // If already playing, start audio from current position
        if (this.playing) {
            this._startAudioSource(this.currentTime);
        }
    }

    _startAudioSource(offset) {
        if (!this._audioBuffer || !this._audioCtx) return;
        this._stopAudioSource();

        const source = this._audioCtx.createBufferSource();
        source.buffer = this._audioBuffer;
        source.playbackRate.value = this.speed;
        source.connect(this._audioCtx.destination);
        source.start(0, offset);
        source.onended = () => {
            if (this._sourceNode === source) {
                this._sourceNode = null;
            }
        };

        this._sourceNode = source;
        this._audioStartOffset = offset;
        this._audioStartWhen = this._audioCtx.currentTime;
    }

    _stopAudioSource() {
        if (this._sourceNode) {
            try { this._sourceNode.stop(); } catch (_) { /* already stopped */ }
            this._sourceNode = null;
        }
    }

    // ── Transport controls ───────────────────────────────────────────

    play() {
        if (this.playing) return;
        this.playing = true;

        // Resume audio context if suspended (browser autoplay policy)
        if (this._audioCtx && this._audioCtx.state === 'suspended') {
            this._audioCtx.resume();
        }

        if (this._action) {
            this._action.paused = false;
        }
        this._startAudioSource(this.currentTime);

        this._emit('play', { currentTime: this.currentTime });
    }

    pause() {
        if (!this.playing) return;
        this.playing = false;

        // Capture current audio position before stopping
        this._updateCurrentTimeFromAudio();
        this._stopAudioSource();

        if (this._action) {
            this._action.paused = true;
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
        if (this._action) {
            this._action.setEffectiveTimeScale(speed);
        }
        if (this._sourceNode) {
            this._sourceNode.playbackRate.value = speed;
        }
        this._emit('speedchange', { speed });
    }

    seek(time) {
        time = Math.max(0, Math.min(time, this.duration));
        this.currentTime = time;

        // Seek animation
        if (this._mixer && this._action) {
            this._action.time = time;
            this._mixer.setTime(time);
            // After setTime, re-apply speed and paused state
            this._action.setEffectiveTimeScale(this.speed);
            if (!this.playing) {
                this._action.paused = true;
            }
        }

        // Seek audio — restart source from new offset
        if (this.playing) {
            this._startAudioSource(time);
        } else {
            this._audioStartOffset = time;
        }

        this._emit('seek', { currentTime: time });
    }

    // ── Tick — call every frame ──────────────────────────────────────

    tick(delta) {
        if (!this.playing) return;

        // Update mixer
        if (this._mixer) {
            this._mixer.update(delta);
        }

        // Derive currentTime from audio (most accurate) or fallback to accumulation
        if (this._sourceNode && this._audioCtx) {
            this.currentTime = this._audioStartOffset +
                (this._audioCtx.currentTime - this._audioStartWhen) * this.speed;
        } else {
            this.currentTime += delta * this.speed;
        }

        // Clamp
        if (this.currentTime >= this.duration) {
            this.currentTime = this.duration;
            this.pause();
            this._emit('ended', {});
        }

        this._emit('timeupdate', { currentTime: this.currentTime, duration: this.duration });
    }

    _updateCurrentTimeFromAudio() {
        if (this._sourceNode && this._audioCtx) {
            this.currentTime = this._audioStartOffset +
                (this._audioCtx.currentTime - this._audioStartWhen) * this.speed;
        }
    }

    // ── Getters ──────────────────────────────────────────────────────

    get audioTrackName() {
        return this._audioTrackName;
    }

    get hasAudio() {
        return this._audioBuffer !== null;
    }

    get hasAnimation() {
        return this._action !== null;
    }
}
