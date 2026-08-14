# Drum Rig — Interactive Graphics Project

A 4×4 drum pad rig inside a folding road case: live sequencing, quantized
multi-layer recording, and stage lighting driven by the audio spectrum.

**Live build:** https://USERNAME.github.io/REPO-NAME/  ← replace before the deadline

Course: Interactive Graphics, Prof. Marco Schaerf — DIAG, Sapienza University of Rome.

## Team

| Name | Matricola |
|---|---|
| | |

## Running locally

ES modules require a real HTTP server; opening `index.html` from the file system
will fail with a CORS error.

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Click **Power on** before anything else — browsers keep the AudioContext
suspended until a user gesture, so the page is silent until you do.

## Third-party components

Everything below is vendored into `/lib`; the project loads nothing from a CDN
and runs with no network connection.

| Component | Version | Licence | Used for |
|---|---|---|---|
| three.js | r___ | MIT | rendering, scene graph, materials |
| lil-gui | ___ | MIT | control panel |
| tween.js | ___ | MIT | eased animation of the unfold sequence |

No third-party 3D models and no imported animations. All geometry, all
animation and all texture maps are generated in project code.

## Layout

```
index.html        boot gate, import map, canvas
/lib              vendored libraries (three.js, lil-gui, tween.js)
/src
  main.js         scene, renderer, camera, render loop, wiring
  events.js       pub/sub bus — keeps audio and geometry decoupled
  tweens.js       shared tween.js group, updated once per frame
  audio.js        pad bank, scheduler, layers, recording
/assets           generated texture maps
/docs             report
```

## Progress

- [x] Phase 0 — repo, vendored libraries, boot gate, live deployment
- [x] Phase 1 — audio engine
- [x] Phase 2 — rig geometry
- [x] Phase 3 — interaction
- [x] Phase 4 — hierarchical unfold
- [x] Phase 5 — lighting
- [x] Phase 6 — environment and textures
- [x] Phase 7 — presets and camera
- [x] Phase 8 — sound design
- [x] Phase 9 — polish
- [ ] Phase 10 — document and deploy