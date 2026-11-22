// AutoChoreo — Shared UI helpers for the learning pages (icons, formatting, toasts).

const svg = (body, { fill = false } = {}) =>
    `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="${fill ? 'currentColor' : 'none'}" stroke="${fill ? 'none' : 'currentColor'}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
    home: svg('<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/><path d="M10 19.5v-5h4v5"/>'),
    learn: svg('<path d="M7 4.5v15l12-7.5z"/>'),
    library: svg('<path d="m12 3 9 4.5-9 4.5-9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>'),
    upload: svg('<path d="M12 15V4"/><path d="m7.5 8.5 4.5-4.5 4.5 4.5"/><path d="M4 15v4.5h16V15"/>'),
    progress: svg('<path d="M5 20v-6"/><path d="M10 20V10"/><path d="M15 20V6"/><path d="M20 20V3"/>'),
    history: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
    settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>'),
    choreograph: svg('<circle cx="12" cy="4.5" r="2"/><path d="M12 7v6"/><path d="m7 9.5 5 1.5 5-3"/><path d="m9 21 3-8 3 8"/>'),
    play: svg('<path d="M7 4.5v15l12-7.5z"/>', { fill: true }),
    pause: svg('<rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/>', { fill: true }),
    back: svg('<path d="m15 5-7 7 7 7"/>'),
    check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
    star: svg('<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>'),
    starFilled: svg('<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>', { fill: true }),
    loop: svg('<path d="M17 2.5 20.5 6 17 9.5"/><path d="M3.5 11V9.5a3.5 3.5 0 0 1 3.5-3.5h13.5"/><path d="M7 21.5 3.5 18 7 14.5"/><path d="M20.5 13v1.5a3.5 3.5 0 0 1-3.5 3.5H3.5"/>'),
    rewind: svg('<path d="M11 6.5 4.5 12l6.5 5.5z"/><path d="M19.5 6.5 13 12l6.5 5.5z"/>', { fill: true }),
    forward: svg('<path d="m13 6.5 6.5 5.5-6.5 5.5z"/><path d="m4.5 6.5 6.5 5.5-6.5 5.5z"/>', { fill: true }),
    prev: svg('<path d="M15 6.5 8.5 12l6.5 5.5z"/>', { fill: true }),
    next: svg('<path d="m9 6.5 6.5 5.5L9 17.5z"/>', { fill: true }),
    camera: svg('<rect x="2.5" y="6.5" width="13" height="11" rx="2"/><path d="m15.5 10.5 6-3.5v10l-6-3.5"/>'),
    film: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>'),
    search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
    more: svg('<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>', { fill: true }),
    link: svg('<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>'),
    sparkle: svg('<path d="M12 3c.6 4.2 2.8 6.4 7 7-4.2.6-6.4 2.8-7 7-.6-4.2-2.8-6.4-7-7 4.2-.6 6.4-2.8 7-7z"/><path d="M19 15.5c.3 1.6 1 2.3 2.5 2.5-1.5.3-2.2 1-2.5 2.5-.3-1.5-1-2.2-2.5-2.5 1.5-.2 2.2-.9 2.5-2.5z"/>', { fill: true }),
    timer: svg('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 1.5"/><path d="M9.5 2.5h5"/>'),
    pose: svg('<circle cx="12" cy="4.5" r="2"/><path d="M5 9.5h14"/><path d="M12 7.5v6.5"/><path d="m8 21 4-7 4 7"/>'),
    motion: svg('<path d="M3 15c2.5 0 3-6 5.5-6s3 8 5.5 8 3-6 5-6h2"/>'),
    target: svg('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>'),
    metronome: svg('<path d="M9 3h6l3.5 18h-13z"/><path d="m12 15 5.5-8"/><path d="M7 17h10"/>'),
    mirror: svg('<path d="M12 3v18"/><path d="M8.5 7 4 12l4.5 5z"/><path d="m15.5 7 4.5 5-4.5 5z"/>'),
    close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    minus: svg('<path d="M5 12h14"/>'),
    trash: svg('<path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 13h9l1-13"/>'),
    music: svg('<path d="M9 18V5.5l11-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>'),
    alert: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5"/><circle cx="12" cy="16.3" r=".6" fill="currentColor"/>'),
    expand: svg('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>'),
    flame: svg('<path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2.5 1.5-3.5 2-5.5 1 1.5 1.5 2 2.5 2.5C12 8 11.5 5.5 12 3z"/>'),
};

export function logoMark(size = 34) {
    return `<svg class="logo-mark" viewBox="0 0 40 40" width="${size}" height="${size}" aria-hidden="true">
<defs><linearGradient id="lg-${size}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c084fc"/><stop offset="1" stop-color="#6d28d9"/></linearGradient></defs>
<path d="M4 31 14.5 9 20 22l5.5-13L36 31" fill="none" stroke="url(#lg-${size})" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function fmtClock(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtDuration(seconds) {
    if (!(seconds > 0)) return '0 min';
    if (seconds < 60) return `${Math.round(seconds)} s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
    return `${(seconds / 3600).toFixed(1)} hr`;
}

export function fmtDay(ms, now = Date.now()) {
    const d = new Date(ms);
    const today = new Date(now);
    const sameDay = (a, b) => a.toDateString() === b.toDateString();
    if (sameDay(d, today)) return 'Today';
    const y = new Date(now - 86400000);
    if (sameDay(d, y)) return 'Yesterday';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const fmtTempo = (t) => `${Math.round(t * 100) / 100}×`;
export const pct = (x) => (x == null ? '—' : `${Math.round(x)}%`);

/** A class name for a 0–100 score: good / warn / bad. */
export function scoreClass(score) {
    if (score == null) return '';
    return score >= 75 ? 'good' : score >= 50 ? 'warn' : 'bad';
}

/** Small message at the bottom of the page. */
export function toast(message, { tone = 'info', ms = 3500 } = {}) {
    let host = document.getElementById('toastHost');
    if (!host) {
        host = document.createElement('div');
        host.id = 'toastHost';
        host.setAttribute('role', 'status');
        document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = `toast ${tone}`;
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => {
        el.classList.add('out');
        setTimeout(() => el.remove(), 300);
    }, ms);
}

/** Fill an element's [data-icon] children with icons. */
export function hydrateIcons(root = document) {
    root.querySelectorAll('[data-icon]').forEach((el) => {
        const name = el.getAttribute('data-icon');
        if (ICONS[name] && !el.querySelector('svg')) el.insertAdjacentHTML('afterbegin', ICONS[name]);
    });
    root.querySelectorAll('[data-logo]').forEach((el) => {
        if (!el.querySelector('svg')) el.insertAdjacentHTML('afterbegin', logoMark(Number(el.getAttribute('data-logo')) || 34));
    });
}

/** SVG ring gauge markup for a 0–1 value. */
export function ring(value, { size = 150, stroke = 12, id = 'ring' } = {}) {
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const v = Math.max(0, Math.min(1, value ?? 0));
    return `<svg class="ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
<defs><linearGradient id="${id}-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#4ade80"/></linearGradient></defs>
<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="${stroke}"/>
<circle class="ring-value" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="url(#${id}-g)" stroke-width="${stroke}" stroke-linecap="round"
 stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - v)}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`;
}

export function setRing(svgEl, value) {
    const circle = svgEl?.querySelector('.ring-value');
    if (!circle) return;
    const c = Number(circle.getAttribute('stroke-dasharray'));
    circle.setAttribute('stroke-dashoffset', String(c * (1 - Math.max(0, Math.min(1, value ?? 0)))));
}
