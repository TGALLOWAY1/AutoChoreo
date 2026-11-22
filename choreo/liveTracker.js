// AutoChoreo — Live pose tracking (camera → body landmarks, every frame)
//
// The live counterpart of ./poseExtractor.js: the same MediaPipe Pose model,
// run on each new camera frame as it arrives. Each result is stamped with when
// the frame was captured, so the practice scorer can place it on the musical
// timeline even though tracking takes a few milliseconds.

import { createLandmarker } from './poseExtractor.js';

const LANDMARKS = 33;

function flatten(landmarks, out) {
    for (let i = 0; i < LANDMARKS; i++) {
        const lm = landmarks[i];
        out[i * 4] = lm.x;
        out[i * 4 + 1] = lm.y;
        out[i * 4 + 2] = lm.z;
        out[i * 4 + 3] = lm.visibility ?? 1;
    }
    return out;
}

export class LiveTracker {
    /**
     * @param {object} o
     * @param {(pose: { world: Float32Array|null, image: Float32Array|null, captureTime: number, latencyKnown: boolean }) => void} o.onPose
     *        captureTime is in performance.now() milliseconds.
     * @param {'lite'|'full'|'heavy'} [o.model='full']
     * @param {number} [o.assumedLatencyMs=60]  Camera latency to assume when the browser does not report capture times.
     */
    constructor({ onPose, model = 'full', assumedLatencyMs = 60 }) {
        this.onPose = onPose;
        this.model = model;
        this.assumedLatencyMs = assumedLatencyMs;
        this.video = null;
        this.stream = null;
        this.landmarker = null;
        this.delegate = null;
        this.running = false;
        this.lastTimestamp = 0;
        this.frames = 0;
        this.detections = 0;
        this.fps = 0;
        this._fpsWindow = [];
        this._callbackId = null;
    }

    /** Ask for the camera and show it in `video`. */
    async openCamera(video, { deviceId } = {}) {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot use a camera here (it needs https or localhost).');
        this.stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 720 } },
        });
        video.srcObject = this.stream;
        video.muted = true;
        video.playsInline = true;
        await video.play();
        this.video = video;
        return this.stream;
    }

    /** Load the pose model and start tracking every frame of the camera video. */
    async start() {
        if (!this.video) throw new Error('Open the camera first');
        if (!this.landmarker) {
            const { landmarker, delegate } = await createLandmarker(this.model, 'GPU');
            this.landmarker = landmarker;
            this.delegate = delegate;
        }
        this.running = true;
        this._startedAt = performance.now();
        this._schedule();
    }

    _schedule() {
        if (!this.running) return;
        const video = this.video;
        if (typeof video.requestVideoFrameCallback === 'function') {
            this._callbackId = video.requestVideoFrameCallback((now, meta) => this._onFrame(now, meta));
        } else {
            this._callbackId = requestAnimationFrame((now) => this._onFrame(now, null));
        }
    }

    _onFrame(now, meta) {
        if (!this.running) return;
        const video = this.video;
        if (!meta && video.currentTime === this._lastVideoTime) { this._schedule(); return; }
        this._lastVideoTime = video.currentTime;
        // Which moment the frame shows: the browser's capture time when it reports one
        const latencyKnown = !!(meta && meta.captureTime);
        const captureTime = latencyKnown ? meta.captureTime : now - this.assumedLatencyMs;
        const timestamp = Math.max(this.lastTimestamp + 1, Math.round(performance.now()));
        this.lastTimestamp = timestamp;
        let result = null;
        try {
            result = this.landmarker.detectForVideo(video, timestamp);
        } catch (err) {
            console.warn('Pose tracking failed on a frame:', err);
        }
        this.frames++;
        const found = result && result.worldLandmarks && result.worldLandmarks.length > 0;
        if (found) this.detections++;
        this._fpsWindow.push(now);
        while (this._fpsWindow.length && this._fpsWindow[0] < now - 1000) this._fpsWindow.shift();
        this.fps = this._fpsWindow.length;
        this.onPose({
            world: found ? flatten(result.worldLandmarks[0], new Float32Array(LANDMARKS * 4)) : null,
            image: found ? flatten(result.landmarks[0], new Float32Array(LANDMARKS * 4)) : null,
            captureTime,
            latencyKnown,
        });
        this._maybeFallBackToCpu(now);
        this._schedule();
    }

    // Some graphics drivers run the GPU model but return nothing: if nobody has
    // been found for a few seconds on the GPU, try the CPU once.
    async _maybeFallBackToCpu(now) {
        if (this.delegate !== 'GPU' || this.detections > 0 || this._retrying || now - this._startedAt < 4000) return;
        this._retrying = true;
        console.warn('Live tracking: nobody detected on the GPU, retrying on the CPU.');
        const old = this.landmarker;
        try {
            const { landmarker, delegate } = await createLandmarker(this.model, 'CPU');
            this.landmarker = landmarker;
            this.delegate = delegate;
            old.close();
        } catch (err) {
            console.warn('CPU tracking unavailable:', err);
        }
    }

    stop() {
        this.running = false;
        if (this._callbackId != null && this.video) {
            if (typeof this.video.cancelVideoFrameCallback === 'function') this.video.cancelVideoFrameCallback(this._callbackId);
            else cancelAnimationFrame(this._callbackId);
        }
        this._callbackId = null;
    }

    /** Stop tracking and release the camera and the model. */
    close() {
        this.stop();
        if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
        if (this.video) this.video.srcObject = null;
        this.video = null;
        if (this.landmarker) this.landmarker.close();
        this.landmarker = null;
    }
}
