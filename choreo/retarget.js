// AutoChoreo — Retargeting (choreography ↔ character rig)
//
// The bridge between "what the dance is" and "who is dancing it".
//
//   bakeClip(choreography, rig)            choreography → AnimationClip for one rig
//   choreographyFromClip(clip, rig)        mocap clip on a rig → choreography
//
// A rig's bones each have their own arbitrary local axes, so a rotation that
// means "raise the left arm" on one character means something else on another.
// We sidestep that by working in world space: the choreography says how far
// each body part has turned from the T-pose, and we apply that same turn on
// top of wherever the rig's bone sat in ITS rest pose.

import * as THREE from 'three';
import { Choreography } from './choreography.js';
import { JOINTS, JOINT_NAMES, JOINT_PARENT_INDEX, normalizeBoneName } from './skeleton.js';

const REQUIRED_JOINTS = [
    'hips',
    'leftUpperArm', 'leftLowerArm', 'rightUpperArm', 'rightLowerArm',
    'leftUpperLeg', 'leftLowerLeg', 'rightUpperLeg', 'rightLowerLeg',
];

const rigCache = new WeakMap();

/**
 * Analyse a character model: record its rest pose and map its bones onto the
 * canonical skeleton. The result is cached per model.
 *
 * IMPORTANT: the first call for a model must happen while it is still in its
 * rest (T/A) pose — i.e. right after loading, before any animation is applied.
 */
export function prepareRig(root) {
    const cached = rigCache.get(root);
    if (cached) return cached;

    root.updateMatrixWorld(true);
    const bones = [];
    root.traverse((o) => { if (o.isBone) bones.push(o); }); // parents come before children
    if (bones.length === 0) throw new Error('This model has no skeleton');

    const indexOf = new Map(bones.map((b, i) => [b, i]));
    const rig = {
        bones,
        parentIndex: bones.map((b) => (indexOf.has(b.parent) ? indexOf.get(b.parent) : -1)),
        // For bones whose parent is not a bone, that parent never moves:
        staticParentQuat: bones.map((b) => (b.parent ? b.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion())),
        staticParentMatrix: bones.map((b) => (b.parent ? b.parent.matrixWorld.clone() : new THREE.Matrix4())),
        restLocalQuat: bones.map((b) => b.quaternion.clone()),
        restLocalPos: bones.map((b) => b.position.clone()),
        restLocalScale: bones.map((b) => b.scale.clone()),
        restWorldQuat: bones.map((b) => b.getWorldQuaternion(new THREE.Quaternion())),
        restWorldPos: bones.map((b) => b.getWorldPosition(new THREE.Vector3())),
        jointBone: new Array(JOINTS.length).fill(-1),   // canonical joint → bone index
        boneJoint: new Array(bones.length).fill(-1),    // bone index → canonical joint
        canonicalRest: JOINTS.map(() => new THREE.Quaternion()),
    };

    // Map canonical joints to bones by name alias
    const byName = new Map();
    bones.forEach((b, i) => {
        const key = normalizeBoneName(b.name);
        if (!byName.has(key)) byName.set(key, i);
    });
    const findBone = (aliases) => {
        for (const alias of aliases || []) {
            const i = byName.get(normalizeBoneName(alias));
            if (i !== undefined) return i;
        }
        return -1;
    };
    JOINTS.forEach((joint, j) => {
        const i = findBone(joint.bones);
        rig.jointBone[j] = i;
        if (i >= 0) rig.boneJoint[i] = j;
    });
    const missing = REQUIRED_JOINTS.filter((name) => rig.jointBone[JOINT_NAMES.indexOf(name)] < 0);
    if (missing.length) {
        throw new Error(`This character's skeleton cannot be mapped (missing: ${missing.join(', ')})`);
    }

    // Canonical rest orientation of each mapped bone: its rest world rotation,
    // corrected so the bone points along the canonical rest direction. This is
    // what lets an A-pose rig perform a dance defined against a T-pose.
    const restDir = new THREE.Vector3();
    const rigDir = new THREE.Vector3();
    const correction = new THREE.Quaternion();
    JOINTS.forEach((joint, j) => {
        const i = rig.jointBone[j];
        if (i < 0) return;
        rig.canonicalRest[j].copy(rig.restWorldQuat[i]);
        if (!joint.restDir) return;
        let tail = joint.tail ? rig.jointBone[JOINT_NAMES.indexOf(joint.tail)] : -1;
        if (tail < 0) tail = findBone(joint.tailBones);
        if (tail < 0) return;
        rigDir.subVectors(rig.restWorldPos[tail], rig.restWorldPos[i]);
        if (rigDir.lengthSq() < 1e-12) return;
        correction.setFromUnitVectors(rigDir.normalize(), restDir.fromArray(joint.restDir).normalize());
        rig.canonicalRest[j].premultiply(correction);
    });

    // Root: the choreography tracks the midpoint between the hip joints,
    // which is what must sit at the right height for the feet to reach the floor.
    const hips = rig.jointBone[JOINT_NAMES.indexOf('hips')];
    const leftLeg = rig.jointBone[JOINT_NAMES.indexOf('leftUpperLeg')];
    const rightLeg = rig.jointBone[JOINT_NAMES.indexOf('rightUpperLeg')];
    rig.hipsBone = hips;
    rig.legBones = [leftLeg, rightLeg];
    rig.restLegMid = rig.restWorldPos[leftLeg].clone().add(rig.restWorldPos[rightLeg]).multiplyScalar(0.5);
    rig.hipHeight = rig.restLegMid.y > 1e-6 ? rig.restLegMid.y : 1; // assumes the rest pose stands on y = 0
    rig.hipsOffset = rig.restWorldPos[hips].clone().sub(rig.restLegMid);
    const hipsParent = rig.parentIndex[hips];
    rig.hipsParentInverse = (hipsParent >= 0 ? bones[hipsParent].matrixWorld.clone() : rig.staticParentMatrix[hips].clone()).invert();

    rigCache.set(root, rig);
    return rig;
}

/** Can this model be driven by a choreography? */
export function canRetarget(root) {
    try {
        prepareRig(root);
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * Bake a choreography into a THREE.AnimationClip for a specific character.
 * Every bone gets a track, so the result fully defines the pose (bones the
 * choreography does not cover — fingers, toes — are held at rest).
 */
export function bakeClip(choreo, root, { name } = {}) {
    const rig = prepareRig(root);
    const N = choreo.frameCount;
    const B = rig.bones.length;
    const times = new Float32Array(N);
    for (let f = 0; f < N; f++) times[f] = f / choreo.fps;

    const values = rig.bones.map((_, i) => (rig.boneJoint[i] >= 0 ? new Float32Array(N * 4) : null));
    const hipsPositions = new Float32Array(N * 3);

    const jointWorld = JOINTS.map(() => new THREE.Quaternion());
    const boneWorld = rig.bones.map(() => new THREE.Quaternion());
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const offset = new THREE.Vector3();

    for (let f = 0; f < N; f++) {
        // Canonical world rotation of every joint (parent chain product)
        for (let j = 0; j < JOINTS.length; j++) {
            q.fromArray(choreo.rotations[JOINT_NAMES[j]], f * 4);
            const p = JOINT_PARENT_INDEX[j];
            if (p < 0) jointWorld[j].copy(q);
            else jointWorld[j].copy(jointWorld[p]).multiply(q);
        }

        for (let i = 0; i < B; i++) {
            const p = rig.parentIndex[i];
            const parentWorld = p >= 0 ? boneWorld[p] : rig.staticParentQuat[i];
            const j = rig.boneJoint[i];
            if (j >= 0) {
                boneWorld[i].copy(jointWorld[j]).multiply(rig.canonicalRest[j]);
                q.copy(parentWorld).invert().multiply(boneWorld[i]).toArray(values[i], f * 4);
            } else {
                boneWorld[i].copy(parentWorld).multiply(rig.restLocalQuat[i]);
            }
        }

        // Hips position: place the hip-joint midpoint, then step back to the hips bone
        v.set(
            rig.restLegMid.x + choreo.rootPositions[f * 3] * rig.hipHeight,
            choreo.rootPositions[f * 3 + 1] * rig.hipHeight,
            rig.restLegMid.z + choreo.rootPositions[f * 3 + 2] * rig.hipHeight
        );
        v.add(offset.copy(rig.hipsOffset).applyQuaternion(jointWorld[0]));
        v.applyMatrix4(rig.hipsParentInverse).toArray(hipsPositions, f * 3);
    }

    const tracks = [];
    rig.bones.forEach((bone, i) => {
        if (!bone.name) return;
        if (values[i]) {
            tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, values[i]));
        } else {
            tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, [0], rig.restLocalQuat[i].toArray()));
        }
        if (i === rig.hipsBone) {
            tracks.push(new THREE.VectorKeyframeTrack(`${bone.name}.position`, times, hipsPositions));
        } else {
            tracks.push(new THREE.VectorKeyframeTrack(`${bone.name}.position`, [0], rig.restLocalPos[i].toArray()));
        }
    });

    return new THREE.AnimationClip(name || choreo.name, choreo.duration, tracks);
}

/** The clip's own sampling rate, read from its densest keyframe track. */
function clipFrameRate(clip) {
    let times = null;
    for (const track of clip.tracks) {
        if (!times || track.times.length > times.length) times = track.times;
    }
    if (!times || times.length < 3) return 0;
    const fps = (times.length - 1) / (times[times.length - 1] - times[0]);
    return fps >= 5 && fps <= 240 ? Math.round(fps * 1000) / 1000 : 0;
}

/**
 * Convert an animation clip authored for a rig (e.g. a Mixamo mocap FBX) into
 * a choreography, by evaluating the clip and reading off how far each mapped
 * bone has turned from its rest pose. Pure math — the model is not touched.
 */
export function choreographyFromClip(clip, root, { fps, name, source } = {}) {
    const rig = prepareRig(root);
    const B = rig.bones.length;
    if (!fps) fps = clipFrameRate(clip) || 30;
    const N = Math.max(1, Math.round(clip.duration * fps));

    // Find the clip's tracks for each bone
    const quatTrack = new Array(B).fill(null);
    const posTrack = new Array(B).fill(null);
    // Some files contain several bones sharing one name (and one track each):
    // the k-th track for a name belongs to the k-th bone with that name.
    const bonesByName = new Map();
    rig.bones.forEach((b, i) => {
        if (!bonesByName.has(b.name)) bonesByName.set(b.name, []);
        bonesByName.get(b.name).push(i);
    });
    const assign = (slots, track, nodeName) => {
        const candidates = bonesByName.get(nodeName);
        if (!candidates) return;
        const i = candidates.find((c) => !slots[c]);
        if (i !== undefined) slots[i] = track.createInterpolant();
    };
    for (const track of clip.tracks) {
        const parsed = THREE.PropertyBinding.parseTrackName(track.name);
        if (parsed.propertyName === 'quaternion') assign(quatTrack, track, parsed.nodeName);
        else if (parsed.propertyName === 'position') assign(posTrack, track, parsed.nodeName);
    }

    const rotations = Object.fromEntries(JOINT_NAMES.map((n) => [n, new Float32Array(N * 4)]));
    const rootPositions = new Float32Array(N * 3);

    const boneWorldQuat = rig.bones.map(() => new THREE.Quaternion());
    const boneWorldMatrix = rig.bones.map(() => new THREE.Matrix4());
    const jointWorld = JOINTS.map(() => new THREE.Quaternion());
    const localQ = new THREE.Quaternion();
    const localP = new THREE.Vector3();
    const localM = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();

    // A clip can carry its own bone lengths (it was captured on a different
    // body). Heights are normalised by the legs the clip actually animates.
    const lowerLegs = ['leftLowerLeg', 'rightLowerLeg'].map((n) => rig.jointBone[JOINT_NAMES.indexOf(n)]);
    const feet = ['leftFoot', 'rightFoot'].map((n) => rig.jointBone[JOINT_NAMES.indexOf(n)]);
    const boneLength = (i, useClip) => {
        if (i < 0) return 0;
        if (useClip && posTrack[i]) return a.fromArray(posTrack[i].evaluate(0)).length();
        return rig.restLocalPos[i].length();
    };
    const legLength = (useClip) => lowerLegs.reduce((sum, i) => sum + boneLength(i, useClip), 0) +
        feet.reduce((sum, i) => sum + boneLength(i, useClip), 0);
    const restLegLength = legLength(false);
    const legScale = restLegLength > 1e-9 ? legLength(true) / restLegLength : 1;
    const hipHeight = rig.hipHeight * (legScale > 0.5 && legScale < 2 ? legScale : 1);

    for (let f = 0; f < N; f++) {
        const t = Math.min(f / fps, clip.duration);
        for (let i = 0; i < B; i++) {
            if (quatTrack[i]) localQ.fromArray(quatTrack[i].evaluate(t)).normalize();
            else localQ.copy(rig.restLocalQuat[i]);
            if (posTrack[i]) localP.fromArray(posTrack[i].evaluate(t));
            else localP.copy(rig.restLocalPos[i]);
            localM.compose(localP, localQ, rig.restLocalScale[i]);
            const p = rig.parentIndex[i];
            if (p >= 0) {
                boneWorldQuat[i].copy(boneWorldQuat[p]).multiply(localQ);
                boneWorldMatrix[i].multiplyMatrices(boneWorldMatrix[p], localM);
            } else {
                boneWorldQuat[i].copy(rig.staticParentQuat[i]).multiply(localQ);
                boneWorldMatrix[i].multiplyMatrices(rig.staticParentMatrix[i], localM);
            }
        }

        // Canonical world rotation = how far the bone has turned from its canonical rest
        for (let j = 0; j < JOINTS.length; j++) {
            const i = rig.jointBone[j];
            const p = JOINT_PARENT_INDEX[j];
            if (i >= 0) jointWorld[j].copy(boneWorldQuat[i]).multiply(q.copy(rig.canonicalRest[j]).invert());
            else if (p >= 0) jointWorld[j].copy(jointWorld[p]); // rig lacks this joint: follow the parent
            else jointWorld[j].identity();

            if (p < 0) q.copy(jointWorld[j]);
            else q.copy(jointWorld[p]).invert().multiply(jointWorld[j]);
            q.toArray(rotations[JOINT_NAMES[j]], f * 4);
        }

        a.setFromMatrixPosition(boneWorldMatrix[rig.legBones[0]]);
        b.setFromMatrixPosition(boneWorldMatrix[rig.legBones[1]]);
        a.add(b).multiplyScalar(0.5);
        rootPositions[f * 3] = (a.x - rig.restLegMid.x) / hipHeight;
        rootPositions[f * 3 + 1] = a.y / hipHeight;
        rootPositions[f * 3 + 2] = (a.z - rig.restLegMid.z) / hipHeight;
    }

    return new Choreography({
        name: name || clip.name || 'Mocap dance',
        fps,
        frameCount: N,
        rotations,
        rootPositions,
        source: source || { type: 'mocap', name: name || clip.name || null },
    });
}
