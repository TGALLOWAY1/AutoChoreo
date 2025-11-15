AutoChoreo — MVP Backlog
Minimum viable version for a single mocap dance file (FBX).

1. Project Setup
 Create minimal static web app structure (index.html, main.js, /TEST_DATA/*.fbx).
 Add basic styling (dark gradient background, responsive layout).
 Add a top UI bar for basic controls (play/pause, speed).
2. Three.js Scene Initialization
 Load Three.js, OrbitControls, and FBXLoader via CDN.
 Create base scene, camera, and renderer.
 Add resize handling.
 Add OrbitControls (with damping).
 Add ambient & directional lights.
 Add simple ground grid.
3. Load & Render Mocap Skeleton (FBX)
 Load a single FBX file from TEST_DATA/ (e.g., TEST_DATA/test.fbx).
 Extract the model + skeleton from the FBX.
 Create SkeletonHelper around the model.
 Apply neon stylized line material.
 Position/rotate/scale model so it displays cleanly.
4. Animation System
 Create an AnimationMixer bound to the FBX model.
 Play the first animation clip from the FBX.
 Update the mixer in the render loop via clock.getDelta().
 Fit the camera to frame the model.
5. Playback Controls
 Implement Play/Pause toggle.
 Implement a speed slider (0.25x → 2x).
 Wire UI controls to action.paused and action.setEffectiveTimeScale.
6. Final Polish
 Minor visual stylization (neon skeleton, dim grid).
 Improve readability of UI.
 Add simple instructions/title to UI.
 Confirm the MVP works with any file in TEST_DATA/.
 Prep for static deployment (GitHub Pages, Netlify, Vercel)