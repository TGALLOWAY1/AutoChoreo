# AutoChoreo — Implementation Plan

## Current State

A static web app (HTML pages + ES modules, no build step) with three parts:

- **Learning dashboard** (`index.html`) — the entry point: the choreography
  library, upload → convert → practise, a preview of the selected routine, and
  practice progress (see *Learning Track* below)
- **Practice Studio** (`practice.html`) — learn a routine against a reference
  with a live camera or an uploaded recording, scored on pose, timing and
  movement, with adaptive drills and tempo
- **Choreograph** (`choreograph.html`, formerly `index.html`) — the 3D viewer
  and editor: loads dances from Mixamo FBX mocap, from a video of a dancer, or
  from a saved choreography; performs them on any rig; stitches **sequences**
  with smooth transitions and rhythmic speed changes. *Practice this* hands the
  current dance to the learning side

Music plays in sync with pitch preserved at any tempo. Tempo and count 1 are
estimated from the music, or from the movement for dances without music
(`choreo/rhythm.js`) — a foundation for Phase 2, not yet full beat tracking.

All dependencies come from CDN (Three.js 0.160.0, MediaPipe Tasks Vision). No build
system. The choreography modules have Node unit tests: `npm install && npm test`
(`package.json` exists only for the tests; the app itself still needs no install).

---

## Learning Track — Dashboard and Practice Studio

Goal: turn the choreography tools into a place to *learn* a dance: pick a routine,
practise it alongside a reference, see objectively how close you are and what to
fix, repeat the hard parts slower, and come back later to keep improving.

```
select routine ──► practise a step ──► compare (live / recording) ──► feedback ──► drill / adapt tempo ──► progress
 dashboard.js       practice.js          choreo/compare.js             learn/feedback.js   learn/adaptive.js     learn/progress.js
 learn/library.js   learn/lesson.js      choreo/scoring.js
```

| Module | Role |
|--------|------|
| `choreo/compare.js` | Pose comparison: both sides reduced to 15 keypoints → unit bone directions in the dancer's own body frame (+ torso lean and facing); reference tracks from a choreography (forward kinematics) or from a video's landmarks; front/back disambiguation; aligning a recording by movement |
| `choreo/scoring.js` | `SyncScorer`: windowed lag search that separates *wrong movement* from *right movement at the wrong time*; movement-quality score; `AttemptAccumulator` per pass (per-count scores, per-body-part errors, mean lag) |
| `choreo/rhythm.js` | Onset envelopes (spectral flux per band / movement stops), tempo by autocorrelation + comb refinement, count 1, sections of eight, aligning two recordings by their music |
| `choreo/liveTracker.js` | MediaPipe Pose on every camera frame, stamped with its capture time |
| `learn/library.js` | Routines: built-in mocap presets plus the dancer's imports (videos, choreography/sequence JSON, FBX) stored in IndexedDB with their video, landmarks and music; per-routine analysis (rhythm, thumbnail) |
| `learn/lesson.js` | Lesson plan: watch → one step per eight → full routine |
| `learn/adaptive.js` | Tempo ladder, losing-the-routine detector, drill phrase selection |
| `learn/feedback.js` | Measurements → concrete corrections ("Raise your left elbow higher", "about ½ beat late", "counts 11–12 were your weakest") |
| `learn/progress.js` | Attempts, per-step best scores and mastery, practice time, resume point, recommendations (localStorage) |
| `learn/stage.js`, `timeline.js`, `metronome.js`, `overlay.js` | 3D reference with joint overlay, beat-grid timeline with draggable loop, metronome and "5, 6, 7, 8" count-in, skeleton overlays coloured by match |
| `sync.js` | The one musical clock: music (pitch-preserving `<audio>`), animation, videos, metronome and scorer all follow it; practice ranges; capture-time → song-time |

### How a performance is compared

- **Normalisation.** Bone directions are unit vectors (proportions and size drop
  out), differences of keypoints (position drops out), expressed in the dancer's
  body frame built from the hip + shoulder lines and the torso (camera yaw, pitch
  and roll drop out). Torso lean and facing are kept as features on purpose.
  The forward-kinematics reference matches the posed rig's joints to within 1°.
- **Emphasis.** Each body part counts by how far the reference takes it from a
  neutral stance around that moment — otherwise someone standing still would
  earn credit for every part the dance does not use.
- **Pose vs timing.** The last 0.8 s of the dancer's movement is compared with
  the reference shifted ±0.5 s. The best shift's match is the *pose* score; the
  shift itself is the timing error (chosen on raw angle error, which has no
  full-credit plateau). Timing is not judged while the reference holds still,
  and earns no credit while the movement itself is wrong.
- **Movement** compares how much each body part moves at each moment (speeds,
  weighted by the reference's activity) — robust to the pose model's depth errors.
- **Front/back.** From one camera the pose model regularly reads a dancer the
  wrong way round (measured: 30–50% of frames on rendered test dancers). Each
  frame is read the way round the reference faces at that moment — decided by
  facing only, so using the wrong arm still shows as the wrong arm.
- **Latency.** Camera frames are placed on the song timeline by their capture
  time; the audio output latency (and a user setting for Bluetooth) is subtracted.
- **Recordings** are placed on the timeline by their music when both have it
  (with movement choosing between repeats of looped music), else by movement;
  whether they were danced mirrored or same-side is detected.

### Measured calibration (MediaPipe on rendered test dances)

| Performance | Overall | Pose | Timing | Movement |
|---|---|---|---|---|
| Same dance, in time (recording) | 80–83 | 83–86 | 98 | 71–75 |
| Same dance, in time (live camera, 15 fps) | 78–84 | 80–87 | 100 | 70–76 |
| Same dance, 0.3 s late (live) | 66–68 | 83–86 | 29–37 | 71–74 |
| Different dance | 47 | 53 | — | 61 |
| Standing still | 43 | 54 | — | 48 |

Live lag measurements: in time −0.01 beats; 0.3 s late → +0.27–0.30 s;
0.25 s early → −0.14–0.21 s. MediaPipe's own error caps a flawless performance
around the mid 80s (arms ~30° off on average), so mastery is set at 75.

### Next
- [ ] Movement-aware tempo/beat tracking for music with tempo changes (beats are assumed steady)
- [ ] A volumetric default dancer: the bundled Mixamo mesh is a thin bone-display mannequin
- [ ] Pose model in a Web Worker so tracking never competes with rendering
- [ ] Per-user calibration of systematic pose-model bias (e.g. a short standing capture)
- [ ] Record & compare: keep the camera take of a pass to replay beside the reference
- [ ] Sync progress across devices (everything is stored in this browser today)

---

## Generative Choreography Track — learning dances from video

Goal: learn a dance from a (real or AI-generated) video, store it as reusable
motion data, and perform it on any character. The key decision is to separate
**what the dance is** from **who is dancing it**.

```
video ──► pose landmarks ──► kinematic solve ──► Choreography ──► retarget ──► any rig
          poseExtractor.js    solver.js          choreography.js   retarget.js
mocap FBX ───────────────────────────────────────────▲ (choreographyFromClip)
```

| Module | Role |
|--------|------|
| `choreo/skeleton.js` | Canonical, character-independent skeleton (17 joints, T-pose rest, Y-up, faces +Z) |
| `choreo/choreography.js` | The reusable dance: per-joint rotations, root trajectory in hip-heights, foot contacts, beat slots; JSON save/load |
| `choreo/poseExtractor.js` | MediaPipe Pose Landmarker over every video frame, in the browser (33 landmarks, image + estimated 3D) |
| `choreo/solver.js` | Landmarks → joint rotations: per-frame geometric IK, twist from elbow/knee bend planes, left/right-flip rejection, temporal smoothing, root + contact estimation |
| `choreo/retarget.js` | Choreography → `AnimationClip` for a specific rig, and mocap clip → Choreography |

### Status

- [x] **Video-to-skeleton proof of concept** — *Load Dance* accepts a video; the
      source plays in a reference panel with tracked landmarks, in sync with the character
- [x] Reusable choreography format with *Save Choreo* / load `.json`
- [x] Character switching without reprocessing (choreography is baked per rig)
- [ ] Optimisation pass: joint limits, foot-contact constraints (no sliding), balance
- [ ] Jumps (root height currently assumes the lowest foot is on the floor)
- [x] Editing: loop, blend, BPM re-timing — see *Sequencing* below
- [ ] Editing: mirror
- [ ] Movement vocabulary: segment choreographies into reusable, tagged primitives
- [ ] Video generation (Veo) → evaluate → reconstruct → store workflow
- [ ] More character types (robot with joint limits, geometric, procedural)

### Measured baseline

A Mixamo mocap dance was rendered on a human-looking character with a fixed
camera, run through the full video pipeline, and compared with the original
mocap (8 s, 240 frames): mean bone-direction error ≈ 17°, heading and sideways /
depth travel track the original. Limbs are the weak point (depth is guessed from
one camera), hands the weakest. Feeding the solver perfect landmarks gives ≈ 2°,
so the remaining error is pose-estimation quality, not the solve — a stronger
motion-reconstruction model can replace `poseExtractor.js` without touching the rest.

---

## Sequencing — smooth transitions between clips, rhythmic time changes

Goal: string short clips (10–15 s dances, trimmed or looped) into one performance
whose joins look like dancing rather than editing, and bend time in musical
amounts (half time for a bar, a held hit) without falling off the beat.

```
song time ──► speed changes ──► sequence time ──► clips + joins ──► one Choreography ──► bakeClip ──► any rig
              (in song beats)   (clips end to end)  (choreo/sequence.js)                (unchanged)
```

| Module | Role |
|--------|------|
| `choreo/pose.js` | Single poses: interpolated sampling (slerp between frames), blending, heading, a standing neutral pose, pose distance |
| `choreo/sequence.js` | Sequence model, layout, root alignment, time warp, compile to a flat Choreography, pose matching, save/load |
| `sequenceEditor.js` | Side panel (*Sequence* button) and the timeline strip above the scrubber |

Design decisions:
- **Compile, don't special-case playback.** A sequence is flattened into an ordinary
  Choreography, so the transport, rig switching, *Save Choreo* and baking are untouched.
  Edits re-compile and re-bake in place (playhead and camera kept).
- **Joins are centred on the cut.** A crossfade starts half its length before the cut
  and ends half after, reading the dances' own frames beyond the in/out points. So a
  clip trimmed to 8 beats occupies exactly 8 beats, whatever the join.
- **Join styles:** *Crossfade* (both dances play while one fades into the other),
  *Via neutral pose* (ease into a shared pose — standing by default, or captured
  from the screen — and out of it), *Cut*.
- **Root alignment:** each clip starts where the previous one left off (optionally
  turned to face the same way), so the dancer never teleports.
- **Speed changes are rhythmic:** defined in song beats (bar, beat, length), with
  speeds like ½×, 2×, 0× (hold). Ramps are centred on the boundary and antisymmetric,
  so they add exactly what a hard switch would. Everything after a change shifts by
  `beats × (1 − speed)`, which the editor shows, and warns when it is not whole.
- **Tempo matching per clip:** an optional "Dance BPM" plays a clip at
  `song BPM / dance BPM` so its own beats land on the song's.
- **Match pose / Match loop** pick in/out points where the poses (and motion) already
  agree — a simple form of motion-graph transition search. With a dance BPM set,
  only half-beat steps are considered so clips stay on the beat. *Snap to beats*
  trims a clip to a whole number of beats.

Measured on Mixamo clips (DancingMedium → DoTheRobot, 2-beat join): the largest
single-frame joint rotation at the join is 77° for a cut, 14° for a crossfade and 17°
via the neutral pose, against a 99th percentile of 16° inside the clips — i.e. the
blended joins move no harder than the dance itself.

### Next
- [ ] Foot-contact-aware blending (feet can slide during a crossfade)
- [ ] Beat grid from detected beats (Phase 2) instead of BPM + first downbeat
- [ ] Drag clip edges / joins directly on the timeline strip
- [ ] Mirror a clip; reverse playback
- [ ] Keep the reference video panel in sync with video-learned clips in a sequence

---

## Phase 1 — Basic Functionality (Foundation)

### 1.1 Audio Loading & Playback
- Add an `<input type="file" accept="audio/*">` to load an MP3/WAV/OGG file
- Create a Web Audio API `AudioContext` and `AudioBufferSourceNode`
- Wire Play/Pause to start/stop both animation and audio together
- Wire the Speed slider to the playback rate so audio follows the animation
  speed — *now pitch-preserving: music plays through an `<audio>` element with
  `preservesPitch`, the decoded buffer is kept for waveforms and analysis*
- Display the loaded track name in the UI bar

### 1.2 FBX File Picker
- Add an `<input type="file" accept=".fbx">` so the user can load any FBX
  from disk instead of the hardcoded path
- On load, tear down the previous model/skeleton/mixer and set up the new one
- Keep the TEST_DATA/ files as defaults selectable from a `<select>` dropdown

### 1.3 Timeline / Scrubber
- Add a horizontal `<input type="range">` scrubber bar below the 3D canvas
- The scrubber reflects the current animation time and total duration
- Dragging the scrubber seeks both animation (`mixer.setTime()`) and audio
  (`AudioContext.currentTime` offset)
- Show elapsed / total time as `mm:ss`

### 1.4 Transport Sync Engine (`sync.js`)
- Extract a small `TransportController` class that owns the single source of
  truth for playback state: `{ playing, speed, currentTime, duration }`
- Animation mixer, audio playback, scrubber, and UI all subscribe to this
  controller instead of wiring directly to each other
- This decouples components and makes Phase 2 beat-sync much easier

---

## Phase 2 — Music Analysis & Beat Detection

### 2.1 Beat Detection via Web Audio API

*Foundation implemented in `choreo/rhythm.js` (spectral flux, autocorrelation
tempo, comb-refined tempo and phase; steady tempo assumed). Used by the
learning track for counts and sections.*

- Create an `AnalyserNode` fed from the audio source
- Implement onset-detection in `beatDetector.js`:
  - Compute spectral flux from successive FFT frames
  - Apply an adaptive threshold to find onset peaks
  - Cluster onsets into a stable BPM estimate
- Store detected beats as an array of timestamps (seconds)
- Display detected BPM in the UI

### 2.2 Waveform & Beat Visualization
- Draw the audio waveform on a `<canvas>` overlay beneath the scrubber
- Overlay vertical beat-marker lines on the waveform at each detected beat
- Highlight the "current beat" marker as playback progresses
- Color-code strong beats (downbeats) vs. weak beats

### 2.3 Animation Segment Tagging
- Analyze the loaded animation clip to find segment boundaries:
  - Compute per-frame root-bone velocity magnitude
  - Detect peaks (high-energy moves) and valleys (transitions/holds)
- Store segments as `{ startTime, endTime, energy }` array
- Visualize segments as colored blocks on the timeline

---

## Phase 3 — Dance-Music Synchronization

### 3.1 BPM-Lock Mode
- Calculate the animation's "natural BPM" from its segment/peak cadence
- Compute `speedRatio = musicBPM / animationBPM`
- Apply `speedRatio` to `action.setEffectiveTimeScale()` so the dance
  automatically matches the music tempo
- Add a toggle: "BPM Lock On/Off"

### 3.2 Beat-Snap Alignment
- For each music beat timestamp, find the nearest animation peak
- Compute per-beat time-warp offsets so animation peaks land exactly on beats
- Apply warping via a custom `mixer.update()` delta override that stretches/
  compresses time between beats (rubberband approach)
- This gives frame-accurate sync without changing overall duration much

### 3.3 Multi-Clip Sequencing
- *Largely done by Sequencing above (clip list, transitions, per-clip tempo matching).*
- Allow loading multiple FBX animations as a clip library (sidebar list)
- User can drag clips onto a timeline track to sequence them
- Each clip auto-crossfades into the next (configurable blend duration)
- Clips can be individually BPM-locked or beat-snapped to the music

### 3.4 Energy Matching
- Map music energy (RMS amplitude per beat window) to animation segments
- Auto-select which clip to play based on energy:
  - High energy music sections → high energy dance clips
  - Low energy sections → gentle sway / idle clips
- Provide an "Auto-Choreograph" button that builds a full sequence from
  the clip library matched to the music's energy curve

---

## Phase 4 — Polish & Advanced Features (Stretch)

### 4.1 Export
- Export the synchronized animation as a new FBX or glTF file
- Export a video recording of the 3D viewport via MediaRecorder API

### 4.2 Additional Mocap Format Support
- Add BVH loader (Three.js has `BVHLoader`)
- Add glTF/GLB loader for broader compatibility

### 4.3 Visual Enhancements
- Post-processing pipeline (bloom on skeleton, motion blur)
- Floor reflection / shadow plane
- Particle effects tied to beat events

### 4.4 Real-Time Microphone Input
- Stream mic audio into the AnalyserNode for live beat detection
- Dance reacts in real-time to live music

---

## Implementation Order Summary

| Step | Deliverable | Key Files |
|------|------------|-----------|
| 1.1  | Audio load + play | `index.html`, `main.js` |
| 1.2  | FBX file picker | `index.html`, `main.js` |
| 1.3  | Timeline scrubber | `index.html`, `main.js` |
| 1.4  | Transport controller | `sync.js` (new) |
| 2.1  | Beat detection | `beatDetector.js` (new) |
| 2.2  | Waveform + beat viz | `index.html`, `main.js` |
| 2.3  | Animation segmenting | `animAnalyzer.js` (new) |
| 3.1  | BPM lock | `sync.js` |
| 3.2  | Beat-snap warping | `sync.js` |
| 3.3  | Multi-clip sequencer | `sequencer.js` (new), `index.html` |
| 3.4  | Energy matching | `sync.js`, `sequencer.js` |
