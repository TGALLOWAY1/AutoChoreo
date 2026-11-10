// AutoChoreo — Choreography
//
// The reusable, character-independent representation of a dance:
// a time-indexed sequence of joint rotations plus a root (hips) trajectory,
// expressed against the canonical skeleton in ./skeleton.js.
//
// This is the "sheet music" of a dance. It records what the body does, not what
// the dancer looks like — any character rig can perform it via ./retarget.js,
// and it can be produced from a video (./solver.js) or from mocap.

import { JOINTS, JOINT_NAMES } from './skeleton.js';

export const CHOREOGRAPHY_FORMAT = 'autochoreo.choreography';
export const CHOREOGRAPHY_VERSION = 1;

export class Choreography {
    /**
     * @param {object} init
     * @param {string} init.name
     * @param {number} init.fps            Frames per second (frames are uniformly spaced).
     * @param {number} init.frameCount
     * @param {Object<string, Float32Array>} init.rotations
     *        Per joint: frameCount × 4 quaternion components (x, y, z, w). Each is the
     *        joint's rotation relative to its parent joint, measured from the T-pose.
     * @param {Float32Array} init.rootPositions
     *        frameCount × 3. Position of the hip-joint midpoint in units of the
     *        dancer's standing hip height (so y ≈ 1 when standing, x/z ≈ 0 at origin).
     * @param {Object<string, Uint8Array>} [init.contacts]  Per foot: 1 while planted.
     * @param {number[]} [init.beats]      Beat times in seconds (filled by music analysis).
     * @param {object} [init.source]       Where the motion came from.
     */
    constructor({ name = 'Untitled', fps, frameCount, rotations, rootPositions, contacts = {}, beats = [], source = {} }) {
        if (!(fps > 0)) throw new Error('Choreography: fps must be positive');
        if (!(frameCount > 0)) throw new Error('Choreography: frameCount must be positive');
        if (rootPositions.length !== frameCount * 3) throw new Error('Choreography: rootPositions has the wrong length');
        for (const joint of JOINT_NAMES) {
            if (!rotations[joint]) throw new Error(`Choreography: missing rotations for joint "${joint}"`);
            if (rotations[joint].length !== frameCount * 4) throw new Error(`Choreography: rotations for "${joint}" have the wrong length`);
        }
        this.name = name;
        this.fps = fps;
        this.frameCount = frameCount;
        this.rotations = rotations;
        this.rootPositions = rootPositions;
        this.contacts = contacts;
        this.beats = beats;
        this.source = source;
    }

    /** Length in seconds. Each frame lasts 1/fps, so N frames span N/fps. */
    get duration() {
        return this.frameCount / this.fps;
    }

    /** Frame index nearest to a time in seconds (clamped to the valid range). */
    frameAt(time) {
        return Math.max(0, Math.min(this.frameCount - 1, Math.round(time * this.fps)));
    }

    toJSON() {
        const round = (arr, digits) => {
            const k = 10 ** digits;
            return Array.from(arr, (v) => Math.round(v * k) / k);
        };
        return {
            format: CHOREOGRAPHY_FORMAT,
            version: CHOREOGRAPHY_VERSION,
            name: this.name,
            fps: this.fps,
            frameCount: this.frameCount,
            duration: this.duration,
            source: this.source,
            skeleton: {
                convention: 'Y up, dancer faces +Z, dancer-left is +X. Rest pose is a T-pose with identity joint frames. ' +
                    'Rotations are parent-relative quaternions (x, y, z, w) measured from the rest pose.',
                joints: JOINTS.map((j) => ({ name: j.name, parent: j.parent })),
            },
            root: {
                unit: 'standing hip height',
                positions: round(this.rootPositions, 5),
            },
            rotations: Object.fromEntries(JOINT_NAMES.map((j) => [j, round(this.rotations[j], 5)])),
            contacts: Object.fromEntries(Object.entries(this.contacts).map(([k, v]) => [k, Array.from(v)])),
            beats: this.beats,
        };
    }

    static fromJSON(data) {
        if (typeof data === 'string') data = JSON.parse(data);
        if (!data || data.format !== CHOREOGRAPHY_FORMAT) {
            throw new Error('Not an AutoChoreo choreography file');
        }
        if (data.version > CHOREOGRAPHY_VERSION) {
            throw new Error(`Choreography file version ${data.version} is newer than this app supports`);
        }
        const rotations = {};
        for (const joint of JOINT_NAMES) {
            if (!data.rotations || !data.rotations[joint]) throw new Error(`Choreography file is missing joint "${joint}"`);
            rotations[joint] = Float32Array.from(data.rotations[joint]);
        }
        return new Choreography({
            name: data.name,
            fps: data.fps,
            frameCount: data.frameCount,
            rotations,
            rootPositions: Float32Array.from(data.root.positions),
            contacts: Object.fromEntries(Object.entries(data.contacts || {}).map(([k, v]) => [k, Uint8Array.from(v)])),
            beats: data.beats || [],
            source: data.source || {},
        });
    }
}
