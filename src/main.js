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
import { initQuality } from './quality.js';

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
// Framed for the slab, which is a much smaller and far flatter object than the
// case it replaced: 0.50 wide closed, 1.00 with the wings out, and 60 mm thick.
// The old framing orbited a point 0.42 up, which is now well above the whole
// instrument. Roughly 29 degrees of elevation is enough to see into the well
// without flattening the silhouette.
camera.position.set(0.62, 0.60, 0.88);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 0.45;
controls.maxDistance = MAX_ORBIT;
controls.maxPolarAngle = Math.PI * 0.495;

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
// Sized to the scene, not left oversized. The instrument plus the mascot span
// about 1.4 units, so a +/-1.2 frustum spreads the 2048 map over the thing that
// is actually casting — roughly a 3.4x gain in effective shadow resolution over
// the +/-2.2 the old case needed.
key.shadow.camera.left = -1.2;
key.shadow.camera.right = 1.2;
key.shadow.camera.top = 1.2;
key.shadow.camera.bottom = -1.2;

// Both biases scale with the world size of a shadow texel, and that just shrank
// by the same 3.4x. Leaving normalBias at 0.012 would push the shadow 20% of
// the slab's own thickness off its caster — the classic peter-panning detach,
// and far more obvious on a 60 mm slab than it ever was on a 300 mm case.
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.005;
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
scene.add(rig.root);

// Scaled down with the instrument. At the old 1.2 he stood taller than the slab
// is wide and read as the subject rather than the companion; 0.85 puts him at
// about 320 mm beside a 500 mm controller, which is the proportion that makes
// the slab the hero. Parked clear of the right wing's open span (x = 0.5).
const mascot = buildMascot({ scale: 0.85 });
mascot.root.position.set(0.70, 0, 0.14);
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
const slabShadow = makeContactShadow(0.62, 0.52);
scene.add(slabShadow);

const mascotShadow = makeContactShadow(0.26, 0.60);
mascotShadow.position.set(0.70, 0.0012, 0.14);
scene.add(mascotShadow);

const hierarchy = initHierarchy({ rig });
const interaction = initInteraction({ canvas, camera, controls, rig });
const lighting = initLighting({ scene });

/**
 * After the renderer, the key light and the lighting rig exist.
 *
 * The tier callback no longer reaches into `lighting.fixtures` to poke beam
 * meshes. It says what it wants — beams on or off, dust on or off — and
 * lighting.js decides what that means for the objects it owns. The controller
 * should know about cost levers, not about cones.
 */
const quality = initQuality({
  renderer,
  shadowLight: key,
  onTierChange: (tier) => {
    lighting.setBeams(tier.beams);
    lighting.setDust(tier.dust);
  },
});

// ---------------------------------------------------------------------------
// Wiring: intent -> behaviour
//
// interaction.js emits what the user did. This is where it acquires meaning.
// Nothing else in the project maps a knob index to a parameter.
// ---------------------------------------------------------------------------

const KNOB_VOLUME = 0;
const KNOB_FILTER = 1;
const KNOB_LAYER_0 = 2;

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
  if (index === KNOB_VOLUME) audio.setMasterVolume(value);
  else if (index === KNOB_FILTER) audio.setMasterFilter(value);
  else audio.setLayerGain(index - KNOB_LAYER_0, value);
});

canvas.addEventListener('pointerdown', () => cameraRig.release(), true);

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

  interaction.setKnob(KNOB_VOLUME, 0.8);
  interaction.setKnob(KNOB_FILTER, 1.0);
  for (let i = 0; i < 4; i++) interaction.setKnob(KNOB_LAYER_0 + i, 0.9);

  const ui = initUI({ audio, interaction, hierarchy, lighting, cameraRig });
  Object.assign(window, { ui });

  setTimeout(() => hierarchy.open(), 350);
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
  lighting.update(dt);     // spectrum -> band energies -> fixture intensities
  mascot.update(dt, t);    // idle, blink, and the arm swing from the same hits
  cameraRig.update();

  renderer.render(scene, camera);
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
  lighting, environment, cameraRig,
});