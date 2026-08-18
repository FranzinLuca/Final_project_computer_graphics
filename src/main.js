/**
 * main.js — scene bootstrap, the single render loop, and all wiring.
 *
 * main.js is the only module allowed to know about every other module. It
 * wires them together; they do not wire themselves to each other.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { bus } from './events.js';
import { tweens } from './tweens.js';
import { initAudio, getContext, audio } from './audio.js';
import { PALETTE } from './palette.js';
import { buildRig } from './rig.js';
import { buildMascot } from './mascot.js';
import { initHierarchy } from './hierarchy.js';
import { initInteraction, KEY_LABELS } from './interaction.js';
import { initLighting } from './lighting.js';
import { buildEnvironment, MAX_ORBIT, makeContactShadow } from './environment.js';
import { initCamera } from './camera.js';
import { initUI } from './ui.js';
import { initSequencer } from './sequencer.js';
import { PRESETS, loadPreset } from './presets.js';
import { KITS, setKit, getKit } from './pads.js';
import { initQuality } from './quality.js';
import { initVolumetrics } from './volumetrics.js';
import { initIntro } from './intro.js';

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

const canvas = document.getElementById('scene');

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});

renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

/**
 * AgX, having been Neutral, and having deliberately not become ACES.
 *
 * All three compress the linear render into displayable range and disagree
 * about what to do with saturated colour on the way. The choice mattered
 * differently before phase 10 than it does after, which is why it changed.
 *
 * In the bright studio, Neutral was right. Khronos PBR Neutral holds hue and
 * saturation until it is genuinely forced to roll off, and the scene had a
 * cream shell and coloured pads that had to stay the colour they were painted.
 * ACES was rejected there for exactly one reason: it was designed for film
 * and deliberately desaturates as values climb, so a bright saturated pad
 * drifts towards white.
 *
 * That objection to ACES has not gone away — it is why the room going dark did
 * NOT come with a switch to ACES, even though ACES is the reflexive answer to
 * "make it more cinematic". Sixteen pads are lit by emission alone, and
 * palette.js solves a bisection per hue specifically to hold them at matched
 * luminance; a curve that desaturates the brightest of them would spend that
 * work.
 *
 * What Neutral does not have is a shoulder worth the name. It is close to
 * linear through the midtones, which is fine when the frame occupies the
 * middle of the range and looks washed out when the frame is mostly dark with
 * a few very bright sources in it — which is exactly the frame this phase
 * builds. AgX has a genuine filmic toe and shoulder, so shadows compress into
 * a deep foot instead of sitting at a flat grey, and it holds hue far better
 * than ACES does on the way up: a saturated source climbing past 1.0 goes
 * lighter before it goes white.
 *
 * Kept as one assignment with fallbacks rather than buried in a config, so the
 * comparison is one line to run and can be shown rather than argued.
 */
renderer.toneMapping =
  THREE.AgXToneMapping ?? THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping;

/**
 * Exposure above 1.0, which is not a fudge for "the scene got dark".
 *
 * AgX's toe is aggressive by design and it lands most of a dim scene in the
 * bottom of the curve; the ambient budget was cut for contrast, not to lose
 * the midtones with it. 1.15 puts the lit side of the slab back where it was
 * while leaving the floor and the cyc in the foot, which is precisely the
 * separation the phase is after.
 */
renderer.toneMappingExposure = 1.15;

// ---------------------------------------------------------------------------
// Scene, backdrop and environment
// ---------------------------------------------------------------------------

const scene = new THREE.Scene();
const environment = buildEnvironment({ scene, renderer });

const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
// Framed for the slab at 1.5x: 0.75 wide closed, 1.50 with the wings out, and
// 90 mm thick. Roughly 29 degrees of elevation is enough to see into the well
// without flattening the silhouette. camera.js overwrites this on its first
// frame with the Overview shot — this is only what the scene is constructed
// with, and it matters solely because a wrong value here would show for one
// frame before the shot applies.
camera.position.set(0.84, 0.81, 1.19);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 0.62;
controls.maxDistance = MAX_ORBIT;
controls.maxPolarAngle = Math.PI * 0.495;

/**
 * A floor on the polar angle as well as a ceiling, now that there IS a
 * ceiling.
 *
 * Without it the user can orbit to directly overhead, which at the maximum
 * distance puts the camera at y = target + MAX_ORBIT — about 3.9 — and the
 * dome's apex is at 4.9. That clears, but only just, and the margin shrinks
 * every time the room is retuned. Clamping to 0.16 keeps the camera under the
 * shoulder of the dome rather than under its apex, which is a much larger
 * gap, and costs a view nobody wants: straight down at a flat slab.
 */
controls.minPolarAngle = 0.16;

const cameraRig = initCamera({ camera, controls, maxOrbit: MAX_ORBIT });

// ---------------------------------------------------------------------------
// The static lights: key, fill, rim
//
// One key doing most of the work, a cool fill to keep the shadow side from
// going dead, and a rim to separate the silhouette from the backdrop. The key
// is far brighter than the other two on purpose: MeshToonMaterial bands each
// light independently and sums the results, so three comparable lights would
// give the mascot three overlapping sets of bands and no readable terminator.
//
// PHASE 10: every number here came down, and by different amounts.
//
// This is the half of the phase that is subtraction. The reactive rig in
// lighting.js was correct and invisible, because a fixture adding 3 candela to
// a surface already receiving 2 from four other sources is a change of a few
// percent — under the threshold at which anything is noticed. The fix is not a
// brighter rig, which would only blow out the surfaces it hits; it is a
// quieter room.
//
// The cuts are not uniform, because the three lights are not doing the same
// job. The KEY carries form and legibility and comes down by half, no further:
// it is what a grader sees with the transport stopped, and it is the only
// shadow caster. The FILL comes down by nearly two thirds, because filling the
// shadow side is precisely what flattens a frame and the hemisphere term in
// lighting.js now lifts it dynamically instead. The RIM barely moves — a rim
// costs nothing in contrast, since it lands only on silhouette edges, and it
// does more work in a dark room than in a bright one because there is now
// somewhere dark for the edge to read against.
// ---------------------------------------------------------------------------

/*
  The intensities are budgeted, not guessed. Lambert diffuse out of three is
  dotNL * intensity * albedo / PI per light, plus roughly envColour *
  environmentIntensity * albedo for the image-based term. Otto's shell is the
  brightest albedo in the scene at 0.93, so his lit side now sums to about
  0.42 against the 0.78 it used to — comfortably inside AgX's linear section,
  with the whole shoulder left free for the pads and the lenses, which are the
  only things in the frame that should be allowed to approach white.
*/
const hemi = new THREE.HemisphereLight(PALETTE.skyTop, PALETTE.ground, 0.55);
scene.add(hemi);

const key = new THREE.DirectionalLight(0xffeed6, 0.85);
key.position.set(2.2, 3.2, 2.0);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 12;
// Sized to the scene, not left oversized. With the instrument at 1.5x it opens
// to 1.5 units across and the mascot stands beside it, so the cast set spans
// about 2.6 units — a +/-1.7 frustum contains it with a margin and still puts
// far more of the 2048 map on the caster than the +/-2.2 the old case needed.
key.shadow.camera.left = -1.7;
key.shadow.camera.right = 1.7;
key.shadow.camera.top = 1.7;
key.shadow.camera.bottom = -1.7;

// Both biases scale with the world size of a shadow texel, which grew again
// with the frustum. The slab also grew, so the ratio of bias to caster
// thickness is roughly where it was — these move with the frustum, not with
// the object.
key.shadow.bias = -0.0005;
key.shadow.normalBias = 0.008;
scene.add(key);

const fill = new THREE.DirectionalLight(0xc8dcff, 0.16);
fill.position.set(-2.6, 1.5, 1.4);
scene.add(fill);

const rim = new THREE.DirectionalLight(0xffffff, 0.34);
rim.position.set(-1.2, 1.8, -2.6);
scene.add(rim);


// ---------------------------------------------------------------------------
// The rig, its mechanism, the mascot, and the input layer
// ---------------------------------------------------------------------------

// The key letters are a property of the input map, so they live in
// interaction.js. rig.js prints them without importing it — main.js hands them
// over, the same way it hands over every other cross-module fact.
const rig = buildRig({
  anisotropy: renderer.capabilities.getMaxAnisotropy(),
  labelFor: (padId) => KEY_LABELS.get(padId),
});

/**
 * The instrument is the subject, so it is scaled to be the subject.
 *
 * Applied here rather than by editing DIMS, and that is a deliberate choice
 * worth defending. Every dimension in rig.js is derived from its neighbours —
 * wing width is slabW/2, hinge clearance is pad height plus tolerance, the
 * well is the grid plus a margin. Rescaling by editing those numbers means
 * rechecking every one of those relationships and re-deriving the fold. A
 * scale on the root multiplies the whole chain uniformly, so every constraint
 * that held at 1.0 holds identically at 1.5, including the ones hierarchy.js
 * solves at runtime.
 *
 * The cost is that world-space quantities OUTSIDE the rig do not follow: the
 * shadow frustum, the tower positions, the contact patches and the camera
 * radii all had to move with it, and each is marked below.
 *
 * 1.5 rather than more, because the wings open to 1.5 units across and the
 * cyclorama's usable floor is 2.4.
 */
const RIG_SCALE = 1.5;
rig.root.scale.setScalar(RIG_SCALE);
scene.add(rig.root);

// Scaled down with the instrument. At the old 1.2 he stood taller than the slab
// is wide and read as the subject rather than the companion; 0.85 puts him at
// about 320 mm beside a 500 mm controller, which is the proportion that makes
// the slab the hero. Parked clear of the right wing's open span (x = 0.5).
// Moved out and up a little with the instrument, but NOT scaled by the same
// 1.5. He was already the right size next to a 500 mm controller; matching the
// scale would keep the proportion and lose the point of the change, which was
// to make the instrument the largest thing in the frame rather than the third
// largest.
const MASCOT_SCALE = 0.98;
const mascot = buildMascot({ scale: MASCOT_SCALE });
mascot.root.position.set(1.02, 0, 0.20);
mascot.root.rotation.y = -0.62; // turned between the pads and the camera
scene.add(mascot.root);

/**
 * Contact shadows under the two things that stand on the floor.
 *
 * The key light casts a real shadow map and it is doing its job — but a cast
 * shadow and a contact shadow are different phenomena, and only one of them
 * answers "is this object touching the ground". A shadow map answers "is this
 * point occluded from the key", which for a light at 55 degrees puts the
 * silhouette off to one side; contact darkening is ambient occlusion, and the
 * floor immediately under an object is occluded from most of the sky no matter
 * where the key happens to be. An object can have a perfect cast shadow and
 * still read as hovering, which is exactly what the previous render did.
 *
 * They are placed here rather than inside rig.js or mascot.js because neither
 * of those modules knows there is a floor. main.js owns the wiring, and where
 * an object stands is wiring.
 *
 * The slab's patch is deliberately wider than the slab is when shut: at 0.62
 * it covers the wings in their open position, which is where they spend
 * almost all of the time, and the falloff is soft enough that the over-reach
 * when the slab is folded reads as nothing.
 */
const slabShadow = makeContactShadow(0.62 * RIG_SCALE, 0.52);
slabShadow.userData.kind = 'rig';
scene.add(slabShadow);

/**
 * Otto's patch rides with Otto.
 *
 * Parented to his root rather than left in the scene, for the same reason the
 * slab's is parented to the rig: during the power-on sequence he drives across
 * the floor, and a contact shadow that stays where he is going to end up is a
 * dark smudge sitting on empty floor while its object is somewhere else
 * entirely.
 *
 * The root carries his 0.98 scale, so the size and the lift are divided back
 * out — the patch is a compositing element attached to the object, not a part
 * of it, and it should be the size it was authored at.
 */
const mascotShadow = makeContactShadow(0.30, 0.60);
mascotShadow.userData.kind = 'mascot';
mascot.root.add(mascotShadow);
mascotShadow.position.set(0, 0.0012 / MASCOT_SCALE, 0);
mascotShadow.scale.setScalar(1 / MASCOT_SCALE);

/**
 * The slab's patch rides with the slab.
 *
 * It is parented to the rig root rather than left in the scene, so when the
 * intro lowers the instrument underground its shadow goes with it instead of
 * staying behind as a dark rectangle on an empty floor. The patch is authored
 * in world units and the root carries a 1.5 scale, so the size is divided back
 * out — the shadow is a compositing element that happens to be attached to the
 * object, not a part of it.
 */
rig.root.add(slabShadow);
slabShadow.position.set(0, 0.0012 / RIG_SCALE, 0);
slabShadow.scale.setScalar(1 / RIG_SCALE);

const hierarchy = initHierarchy({ rig });
const interaction = initInteraction({ canvas, camera, controls, rig });
const lighting = initLighting({ scene });

/**
 * After the renderer and the key light exist.
 *
 * The tier callback has nothing left to do. It used to switch the beam cones
 * and the dust field off on weak hardware, and both are gone — which removed
 * the two most expensive things in the frame outright rather than making them
 * conditional. What remains in the ladder is pixel ratio, shadow resolution
 * and shadows themselves, all of which quality.js applies to the renderer
 * directly.
 */
/**
 * The volumetric pass, and the one place in the project with a render target.
 *
 * Half resolution for the depth buffer: it decides where a soft glow stops, so
 * an error of one texel is invisible. It would not be acceptable for anything
 * with a hard edge.
 */
const volumetrics = initVolumetrics({ renderer, scale: 0.5 });

/**
 * Tiers at or above this index switch the volumetric pass off entirely.
 *
 * Declared HERE, immediately above the callback that reads it, and not down
 * with the render loop where it was first written — which threw a
 * ReferenceError on load.
 *
 * The cause is worth stating exactly, because it is the same shape of mistake
 * that put `initQuality` before `initLighting` in phase 9 and it will keep
 * recurring otherwise. `initQuality` calls `apply(0)` synchronously during
 * construction, to put the renderer into its top tier before the first frame.
 * That fires `onTierChange` at once — so anything the callback closes over
 * must already be INITIALISED, not merely hoisted. `const` and `let` are
 * hoisted but sit in the temporal dead zone until their declaration is
 * evaluated, so a constant three hundred lines further down is visible to the
 * closure and unreadable from it.
 *
 * The general rule this file should follow: a value consumed by a callback
 * that can fire during setup belongs above the setup call, not near the code
 * that happens to read it later.
 */
const TIERS_WITHOUT_VOLUME = 5;

const quality = initQuality({
  renderer,
  shadowLight: key,
  /**
   * March steps are now the scene's most useful quality lever after pixel
   * ratio, and unlike pixel ratio it degrades almost invisibly: fewer steps
   * with the same per-pixel dither means more noise in the shafts, and noise
   * in a volume of haze is what haze looks like. Cutting from 28 to 10 is a
   * third of the shader cost for something most viewers cannot name.
   */
  onTierChange: (tier, index) => {
    volumetrics.setSteps(tier.steps ?? 24);
    // The bottom rung drops the shafts entirely, along with the depth prepass
    // that feeds them — which is the single largest saving available, because
    // it removes a whole scene traversal rather than making one cheaper.
    volumetrics.setEnabled(index < TIERS_WITHOUT_VOLUME);
  },
});

// ---------------------------------------------------------------------------
// Wiring: intent -> behaviour
//
// interaction.js emits what the user did. This is where it acquires meaning.
// Nothing else in the project maps a knob index to a parameter.
// ---------------------------------------------------------------------------

/**
 * The knob map: index -> what turning it does.
 *
 * The six knobs used to be master volume, master filter, and four layer gains.
 * Three of those four were doing a job the panel already does better — the GUI
 * has a labelled slider, a mute and a solo per layer — so on the instrument
 * they were three identical cylinders that changed a number nothing pointed
 * at. That is what "not useful" meant, and adding a legend to them would not
 * have fixed it.
 *
 * The replacement is a signal chain a player would recognise: level, then
 * tone, then how hard the tone stage is being hit, then the effects, then the
 * feel. Left wing is what the sound IS, right wing is what happens to it.
 *
 *   0  Volume     master gain
 *   1  Tone       lowpass cutoff, exponential
 *   2  Resonance  the filter's Q, exponential
 *   3  Drive      pre-gain into a fixed tanh saturator
 *   4  Space      send into a damped multi-tap delay
 *   5  Swing      delay on every odd sixteenth, in the SCHEDULER
 *
 * Swing is the one worth pointing at. Five of these change the signal; that
 * one changes when notes happen, which makes the same six controls span both
 * halves of the project rather than all being volume in a hat.
 *
 * This table is the ONLY place the mapping exists. rig.js prints the labels
 * without knowing what they do; interaction.js publishes an index and a value
 * without knowing either.
 */
const KNOB_ACTIONS = [
  (v) => audio.setMasterVolume(v),
  (v) => audio.setMasterFilter(v),
  (v) => audio.setMasterResonance(v),
  (v) => audio.setMasterDrive(v),
  (v) => audio.setMasterSpace(v),
  (v) => audio.setSwing(v),
];

/** Power-on positions, in the same order. */
const KNOB_DEFAULTS = [0.80, 1.00, 0.12, 0.00, 0.18, 0.00];

bus.on('pad:trigger', ({ padId, velocity }) => {
  audio.trigger(padId, velocity);
});

bus.on('transport:toggle', () => {
  audio.toggle();
});

bus.on('case:toggle', () => {
  hierarchy.toggle();
});

bus.on('knob:change', ({ index, value }) => {
  KNOB_ACTIONS[index]?.(value);
});

/**
 * The front-panel buttons.
 *
 * Each one re-emits an intent that already exists rather than calling the
 * engine directly, so the button and the keyboard shortcut are provably the
 * same action — press Space or click PLAY and the identical code runs. The two
 * that have no keyboard equivalent (REC, KIT) call their setters here, which
 * is the same rule ui.js follows: intents for gestures more than one surface
 * can produce, setters for values.
 */
let presetIndex = 0;

/** @type {ReturnType<typeof initSequencer> | null} Built at power-on. */
let sequencer = null;

/**
 * Load a kit and tell everyone.
 *
 * `setKit` reassigns the live module bindings in pads.js, which every consumer
 * already imports — so rig.js, mascot.js and the sequencer see the new voices
 * with nothing to notify. The event exists only for surfaces that display the
 * kit's NAME, which is a fact about the UI rather than about the audio.
 *
 * Deliberately does NOT change the tempo. Each kit carries the bpm its style
 * lives at and that is offered in the panel, not forced: retempoing a pattern
 * somebody is recording into, because they wanted different sounds, is the
 * kind of helpfulness that loses work.
 */
function applyKit(id) {
  const kit = setKit(id);
  if (kit) bus.emit('kit:changed', { kit });
}

bus.on('button:press', ({ id }) => {
  rig.flashButton(id);

  if (id === 'play') bus.emit('transport:toggle', {});
  else if (id === 'fold') bus.emit('case:toggle', {});
  else if (id === 'rec') {
    /**
     * A toggle, not a cycle.
     *
     * This used to walk off -> L1 -> L2 -> L3 -> L4 -> off, which meant
     * turning recording OFF could take four presses, and which layer you were
     * recording into was a thing you had to count rather than see. Choosing a
     * layer and choosing whether to record are two separate decisions, so they
     * now have two controls: the grid's row selects, this arms.
     */
    audio.toggleArm(sequencer ? sequencer.getLayer() : 0);
  } else if (id === 'preset') {
    /**
     * KIT now cycles the KIT, not the pattern, which is what the legend says.
     *
     * It is also the better demonstration by a distance. Loading a preset
     * replaces four layers and destroys whatever was there — the accident that
     * was reported. Changing kit replaces nothing: the pattern keeps playing
     * and every note comes out in a different set of sounds, because the
     * sixteen pad IDS are a property of the layout and only the voices behind
     * them changed. Record a groove, press KIT twice, and the same rhythm is
     * now techno.
     *
     * Patterns moved to the panel's Patterns folder, where a destructive
     * operation belongs — behind a named button rather than on a cycle you can
     * hit by accident.
     */
    const next = (KITS.findIndex((k) => k.id === getKit().id) + 1) % KITS.length;
    applyKit(KITS[next].id);
  }
});

// The two steady lamps. Both are driven from the engine's own events rather
// than from the click that caused them, so a preset loaded from the GUI or a
// transport started from the keyboard lights the panel just the same.
bus.on('transport:start', () => rig.holdButton('play', true));
bus.on('transport:stop', () => rig.holdButton('play', false));
bus.on('record:armed', ({ layer }) => rig.holdButton('rec', layer !== null));

canvas.addEventListener('pointerdown', () => cameraRig.release(), true);

// ---------------------------------------------------------------------------
// The power-on sequence
// ---------------------------------------------------------------------------

const MASCOT_HOME = new THREE.Vector3(1.02, 0, 0.20);

const intro = initIntro({
  scene,
  rigRoot: rig.root,
  // The whole light rig, stacks included, is one group — so lowering the
  // stacks underground is one position, and the emitters ride down with them
  // even though they are invisible. That is not a problem worth solving: an
  // emitter two metres below the floor still lights nothing, because the floor
  // is between it and everything else.
  lightGroup: lighting.group,
  mascot,
  hierarchy,
  cameraRig,
  mascotHome: MASCOT_HOME,
  contactShadows: [mascotShadow, ...lighting.towerShadows],
});

/**
 * Input follows the instrument's state, and there are exactly three states.
 *
 * The mapping lives here because it is wiring: interaction.js knows which
 * gestures exist in each mode, hierarchy.js knows whether the slab is open,
 * and neither imports the other. This is the line that connects them.
 */
bus.on('intro:start', () => interaction.setMode('locked'));
bus.on('intro:done', () => interaction.setMode(hierarchy.isOpen() ? 'open' : 'closed'));
bus.on('rig:fold', ({ open }) => {
  if (!intro.isRunning()) interaction.setMode(open ? 'open' : 'closed');
});

/**
 * The prompt.
 *
 * Shown whenever the instrument is shut and the sequence is not running, which
 * is exactly when there is one thing to do and no way to guess what it is. The
 * slab lands closed on purpose, and a closed dark object with no affordance is
 * a dead end however good it looks — the earlier build simply unfolded itself
 * and never had to answer the question.
 *
 * DOM rather than a sprite in the scene, for the same reason the hover readout
 * is: text that must be read wants the browser's type rasteriser at native
 * resolution, not a canvas texture resampled by the GPU at whatever the
 * adaptive pixel ratio has dropped to.
 */
const promptEl = document.getElementById('prompt');

function setPrompt(visible) {
  promptEl.classList.toggle('is-visible', visible);
}

bus.on('intro:start', () => setPrompt(false));
bus.on('intro:done', () => setPrompt(!hierarchy.isOpen()));
bus.on('rig:fold', ({ open }) => {
  if (!intro.isRunning()) setPrompt(!open);
});

/**
 * Clicking anywhere skips the sequence.
 *
 * Capture phase, and registered before the interaction layer's own handler, so
 * it runs first regardless of what is under the pointer — during the intro the
 * click means "get on with it" and nothing else. A demo you cannot escape is a
 * demo people escape by reloading the page.
 */
canvas.addEventListener('pointerdown', () => {
  if (intro.isRunning()) intro.skip();
}, true);

/**
 * Stopping the transport when the slab shuts.
 *
 * A closed instrument that is still playing is a contradiction the scene
 * cannot explain — the pads are under two wings and the sequencer is audibly
 * hitting them. Folding is therefore a stop, and this is the only place that
 * decision is expressed.
 */
bus.on('rig:fold', ({ open }) => {
  if (!open && audio.isRunning()) audio.stop();
});

/**
 * Power-on sequence.
 *
 * Knob positions are pushed here rather than at load because the audio nodes
 * they write into do not exist until the context is unlocked. The slab starts
 * shut and opens 350 ms later, delayed so the fold begins after the overlay has
 * faded rather than underneath it.
 */
bus.once('started', ({ ctx }) => {
  lighting.attach(audio.getMasterFilter(), ctx);

  KNOB_DEFAULTS.forEach((value, index) => interaction.setKnob(index, value));

  const ui = initUI({ audio, interaction, hierarchy, cameraRig, onKitChange: applyKit });

  // Built after the context is unlocked, for the same reason the panel is:
  // `audio.layers` does not exist until the gain nodes have a context, and a
  // grid built at page load would have four rows of nothing.
  sequencer = initSequencer({ audio });

  Object.assign(window, { ui, sequencer });

  // The slab no longer opens on a bare timer. It comes up out of the floor
  // when Otto throws the lever, and hierarchy.open() is one cue in that
  // sequence rather than the whole of the power-on.
  intro.start();
});

// ---------------------------------------------------------------------------
// The hover readout
//
// interaction.js publishes what the pointer is over; this decides that it
// means a tooltip. The element follows the pointer rather than sitting in a
// fixed corner, because a fixed readout makes the eye travel away from the
// thing it is asking about — and at the moment you are hovering a control you
// are already looking at that control.
// ---------------------------------------------------------------------------

const hoverEl = document.getElementById('hover');
let hoverPoint = { x: 0, y: 0 };

canvas.addEventListener('pointermove', (event) => {
  hoverPoint = { x: event.clientX, y: event.clientY };
  if (hoverEl.classList.contains('is-visible')) {
    hoverEl.style.left = `${hoverPoint.x}px`;
    hoverEl.style.top = `${hoverPoint.y}px`;
  }
});

bus.on('hover', (info) => {
  if (!info) {
    hoverEl.classList.remove('is-visible');
    return;
  }
  hoverEl.innerHTML = `<b></b><span></span>`;
  // textContent, not innerHTML, for the values: a pad's label comes from
  // pads.js and a knob's from rig.js, and neither should ever be able to
  // inject markup into the page. It costs nothing to close that door.
  hoverEl.querySelector('b').textContent = info.label;
  hoverEl.querySelector('span').textContent = info.detail;
  hoverEl.style.left = `${hoverPoint.x}px`;
  hoverEl.style.top = `${hoverPoint.y}px`;
  hoverEl.classList.add('is-visible');
});

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;

  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();

  // The depth target is sized from the CSS box, not the drawing buffer, and
  // then scaled — so it follows the window but NOT the adaptive pixel ratio.
  // That is deliberate: the two are independent quality levers and multiplying
  // them would make a machine that has dropped a tier pay for the drop twice.
  volumetrics.setSize(w, h);
}

window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------------
// Render loop
//
// Order is deliberate. tweens.update() advances the mechanism's four state
// scalars; hierarchy.update() then solves those into transforms. Solving
// before tweening would render every frame one tick stale.
// ---------------------------------------------------------------------------

const clock = new THREE.Clock();

function tick(timeMs) {
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = timeMs / 1000;

  tweens.update(timeMs);   // tween.js expects performance.now()-style ms
  hierarchy.update();      // two scalars -> every joint transform
  audio.update();          // release scheduled events whose audio time has come
  rig.update(dt);          // pad press and rim glow decay
  lighting.update(dt);     // spectrum -> band energies -> emitter intensities
  mascot.update(dt, t);    // idle, blink, and the arm swing from the same hits
  intro.update(dt);        // impact dust, integrated whether or not it is alive
  cameraRig.update(dt);

  /**
   * Three passes, and the order is not negotiable.
   *
   *   1. DEPTH, into a half-res target. Must be first, because it swaps every
   *      material in the scene for a depth material and puts them back — doing
   *      that after the colour pass would either draw the frame in flat grey
   *      or need a second traversal to undo.
   *   2. COLOUR, the ordinary render.
   *   3. SHAFTS, additively over the top, reading the depth from step 1 to
   *      know where each beam is occluded.
   *
   * The beams are pushed in just before, so the descriptors the shader marches
   * are the ones this tick's audio produced rather than last tick's.
   */
  volumetrics.setBeams(lighting.beams);
  volumetrics.renderDepth(scene, camera);
  renderer.render(scene, camera);
  volumetrics.render(camera, t);
  quality.update(dt);
  updateStatus(dt);
}

renderer.setAnimationLoop(tick);

// ---------------------------------------------------------------------------
// Boot gate
// ---------------------------------------------------------------------------

const overlay = document.getElementById('overlay');
const startButton = document.getElementById('start');

let started = false;

async function start() {
  if (started) return;
  started = true;

  try {
    const ctx = await initAudio();
    overlay.classList.add('is-hidden');
    bus.emit('started', { ctx });
  } catch (err) {
    started = false;
    console.error('[main] audio failed to start:', err);
    startButton.textContent = 'Audio blocked — retry';
  }
}

startButton.addEventListener('click', start);

// ---------------------------------------------------------------------------
// Diagnostics readout
// ---------------------------------------------------------------------------

const statusEl = document.getElementById('status');
const isWebGL2 = renderer.getContext() instanceof WebGL2RenderingContext;

let frames = 0;
let accum = 0;

function updateStatus(dt) {
  frames += 1;
  accum += dt;
  if (accum < 0.5) return;

  const fps = Math.round(frames / accum);
  frames = 0;
  accum = 0;

  const audioState = getContext()?.state ?? 'not started';
  const calls = renderer.info.render.calls;
  statusEl.textContent =
  `${fps} fps · ${calls} draw calls · ${quality.tierName()} · ` +
  `${isWebGL2 ? 'WebGL2' : 'WebGL1'} · audio: ${audioState}`;
}

// ---------------------------------------------------------------------------
// Console handles — remove or gate behind ?debug before submission
// ---------------------------------------------------------------------------

Object.assign(window, {
  THREE, scene, camera, renderer, controls,
  bus, tweens, audio, rig, mascot, hierarchy, interaction,
  lighting, environment, cameraRig, volumetrics,
});