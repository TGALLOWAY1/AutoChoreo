// AutoChoreo — Lesson plan of a routine
//
// A routine is learned in steps: watch it, learn it an eight at a time, then
// put it together. The steps follow the routine's beat grid (./choreo/rhythm.js),
// so each one is a whole number of counts.

import { buildSections } from '../choreo/rhythm.js';
import { sectionKey } from './progress.js';

/**
 * @param {object} meta  Routine metadata: { duration, rhythm: { bpm, offset } }
 * @returns {Array<{ key, kind: 'watch'|'section'|'full', label, sublabel, start, end, startBeat?, endBeat? }>}
 */
export function lessonSteps(meta) {
    const duration = meta.duration;
    const steps = [{ key: 'watch', kind: 'watch', label: 'Watch & break down', sublabel: 'See the whole routine slowly', start: 0, end: duration }];
    const sections = meta.rhythm ? buildSections({ ...meta.rhythm, duration }) : [];
    if (sections.length > 1) {
        for (const s of sections) {
            steps.push({
                key: sectionKey(s), kind: 'section', label: `Learn ${s.label.toLowerCase()}`, sublabel: `Section ${String.fromCharCode(65 + s.index)}`,
                start: s.start, end: s.end, startBeat: s.startBeat, endBeat: s.endBeat, index: s.index,
            });
        }
    }
    const totalBeats = sections.length ? sections[sections.length - 1].endBeat : 0;
    steps.push({
        key: 'full', kind: 'full', label: 'Full routine', sublabel: totalBeats ? `All ${totalBeats} counts` : 'Start to finish',
        start: 0, end: duration, startBeat: 0, endBeat: totalBeats,
    });
    return steps;
}

/** Steps that count toward mastery. */
export const learnableSteps = (steps) => steps.filter((s) => s.kind === 'section' || s.kind === 'full');

/** Sections of a routine (A, B, C …) for loop chips. */
export function routineSections(meta) {
    return meta.rhythm ? buildSections({ ...meta.rhythm, duration: meta.duration }) : [];
}

/** "32 counts · 4 sections" style summary. */
export function countsSummary(meta) {
    const sections = routineSections(meta);
    if (!sections.length) return '';
    const total = sections[sections.length - 1].endBeat;
    return `${total} counts · ${sections.length} section${sections.length === 1 ? '' : 's'}`;
}
