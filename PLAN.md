# AutoChoreo — Implementation Plan

## Current State

The MVP is a static web app (index.html + main.js, ~310 lines) that:
- Loads a single Mixamo FBX dance animation via Three.js FBXLoader
- Renders the skeleton with a neon cyan SkeletonHelper
- Provides Play/Pause and Speed (0.25x–2x) controls
- Uses OrbitControls for camera interaction
- Has no audio, no beat detection, no music sync, no file picker

All dependencies come from CDN (Three.js 0.160.0). No build system, no tests.

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
