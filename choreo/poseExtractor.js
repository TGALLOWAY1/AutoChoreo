// AutoChoreo — Pose extraction (video → body landmarks)
//
// Runs MediaPipe Pose Landmarker over every frame of a video, entirely in the
// browser, and returns a "capture": 33 body landmarks per frame, both in image
// coordinates and as estimated 3D positions in metres.
//
// This is deliberately the only module that knows about MediaPipe. Swapping in
// a stronger motion-reconstruction model later only means producing the same
// capture structure.

const MEDIAPIPE_VERSION = '0.10.14';
const MEDIAPIPE_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;
const MODEL_BASE = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker';

/**
 * "full" (≈9 MB) is the default: it is about 3× faster than "heavy" (≈30 MB) and
 * tracked a stylised test dancer more accurately. "heavy" may do better on
 * photorealistic footage; "lite" is the fastest.
 */
export const POSE_MODELS = {
    lite: `${MODEL_BASE}/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
    full: `${MODEL_BASE}/pose_landmarker_full/float16/1/pose_landmarker_full.task`,
    heavy: `${MODEL_BASE}/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task`,
};

const LANDMARKS = 33;

let visionPromise = null;
function loadVision() {
    if (!visionPromise) {
        visionPromise = (async () => {
            const vision = await import(/* @vite-ignore */ `${MEDIAPIPE_BASE}/vision_bundle.mjs`);
            const fileset = await vision.FilesetResolver.forVisionTasks(`${MEDIAPIPE_BASE}/wasm`);
            return { vision, fileset };
        })();
        visionPromise.catch(() => { visionPromise = null; }); // allow a retry after a network failure
    }
    return visionPromise;
}

/**
 * Create a landmarker on the requested delegate ("GPU" or "CPU").
 * Returns { landmarker, delegate } — the delegate may be CPU if GPU could not start.
 */
async function createLandmarker(model, delegate) {
    const { vision, fileset } = await loadVision();
    const options = (delegate) => ({
        baseOptions: { modelAssetPath: POSE_MODELS[model] || POSE_MODELS.full, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
        // Below MediaPipe's 0.5 defaults: stylised or AI-generated dancers often score
        // just under them, and a frame that is still missed is interpolated by the solver.
        minPoseDetectionConfidence: 0.3,
        minPosePresenceConfidence: 0.3,
        minTrackingConfidence: 0.3,
    });
    if (delegate === 'GPU') {
        try {
            return { landmarker: await vision.PoseLandmarker.createFromOptions(fileset, options('GPU')), delegate: 'GPU' };
        } catch (err) {
            console.warn('Pose model: GPU unavailable, falling back to CPU.', err);
        }
    }
    return { landmarker: await vision.PoseLandmarker.createFromOptions(fileset, options('CPU')), delegate: 'CPU' };
}

function once(target, event, errorEvent = 'error') {
    return new Promise((resolve, reject) => {
        const ok = () => { cleanup(); resolve(); };
        const fail = () => { cleanup(); reject(new Error('The video could not be decoded by this browser')); };
        const cleanup = () => {
            target.removeEventListener(event, ok);
            target.removeEventListener(errorEvent, fail);
        };
        target.addEventListener(event, ok);
        target.addEventListener(errorEvent, fail);
    });
}

async function seekTo(video, time) {
    if (Math.abs(video.currentTime - time) < 1e-4 && video.readyState >= 2) return;
    const done = once(video, 'seeked');
    video.currentTime = time;
    await done;
}

/**
 * Measure the video's real frame rate by watching a short stretch of playback,
 * so we sample each source frame exactly once (sampling a 24 fps clip at 30 fps
 * would repeat every fifth frame and make the motion stutter).
 */
async function detectFrameRate(video, fallback) {
    if (typeof video.requestVideoFrameCallback !== 'function') return fallback;
    const stamps = [];
    try {
        await seekTo(video, 0);
        await new Promise((resolve) => {
            const timeout = setTimeout(resolve, 1500);
            const onFrame = (_now, meta) => {
                stamps.push(meta.mediaTime);
                if (stamps.length >= 12) { clearTimeout(timeout); resolve(); return; }
                video.requestVideoFrameCallback(onFrame);
            };
            video.requestVideoFrameCallback(onFrame);
            video.play().catch(() => { clearTimeout(timeout); resolve(); });
        });
    } finally {
        video.pause();
    }
    const deltas = [];
    for (let i = 1; i < stamps.length; i++) {
        const d = stamps[i] - stamps[i - 1];
        if (d > 1e-4) deltas.push(d);
    }
    if (deltas.length < 4) return fallback;
    deltas.sort((a, b) => a - b);
    const fps = 1 / deltas[deltas.length >> 1];
    if (!(fps >= 10 && fps <= 120)) return fallback;
    // Snap to the nearest common rate so tiny timing noise does not give 29.93 or 24.2
    let best = fps;
    let bestError = 0.02;
    for (const common of [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60]) {
        const error = Math.abs(fps - common) / common;
        if (error < bestError) { best = common; bestError = error; }
    }
    return best;
}

function flatten(landmarks) {
    const out = new Float32Array(LANDMARKS * 4);
    for (let i = 0; i < LANDMARKS; i++) {
        const lm = landmarks[i];
        out[i * 4] = lm.x;
        out[i * 4 + 1] = lm.y;
        out[i * 4 + 2] = lm.z;
        out[i * 4 + 3] = lm.visibility ?? 1;
    }
    return out;
}

/**
 * Extract body landmarks from every frame of a video.
 *
 * @param {File|Blob|string} source   Video file, blob, or URL.
 * @param {object} [options]
 * @param {'lite'|'full'|'heavy'} [options.model='full']
 * @param {'auto'|'GPU'|'CPU'} [options.delegate='auto']
 *        'auto' uses the GPU and re-runs on the CPU if the GPU pass finds nobody
 *        (some graphics drivers / software renderers give the model bad results).
 * @param {number} [options.fps]            Force a sampling rate instead of detecting the video's own.
 * @param {number} [options.maxDuration=60] Seconds of video to analyse at most.
 * @param {(progress: {stage: string, fraction: number}) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<object>} capture:
 *   { name, fps, frameCount, duration, width, height,
 *     world: (Float32Array|null)[],  // per frame: 33 × (x, y, z, visibility), metres, hip-centred
 *     image: (Float32Array|null)[] } // per frame: 33 × (x, y, z, visibility), normalised to the frame
 *   A frame's entry is null when no person was detected in it.
 */
export async function extractPoseFromVideo(source, options = {}) {
    const { model = 'full', delegate = 'auto', maxDuration = 60, onProgress = () => {}, signal } = options;
    const isUrl = typeof source === 'string';
    // Frame-accurate seeking needs the whole file in memory: a streamed URL may not be seekable
    const blob = isUrl ? await (await fetch(source)).blob() : source;
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';

    let landmarker = null;
    try {
        onProgress({ stage: 'Loading pose model', fraction: 0 });
        const loaded = once(video, 'loadeddata');
        video.src = url;
        let active;
        [{ landmarker, delegate: active }] = await Promise.all([
            createLandmarker(model, delegate === 'CPU' ? 'CPU' : 'GPU'),
            loaded,
        ]);

        // Some recordings (e.g. MediaRecorder WebM) report an infinite duration until seeked to the end
        if (!Number.isFinite(video.duration)) {
            await seekTo(video, 1e7);
            await seekTo(video, 0);
        }
        const duration = Math.min(video.duration, maxDuration);
        if (!(duration > 0) || !video.videoWidth) throw new Error('The video has no readable frames');

        const fps = options.fps || await detectFrameRate(video, 30);
        const frameCount = Math.max(1, Math.floor(duration * fps + 1e-6));
        let world;
        let image;
        // Enough frames to tell "the GPU pass is blind" from "the dancer walks on late"
        const probeFrames = Math.min(frameCount, Math.max(15, Math.round(fps * 1.5)));

        for (;;) {
            world = new Array(frameCount).fill(null);
            image = new Array(frameCount).fill(null);
            let detected = 0;
            let retryOnCpu = false;
            for (let f = 0; f < frameCount; f++) {
                if (signal?.aborted) throw new DOMException('Video analysis cancelled', 'AbortError');
                // Aim at the middle of each source frame so rounding never lands on a neighbour
                const time = Math.min((f + 0.5) / fps, Math.max(0, video.duration - 1e-3));
                await seekTo(video, time);
                if (Math.abs(video.currentTime - time) > 1.5 / fps) {
                    throw new Error('This video cannot be stepped through frame by frame');
                }
                const result = landmarker.detectForVideo(video, Math.round((f / fps) * 1000));
                if (result.worldLandmarks && result.worldLandmarks.length > 0) {
                    world[f] = flatten(result.worldLandmarks[0]);
                    image[f] = flatten(result.landmarks[0]);
                    detected++;
                }
                onProgress({ stage: 'Analyzing video', fraction: (f + 1) / frameCount });
                // Yield so the page can repaint the progress indicator
                if (f % 4 === 3) await new Promise((r) => setTimeout(r, 0));

                if (delegate === 'auto' && active === 'GPU' && detected === 0 && f + 1 >= probeFrames) {
                    retryOnCpu = true;
                    break;
                }
            }
            if (!retryOnCpu) break;
            console.warn('Pose model: nobody detected on the GPU, retrying on the CPU.');
            landmarker.close();
            landmarker = null;
            ({ landmarker, delegate: active } = await createLandmarker(model, 'CPU'));
        }

        return {
            name: (!isUrl && source.name) ? source.name.replace(/\.[^.]+$/, '') : 'Video dance',
            fps,
            frameCount,
            duration: frameCount / fps,
            width: video.videoWidth,
            height: video.videoHeight,
            world,
            image,
        };
    } finally {
        if (landmarker) landmarker.close();
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
    }
}
