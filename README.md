# Drum Rig — Interactive Graphics Project

A 16-pad procedural drum machine and step sequencer, staged on a tri-fold
instrument rig that unfolds from a closed slab into a playable deck, with
stage lighting reactive to the audio spectrum and a beat-synced robot mascot.

**Live build:** https://franzinluca.github.io/Final_project_computer_graphics/

(Live build offline)

Course: Interactive Graphics, Prof. Marco Schaerf — DIAG, Sapienza University of Rome.

## Running locally

ES modules require a real HTTP server; opening `index.html` from the file
system will fail with a CORS error.

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Click **Power on** before anything else — the page routes through a
click-to-start overlay because browsers keep the `AudioContext` suspended
until a user gesture, so the page is silent (and the rig stays folded) until
you do.

## What it does

- **16-voice synthesis bank** across four selectable kits (Studio, Reggaetón,
  Techno, Drill), all generated procedurally with oscillator/noise synthesis —
  no audio samples.
- **Step sequencer** with a lookahead scheduler and quantized, multi-take
  recording; pad IDs stay stable across kit switches so a recorded pattern
  survives a kit change.
- **Hierarchical fold rig**: a closed slab unfolds into two wings via a
  hinge/fold solver driven entirely by scene-graph transforms, with staggered
  timing per wing rather than a single uniform tween.
- **Reactive lighting rig**: fixture intensity and color driven by an
  `AnalyserNode` FFT reading of the live mix, with asymmetric attack/release
  envelope following so lights punch on hits and decay smoothly.
- **Volumetric light shafts** via a raymarched post-process pass.
- **Procedural textures and materials only** — no imported image assets,
  so there are no licensing concerns anywhere in the scene.
- **Free orbit camera** plus scripted spherical-coordinate shot transitions
  for the power-on sequence.
- **Robot mascot** with beat-synced, code-driven arm animation (no imported
  keyframes/mocap).
- **Adaptive quality controller** that steps rendering resolution down under
  load, with backoff before stepping back up.

## Third-party components

Everything below is vendored into `/lib`; the project loads nothing from a
CDN and runs with no network connection.

| Component | Version | Licence | Used for |
|---|---|---|---|
| three.js | r185.1 | MIT | rendering, scene graph, materials |
| lil-gui | 0.21.0 | MIT | control panel |
| tween.js | 25.0.0 | MIT | eased animation of the unfold sequence and camera shots |

No third-party 3D models and no imported animations. All geometry, all
animation, and all texture maps are generated in project code at runtime.

## Layout

```
index.html          boot gate, import map, canvas, sequencer/GUI panel markup
/lib                 vendored libraries (three.js, lil-gui, tween.js)
/src
  main.js            scene, renderer, camera, render loop, module wiring
  events.js          pub/sub event bus — keeps audio.js and rig.js decoupled
  tweens.js           shared tween.js group, updated once per frame
  rig.js             tri-fold slab instrument geometry
  hierarchy.js       fold solver — hinge math, staggered wing animation
  pads.js            16-voice synthesis bank
  audio.js           lookahead scheduler, quantized recording, master bus
  lighting.js        analyser-driven reactive fixture rig
  environment.js     open infinite floor with fog
  mascot.js          robot character, beat-synced arm movement
  volumetrics.js     raymarched light-shaft post-process pass
  intro.js           power-on animation sequence
  sequencer.js       step-grid UI logic
  palette.js         luminance-solving pad color system
  camera.js          spherical-coordinate shot transitions, free orbit
  quality.js         adaptive resolution controller with retry backoff
  interaction.js     pointer/keyboard interaction handling
  presets.js         kit/preset definitions
  textures.js        procedural texture generation
  ui.js              DOM overlay wiring (tooltips, diagnostics readout)
/docs                DECISIONS.md (architecture log) and written report
```

See `/docs/DECISIONS.md` for the full architectural reasoning log behind
every design choice above.
