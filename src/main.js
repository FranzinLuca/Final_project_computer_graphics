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
import { initCamera, SHOTS } from './camera.js';
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
 * NEUTRAL, having been AgX, having been Neutral before that.
 *
 * The curve has followed the art direction both times, and the rule behind
 * both switches is the same one: pick the tone mapper that protects whatever
 * the frame is actually made of.
 *
 * The DARK STAGE was mostly shadow with a few very bright sources in it, so it
 * needed a real toe and shoulder — shadows compressing into a deep foot,
 * highlights rolling off rather than clipping. AgX has both and holds hue
 * better than ACES on the way up, which is why it won there.
 *
 * The PASTEL SCENE is the opposite frame. Almost everything sits in the upper
 * middle of the range, nothing is dark, and the few bright things are
 * saturated colour rather than white light. AgX's toe now crushes a scheme
 * whose entire design is high-lightness colour, and its shoulder desaturates
 * the pads exactly where they are supposed to be at their most vivid. Khronos
 * PBR Neutral holds hue and saturation until it is genuinely forced to roll
 * off, which is precisely the property this palette is built on.
 *
 * The cost is honest: Neutral protects highlights less well. Nothing here is a
 * chrome sphere and the brightest thing in the frame is a pad, so there is
 * nothing to protect.
 */
/**
 * AgX again, with the dark room.
 *
 * Neutral was the right answer for the pastel experiment — it holds hue and
 * saturation until genuinely forced to roll off, which is what a flat cartoon
 * surface needs. What it lacks is a shoulder: it is close to linear through
 * the midtones, which is fine when the frame occupies the middle of the range
 * and washed out when the frame is mostly dark with a few very bright sources
 * in it. That is exactly this frame.
 *
 * Still not ACES, for the reason that has held throughout: ACES desaturates as
 * values climb, and sixteen pads are lit by emission whose luminance
 * palette.js solves per hue. AgX has the filmic toe and shoulder without
 * spending that work.
 */
renderer.toneMapping =
  THREE.AgXToneMapping ?? THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping;

// Back to 1.0. The 1.15 existed to lift AgX's aggressive toe off the
// midtones; Neutral has no toe to compensate for, and the same exposure on a
// pale scheme would push the cream bezel into clipping.
// AgX's toe is aggressive by design and lands most of a dim scene in the
// bottom of the curve. The ambient budget was cut for contrast, not to lose
// the midtones with it.
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
 * Still a floor on the polar angle, for a different reason.
 *
 * It used to keep the camera clear of the dome's apex. There is no dome now,
 * so nothing is in the way — but straight down at a flat slab is a view nobody
 * wants, and more importantly the orbit degenerates there: at phi = 0 the
 * azimuth has no effect at all, so a user who drags to the top finds the
 * camera stops responding to half their input. 0.16 keeps the control
 * meaningful everywhere it can be reached.
 */
controls.minPolarAngle = 0.16;

const cameraRig = initCamera({ camera, controls, maxOrbit: MAX_ORBIT });

// ---------------------------------------------------------------------------
// The static lights: key, fill, rim
//
// THE BUDGET INVERTS WITH THE PALETTE.
//
// The dark stage cut every ambient term by roughly a factor of four so that a
// reactive fixture adding 3 candela to a surface was a visible change rather
// than a 5% one. The pastel scene wants the opposite: flat, generous,
// near-shadowless light, because a cartoon surface is a field of colour and
// the thing that ruins one is a dark terminator running across it.
//
// So the ambient terms go back up and the key comes down relative to them. The
// key is still the brightest single source — something has to cast the shadow
// and give the forms a direction — but the ratio between lit and unlit sides
// is now about 1.6:1 where on the dark stage it was nearer 6:1.
//
// The rim is the one that changes most. On a dark ground it was doing the
// heaviest lifting per unit of intensity, because a bright edge against black
// is free separation. Against a pale ground it lands on an edge that is
// already lighter than what surrounds it and does almost nothing, so it drops
// to a token value rather than being deleted — it still helps on the mascot's
// dark panel lines.
// ---------------------------------------------------------------------------

/*
  Budgeted, not guessed. Lambert diffuse out of three is
  dotNL * intensity * albedo / PI per light, plus roughly envColour *
  environmentIntensity * albedo for the image-based term. The cream bezel is
  the brightest albedo at 0.98, and its lit side sums to about 0.86 — under
  the point where Neutral begins to compress, which is what keeps cream reading
  as cream rather than clipping to white.
*/
const hemi = new THREE.HemisphereLight(PALETTE.skyTop, PALETTE.ground, 0.55);
scene.add(hemi);

const key = new THREE.DirectionalLight(0xffeed6, 0.85);
key.position.set(2.2, 3.2, 2.0);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 12;
key.shadow.camera.left = -1.7;
key.shadow.camera.right = 1.7;
key.shadow.camera.top = 1.7;
key.shadow.camera.bottom = -1.7;
key.shadow.bias = -0.0005;
key.shadow.normalBias = 0.008;

/**
 * A soft shadow, and a weak one.
 *
 * `shadow.intensity` scales how dark the occluded region gets. At 1.0 a shadow
 * on a pastel floor is a grey hole in a coloured field, which is the single
 * most effective way to make a cartoon scene look like a photograph of a toy.
 * 0.45 keeps the contact information — you can still see what is standing on
 * what — while letting the floor's own colour show through it.
 */
// Back to a full-strength shadow. A softened one was needed against a pale
// floor, where a dense shadow reads as a hole punched in the ground; on a dark
// floor the shadow has very little contrast to spend and needs all of it.
if ('intensity' in key.shadow) key.shadow.intensity = 1.0;
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
 * Rob8's patch rides with Rob8.
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

    /**
     * No tier switches the shafts off any more.
     *
     * The bottom rung used to, and it was the reason they vanished after a
     * minute on a machine that could not hold 50 fps: the controller stepped
     * down the ladder as designed, reached the tier that disables the pass,
     * and the retry backoff then kept it there. Correct behaviour, wrong
     * budget.
     *
     * Marching at half resolution took a factor of four out of the cost, so
     * the ladder can degrade the shafts — twenty-eight steps down to eight —
     * without ever removing them. A quality tier that deletes a feature is
     * admitting the feature costs too much; making it cost less is the better
     * answer, and it means the scene always looks like itself.
     */
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

/**
 * V cycles the authored shots.
 *
 * The camera stays free — orbiting is one of the interactions the brief lists
 * by name, and taking it away to protect the framing would be trading a graded
 * feature for a cosmetic one. What it needed was a way back, which this is.
 */
let shotIndex = 0;

bus.on('camera:next', () => {
  shotIndex = (shotIndex + 1) % SHOTS.length;
  cameraRig.goTo(SHOTS[shotIndex].name);
});

// ---------------------------------------------------------------------------
// The power-on sequence
// ---------------------------------------------------------------------------

const MASCOT_HOME = new THREE.Vector3(1.02, 0, 0.20);

const intro = initIntro({
  scene,
  rigRoot: rig.root,
  /**
   * The CABINETS, not the whole light rig.
   *
   * Handing over `lighting.group` moved the emitters with the speakers, which
   * for the first seconds of every session put them at nearly 6.4 in a room
   * whose dome apex is 4.9 — outside the enclosure, lighting the ceiling
   * through it. The intro animates furniture; the emitters are fixed points in
   * the room and it must not be able to reach them.
   */
  stacksGroup: lighting.stacks,
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
  // when Rob8 throws the lever, and hierarchy.open() is one cue in that
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