// AutoChoreo — Canonical skeleton
//
// The character-independent body model that every choreography is expressed in.
// A dance is stored against THIS skeleton, never against a particular character,
// so the same motion can drive any rig that can be mapped onto these joints.
//
// Conventions (all choreography data follows these):
//   - Right-handed, Y up. The dancer faces +Z; the dancer's LEFT is +X.
//   - Rest pose is a T-pose: arms straight out along ±X with palms down,
//     legs straight down along -Y.
//   - In the rest pose every joint frame is world-aligned (identity rotation),
//     so a joint's local rotation is simply "how far it has turned relative to
//     its parent since the T-pose".

// Direction from ankle to toe in the rest pose (the foot slopes down and forward).
const FOOT_REST_DIR = [0, -0.43, 0.9];

/**
 * Joint definitions, parents before children.
 *
 *   restDir   Direction the bone points in the rest pose (canonical axes).
 *   tail      Canonical joint at the far end of this bone — used to measure
 *             which way the equivalent bone points on a character rig.
 *   tailBones Rig bone aliases to use as the far end when no canonical joint
 *             sits there (hands, feet).
 *   bones     Rig bone-name aliases, most preferred first. Matched after
 *             stripping prefixes such as "mixamorig" and any punctuation.
 */
export const JOINTS = [
    { name: 'hips',          parent: null,            bones: ['Hips', 'Pelvis'] },
    { name: 'spine',         parent: 'hips',          bones: ['Spine'] },
    { name: 'chest',         parent: 'spine',         bones: ['Spine2', 'UpperChest', 'Chest', 'Spine1'] },
    { name: 'neck',          parent: 'chest',         bones: ['Neck'] },
    { name: 'head',          parent: 'neck',          bones: ['Head'] },

    { name: 'leftUpperArm',  parent: 'chest',         restDir: [1, 0, 0],  tail: 'leftLowerArm',  bones: ['LeftArm', 'LeftUpperArm'] },
    { name: 'leftLowerArm',  parent: 'leftUpperArm',  restDir: [1, 0, 0],  tail: 'leftHand',      bones: ['LeftForeArm', 'LeftLowerArm'] },
    { name: 'leftHand',      parent: 'leftLowerArm',  restDir: [1, 0, 0],  tailBones: ['LeftHandMiddle1'], bones: ['LeftHand'] },

    { name: 'rightUpperArm', parent: 'chest',         restDir: [-1, 0, 0], tail: 'rightLowerArm', bones: ['RightArm', 'RightUpperArm'] },
    { name: 'rightLowerArm', parent: 'rightUpperArm', restDir: [-1, 0, 0], tail: 'rightHand',     bones: ['RightForeArm', 'RightLowerArm'] },
    { name: 'rightHand',     parent: 'rightLowerArm', restDir: [-1, 0, 0], tailBones: ['RightHandMiddle1'], bones: ['RightHand'] },

    { name: 'leftUpperLeg',  parent: 'hips',          restDir: [0, -1, 0], tail: 'leftLowerLeg',  bones: ['LeftUpLeg', 'LeftUpperLeg', 'LeftThigh'] },
    { name: 'leftLowerLeg',  parent: 'leftUpperLeg',  restDir: [0, -1, 0], tail: 'leftFoot',      bones: ['LeftLeg', 'LeftLowerLeg', 'LeftShin'] },
    { name: 'leftFoot',      parent: 'leftLowerLeg',  restDir: FOOT_REST_DIR, tailBones: ['LeftToeBase', 'LeftToes', 'LeftToe'], bones: ['LeftFoot'] },

    { name: 'rightUpperLeg', parent: 'hips',          restDir: [0, -1, 0], tail: 'rightLowerLeg', bones: ['RightUpLeg', 'RightUpperLeg', 'RightThigh'] },
    { name: 'rightLowerLeg', parent: 'rightUpperLeg', restDir: [0, -1, 0], tail: 'rightFoot',     bones: ['RightLeg', 'RightLowerLeg', 'RightShin'] },
    { name: 'rightFoot',     parent: 'rightLowerLeg', restDir: FOOT_REST_DIR, tailBones: ['RightToeBase', 'RightToes', 'RightToe'], bones: ['RightFoot'] },
];

export const JOINT_NAMES = JOINTS.map((j) => j.name);
export const JOINT_BY_NAME = Object.fromEntries(JOINTS.map((j) => [j.name, j]));

/** Index of each joint's parent within JOINTS (-1 for the root). */
export const JOINT_PARENT_INDEX = JOINTS.map((j) => (j.parent ? JOINT_NAMES.indexOf(j.parent) : -1));

/** Normalise a rig bone name for alias matching: "mixamorig:LeftArm" → "leftarm". */
export function normalizeBoneName(name) {
    return String(name)
        .replace(/^mixamorig\d*[:_]?/i, '')
        .replace(/[^a-zA-Z0-9]/g, '')
        .toLowerCase();
}

// ── MediaPipe Pose landmark indices (33-point model) ────────────────
export const LM = {
    NOSE: 0,
    LEFT_EYE: 2, RIGHT_EYE: 5,
    LEFT_EAR: 7, RIGHT_EAR: 8,
    MOUTH_LEFT: 9, MOUTH_RIGHT: 10,
    LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
    LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
    LEFT_WRIST: 15, RIGHT_WRIST: 16,
    LEFT_PINKY: 17, RIGHT_PINKY: 18,
    LEFT_INDEX: 19, RIGHT_INDEX: 20,
    LEFT_THUMB: 21, RIGHT_THUMB: 22,
    LEFT_HIP: 23, RIGHT_HIP: 24,
    LEFT_KNEE: 25, RIGHT_KNEE: 26,
    LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
    LEFT_HEEL: 29, RIGHT_HEEL: 30,
    LEFT_FOOT_INDEX: 31, RIGHT_FOOT_INDEX: 32,
};
export const LANDMARK_COUNT = 33;

/** Landmark pairs that form the visible stick figure (used for overlays and scale estimation). */
export const LANDMARK_BONES = [
    [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER], [LM.LEFT_HIP, LM.RIGHT_HIP],
    [LM.LEFT_SHOULDER, LM.LEFT_HIP], [LM.RIGHT_SHOULDER, LM.RIGHT_HIP],
    [LM.LEFT_SHOULDER, LM.LEFT_ELBOW], [LM.LEFT_ELBOW, LM.LEFT_WRIST],
    [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW], [LM.RIGHT_ELBOW, LM.RIGHT_WRIST],
    [LM.LEFT_HIP, LM.LEFT_KNEE], [LM.LEFT_KNEE, LM.LEFT_ANKLE],
    [LM.RIGHT_HIP, LM.RIGHT_KNEE], [LM.RIGHT_KNEE, LM.RIGHT_ANKLE],
];
