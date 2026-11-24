// AutoChoreo — Skeleton overlays
//
// Draws tracked joints over a video or a 3D view: the reference in the accent
// colour, the dancer coloured per body part by how well it matches (green /
// amber / red), so the differences are visible at a glance.

import { KP, KP_BONES, KP_COUNT, KEYPOINTS, SEGMENTS } from '../choreo/compare.js';

export const COLORS = {
    reference: '#b57bff',
    referenceGlow: 'rgba(181, 123, 255, 0.55)',
    neutral: '#e8e2ff',
    good: '#4ade80',
    warn: '#facc15',
    bad: '#f87171',
};

export function scoreColor(score) {
    if (score == null || !Number.isFinite(score)) return COLORS.neutral;
    if (score >= 0.75) return COLORS.good;
    if (score >= 0.5) return COLORS.warn;
    return COLORS.bad;
}

/** For each stick-figure bone, the body-part segment it belongs to (or −1). */
export const BONE_SEGMENT = KP_BONES.map(([a, b]) => SEGMENTS.findIndex((s) => (s.from === a && s.to === b) || (s.from === b && s.to === a)));

/** Per keypoint: the worst score of the segments that end at it. */
export function keypointScores(segmentScores) {
    const out = new Array(KP_COUNT).fill(null);
    if (!segmentScores) return out;
    SEGMENTS.forEach((s, i) => {
        if (s.from == null || !Number.isFinite(segmentScores[i])) return;
        for (const k of [s.from, s.to]) out[k] = out[k] == null ? segmentScores[i] : Math.min(out[k], segmentScores[i]);
    });
    return out;
}

/**
 * Draw a stick figure from 2D points (array of [x, y] or null per keypoint).
 * @param {object} o { color, segmentScores, lineWidth, glow }
 */
export function drawSkeleton2D(ctx, points, { color = COLORS.reference, segmentScores = null, lineWidth = 3, glow = null } = {}) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = lineWidth;
    if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = lineWidth * 3; }
    KP_BONES.forEach(([a, b], i) => {
        if (!points[a] || !points[b]) return;
        const seg = BONE_SEGMENT[i];
        ctx.strokeStyle = segmentScores && seg >= 0 ? scoreColor(segmentScores[seg]) : color;
        ctx.beginPath();
        ctx.moveTo(points[a][0], points[a][1]);
        ctx.lineTo(points[b][0], points[b][1]);
        ctx.stroke();
    });
    // Neck → head
    const ls = points[KP.leftShoulder];
    const rs = points[KP.rightShoulder];
    const nose = points[KP.nose];
    if (ls && rs && nose) {
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo((ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2);
        ctx.lineTo(nose[0], nose[1]);
        ctx.stroke();
    }
    ctx.shadowBlur = 0;
    const kpScores = segmentScores ? keypointScores(segmentScores) : null;
    for (let k = 1; k < KP_COUNT; k++) {
        const p = points[k];
        if (!p) continue;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(p[0], p[1], lineWidth * 1.35, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = kpScores && kpScores[k] != null ? scoreColor(kpScores[k]) : color;
        ctx.beginPath();
        ctx.arc(p[0], p[1], lineWidth * 0.8, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.restore();
}

/**
 * 2D keypoints from MediaPipe image landmarks (33 × x, y, z, visibility,
 * normalised), in pixels of a `width` × `height` frame. Barely visible points are dropped.
 */
export function imagePoints(landmarks, width, height, minVisibility = 0.35) {
    return KEYPOINTS.map(([, lm]) => {
        const v = landmarks[lm * 4 + 3];
        if (v < minVisibility) return null;
        return [landmarks[lm * 4] * width, landmarks[lm * 4 + 1] * height];
    });
}

/**
 * Size a canvas to its element's displayed size (× device pixel ratio) and
 * return a context scaled to CSS pixels, plus the content box of a video shown
 * with object-fit: contain/cover inside it.
 */
export function prepareCanvas(canvas, media = null, fit = 'contain') {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    let box = { x: 0, y: 0, width: w, height: h };
    const mw = media?.videoWidth || media?.width;
    const mh = media?.videoHeight || media?.height;
    if (mw && mh) {
        const scale = fit === 'cover' ? Math.max(w / mw, h / mh) : Math.min(w / mw, h / mh);
        box = { x: (w - mw * scale) / 2, y: (h - mh * scale) / 2, width: mw * scale, height: mh * scale };
    }
    return { ctx, box, width: w, height: h };
}

/** Map normalised-image points into a content box. */
export function toBox(points, box) {
    return points.map((p) => (p ? [box.x + p[0] * box.width, box.y + p[1] * box.height] : null));
}
