/**
  main.js — scene bootstrap, the single render loop, and all wiring.
  main.js is the only module allowed to know about every other module. It
  wires them together; they do not wire themselves to each other.
*/


/**
Import THREE library to have access to:
- scene graph
- renderer
- Materials/geometry/lighting model
- Math utility

Import OrbitControls for camera movement
*/
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';


/**
  Custom nodes
*/
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
import { KITS, setKit, getKit } from './pads.js';
import { initQuality } from './quality.js';
import { initVolumetrics } from './volumetrics.js';
import { initIntro } from './intro.js';

// -----------
// 1. Renderer
// -----------
// Assing to canvas the DOM object "scene" defined in index.html
const canvas = document.getElementById('scene');

// Instantiate the renderer 
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});

// Activate the shadowmap (if false castshadow flags will not work)
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

/** 
Tone mapping is needed to compress liner unbounded HDR int a displayable range
There are different tonemapping funcionts and each one will change the colors
(e.g different saturated colors)
*/

/**
The "??" is just defensive code to aboid crush when one is not defined due to some incompatibility
*/
renderer.toneMapping = THREE.AgXToneMapping ?? THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping;

// Exposure = pre multiplier, 1.15 compensate the AgX aggreassiveness on the midrange
renderer.toneMappingExposure = 1.15;

// -------------------------------
// Scene, backdrop and environment
// -------------------------------

// instantiate a new root scene, Top of the hierarchy 
const scene = new THREE.Scene();
// environment needs both scene and rendererm scende to attack the elements and renderer for lightning purpose
const environment = buildEnvironment({ scene, renderer });

// instantiate a new camera model
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
// camera.js overwrites this on its first frame with the Overview shot
// this is only the constructor and it matters only 
// because a wrong value here would show for one frame before the shot applies.
camera.position.set(0.84, 0.81, 1.19);

// Camera controls + settings for better experience
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 0.62;
controls.maxDistance = MAX_ORBIT;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minPolarAngle = 0.16;

const cameraRig = initCamera({ camera, controls, maxOrbit: MAX_ORBIT });

// ---------------------------------
// The static lights: key, fill, rim
// ---------------------------------

/**
Light budget tuned for specific palette
*/

// Approximation af ambient light imported from palette to keep single source of truth
const hemi = new THREE.HemisphereLight(PALETTE.skyTop, PALETTE.ground, 0.55);
scene.add(hemi);

// This light is the one doing directional work and casdt shadows
const key = new THREE.DirectionalLight(0xffeed6, 0.85);
key.position.set(2.2, 3.2, 2.0);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 12;
// Setup the bounding box where the shadows are evaluated
key.shadow.camera.left = -1.7;
key.shadow.camera.right = 1.7;
key.shadow.camera.top = 1.7;
key.shadow.camera.bottom = -1.7;

// Against artifacts
key.shadow.bias = -0.0005;
key.shadow.normalBias = 0.008;

/**
shadow.intensity scales how dark the occluded region gets. 
Guarding with intensity in key.shadows against older versions
*/

if ('intensity' in key.shadow) key.shadow.intensity = 1.0;
scene.add(key);

// fill add a small light to avoid pitch black shadows that eta away the details
const fill = new THREE.DirectionalLight(0xc8dcff, 0.16);
fill.position.set(-2.6, 1.5, 1.4);
scene.add(fill);

// rim light is needed to have better object's edges 
const rim = new THREE.DirectionalLight(0xffffff, 0.34);
rim.position.set(-1.2, 1.8, -2.6);
scene.add(rim);

// -------------------------------------------------------
// The rig, its mechanism, the mascot, and the input layer
// -------------------------------------------------------

// buildRig is a function from rig.js that build the whole rig
// The key letters are a property of the input map, so they live in
// interaction.js.

// anisotropy is just for sharpen the image
const rig = buildRig({
  anisotropy: renderer.capabilities.getMaxAnisotropy(),
  labelFor: (padId) => KEY_LABELS.get(padId),
});

/**
  used to scale up the instrument, the scale do not propagate outside the local space
*/
const RIG_SCALE = 1.5;
rig.root.scale.setScalar(RIG_SCALE);
// add the rig to the scene
scene.add(rig.root);

/**
  Buld the mascot (the mini robot wall-e like) and scale it based on the desired scene
  one want to create.

  buildMascot (similar to buildRig) comes from mascot.js

  set position of the mascot and add it to the scene
*/
const MASCOT_SCALE = 0.98;
const mascot = buildMascot({ scale: MASCOT_SCALE });
mascot.root.position.set(1.02, 0, 0.20);
mascot.root.rotation.y = -0.62; // turned between the pads and the camera
scene.add(mascot.root);

/**
  Contact shadow is used to give the impression of the objects to be in touch with the ground
  added to both slab and mascot.
  Both slab and mascot shadows have to be attached to the main root due to the initial animations
*/
const slabShadow = makeContactShadow(0.62 * RIG_SCALE, 0.52);
slabShadow.userData.kind = 'rig';
rig.root.add(slabShadow);
slabShadow.position.set(0, 0.0012 / RIG_SCALE, 0);
slabShadow.scale.setScalar(1 / RIG_SCALE);

/**
  Rob8's patch rides with Rob8.
*/
const mascotShadow = makeContactShadow(0.30, 0.60);
mascotShadow.userData.kind = 'mascot';
mascot.root.add(mascotShadow);
mascotShadow.position.set(0, 0.0012 / MASCOT_SCALE, 0);
mascotShadow.scale.setScalar(1 / MASCOT_SCALE);

/**
  init the hierarchy, interactions and lightning more details inside each function
*/
const hierarchy = initHierarchy({ rig });
const interaction = initInteraction({ canvas, camera, controls, rig });
const lighting = initLighting({ scene });
const volumetrics = initVolumetrics({ renderer, scale: 0.5 });

/** 
  initQuality is an automatic quality controller used to be sure that my program
  adapts to every browser case.§
  it will step down or up the quality settings based on the performance of the system
  to not link module between them (if i want to change it is a mess if they are linked)
  quality do not have direct access to volumetrics, everything is handled by the main
*/
const quality = initQuality({
  renderer,
  shadowLight: key,
  onTierChange: (tier, index) => {
    volumetrics.setSteps(tier.steps ?? 24);
  },
});
//quality.setTier(6)

// ---------------------------
// Wiring: intent -> behaviour
// ---------------------------

/**
  interaction.js only knows the interaction the user did not the meaning. 
  This is where it acquires meaning.
  The knob map: index -> what turning it does.

  Map:
    0  Volume     master gain
    1  Tone       lowpass cutoff, exponential
    2  Resonance  the filter's Q, exponential
    3  Drive      pre-gain into a fixed tanh saturator
    4  Space      send into a damped multi-tap delay
    5  Swing      delay on every odd sixteenth, in the SCHEDULER

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

/** 
  busses definitions, they are needed to link an event to a function. 
  here is only the link, to actually use it i need to call the emit
*/

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
  logic to change presets
*/

let presetIndex = 0;
let sequencer = null;

function applyKit(id) {
  const kit = setKit(id);
  if (kit) bus.emit('kit:changed', { kit });
}

/** 
  Logic for the buttons in the case under the pads
*/

bus.on('button:press', ({ id }) => {
  rig.flashButton(id);

  if (id === 'play') bus.emit('transport:toggle', {});
  else if (id === 'fold') bus.emit('case:toggle', {});
  else if (id === 'rec') {
    /**
      This used to walk off -> L1 -> L2 -> L3 -> L4 -> off,
    */
    audio.toggleArm(sequencer ? sequencer.getLayer() : 0);
  } else if (id === 'preset') {
    const next = (KITS.findIndex((k) => k.id === getKit().id) + 1) % KITS.length;
    applyKit(KITS[next].id);
  }
});

// Listen to the actual event to start not a click of some sort
bus.on('transport:start', () => rig.holdButton('play', true));
bus.on('transport:stop', () => rig.holdButton('play', false));
bus.on('record:armed', ({ layer }) => rig.holdButton('rec', layer !== null));

/** 
  Different from before this is a raw DOM listener for the camera.
*/
canvas.addEventListener('pointerdown', () => cameraRig.release(), true);

/**
  a simpler cycle to change preset shots
*/
let shotIndex = 0;

bus.on('camera:next', () => {
  shotIndex = (shotIndex + 1) % SHOTS.length;
  cameraRig.goTo(SHOTS[shotIndex].name);
});

// ---------------------
// The power-on sequence
// ---------------------

// vector beacuse needed for the animation
const MASCOT_HOME = new THREE.Vector3(1.02, 0, 0.20);

// intro animation sequence
const intro = initIntro({
  scene,
  rigRoot: rig.root,
  stacksGroup: lighting.stacks, // give ony the objects not the whole lightnigs
  mascot,
  hierarchy,
  cameraRig,
  mascotHome: MASCOT_HOME,
  contactShadows: [mascotShadow, ...lighting.towerShadows],
});

/**
  Input follows the instrument's state based on the inputs
*/
bus.on('intro:start', () => interaction.setMode('locked'));
bus.on('intro:done', () => interaction.setMode(hierarchy.isOpen() ? 'open' : 'closed'));
bus.on('rig:fold', ({ open }) => {
  if (!intro.isRunning()) interaction.setMode(open ? 'open' : 'closed');
});

/**
  Handle the visibility for the message at the start
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
  Clicking anywhere skips the sequence.
*/
canvas.addEventListener('pointerdown', () => {
  if (intro.isRunning()) intro.skip();
}, true);

/**
  Stop the sound when the lid is closed
*/
bus.on('rig:fold', ({ open }) => {
  if (!open && audio.isRunning()) audio.stop();
});

/**
  Power-on sequence.
*/
bus.once('started', ({ ctx }) => {
  // attach to audio to have reactive lights
  lighting.attach(audio.getMasterFilter(), ctx);
  // set the knobs to the default values
  KNOB_DEFAULTS.forEach((value, index) => interaction.setKnob(index, value));

  // set up the ui elements
  const ui = initUI({ audio, interaction, hierarchy, cameraRig, onKitChange: applyKit });

  // set up the sequencer
  sequencer = initSequencer({ audio });

  Object.assign(window, { ui, sequencer });

  // Start up the intro animation
  intro.start();
});

// ------------------
// The hover messages
// ------------------

/**
  interaction.js publishes what the pointer is over.
  The element follows the pointer and when you hover the
  control fires the message
*/

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
  hoverEl.querySelector('b').textContent = info.label;
  hoverEl.querySelector('span').textContent = info.detail;
  hoverEl.style.left = `${hoverPoint.x}px`;
  hoverEl.style.top = `${hoverPoint.y}px`;
  hoverEl.classList.add('is-visible');
});

// ------
// Resize
// ------

/**
  Dynamic resize based on browser window
*/

function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;

  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  volumetrics.setSize(w, h);
}

window.addEventListener('resize', resize);
resize();

// -----------
// Render loop
// -----------

// time utility
const clock = new THREE.Clock();


function tick(timeMs) {
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = timeMs / 1000;

  // update chain
  tweens.update(timeMs);   // tween.js expects performance.now()-style ms
  hierarchy.update();      // two scalars -> every joint transform
  audio.update();          // release scheduled events whose audio time has come
  rig.update(dt);          // pad press and rim glow decay
  lighting.update(dt);     // spectrum -> band energies -> emitter intensities
  mascot.update(dt, t);    // idle, blink, and the arm swing from the same hits
  intro.update(dt);        // impact dust, integrated whether or not it is alive
  cameraRig.update(dt);

  // gives the current light state
  volumetrics.setBeams(lighting.beams);
  // produce a distance map
  volumetrics.renderDepth(scene, camera);
  // render the colored scene
  renderer.render(scene, camera);
  // render the volumetric lights
  volumetrics.render(camera, t);
  // check time to render
  quality.update(dt);
  // refresh status on screen
  updateStatus(dt);
}

// automatic set the animation loop
renderer.setAnimationLoop(tick);

// ---------
// Boot gate
// ---------

const overlay = document.getElementById('overlay');
const startButton = document.getElementById('start');

let started = false;

// after start wait for audio
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

// -------------
// Debug readout
// -------------

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

// ---------------
// Console handles
// ---------------

Object.assign(window, {
  THREE, scene, camera, renderer, controls,
  bus, tweens, audio, rig, mascot, hierarchy, interaction,
  lighting, environment, cameraRig, volumetrics,
});