# AutoChoreo — Implementation Plan

## Current State

A static web app (index.html + ES modules, no build step) that:
- Loads dances from Mixamo FBX mocap, from a video of a dancer, or from a saved
  choreography file
- Performs them on the mocap skeleton, its mesh, X-Bot, or a custom GLB/FBX rig
- Plays audio in sync (Phase 1 below: transport, scrubber, speed, file pickers)
- Stitches several dances into a **sequence** with smooth transitions and
  rhythmic speed changes, on a manually set beat grid (see *Sequencing* below)
- Has no automatic beat detection yet (Phase 2)

All dependencies come from CDN (Three.js 0.160.0, MediaPipe Tasks Vision). No build
system. The choreography modules have Node unit tests: `npm install && npm test`
(`package.json` exists only for the tests; the app itself still needs no install).

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
- Wire the Speed slider to `AudioBufferSourceNode.playbackRate` so audio
  pitch-shifts in lockstep with animation speed
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
