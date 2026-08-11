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
import { verticalGradientTexture, studioEnvironmentTexture } from './textures.js';
import { buildRig } from './rig.js';
import { buildMascot } from './mascot.js';
import { initHierarchy } from './hierarchy.js';
import { initInteraction, KEY_LABELS } from './interaction.js';

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

const canvas = document.getElementById('scene');

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});

renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

/**
 * Neutral tone mapping rather than ACES.
 *
 * Both compress the linear render into displayable range; they disagree about
 * what to do with saturated colour on the way. ACES was designed for film and
 * deliberately desaturates as values climb, so a bright saturated pad drifts
 * towards white — which is correct for a photographed highlight and wrong for
 * a flat cartoon surface that is supposed to stay the colour it was painted.
 * Khronos PBR Neutral holds hue and saturation until it is genuinely forced to
 * roll off. On this palette the difference is the whole look: under ACES the
 * pad colours wash out to pastel under the key light.
 *
 * The cost is honest: it protects highlights less well. Nothing here is a
 * chrome sphere, so there is nothing to protect.
 */
renderer.toneMapping = THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

// ---------------------------------------------------------------------------
// Scene, backdrop and environment
// ---------------------------------------------------------------------------

const scene = new THREE.Scene();

// A gradient rather than a flat colour. A flat background gives the silhouette
// exactly one contrast value to sit against, so whichever value is chosen, part
// of the object disappears into it. A vertical ramp guarantees the light top of
// the case reads against a darker band and its shadow side against a lighter
// one.
scene.background = verticalGradientTexture(PALETTE.skyTop, PALETTE.skyBottom);

/**
 * The environment map, prefiltered.
 *
 * PMREMGenerator turns one equirectangular image into the mip chain that image
 * based lighting needs: each level is the original convolved with a wider
 * cosine lobe, so a roughness of 0.1 samples a sharp level and a roughness of
 * 0.9 samples a blurred one. Without that prefilter, roughness would have
 * nothing to select between and every roughness map in the project would be
 * doing nothing.
 *
 * Both the source texture and the generator are disposed immediately: the
 * result lives on the GPU and neither is needed again.
 */
const pmrem = new THREE.PMREMGenerator(renderer);
const equirect = studioEnvironmentTexture();
scene.environment = pmrem.fromEquirectangular(equirect).texture;
scene.environmentIntensity = 0.50;
equirect.dispose();
pmrem.dispose();

// Fog matched to the bottom of the backdrop, so the ground plane dissolves into
// it instead of ending at a visible edge. This is the infinite studio sweep
// done in two lines. Near is set beyond the rig, so nothing on the instrument
// is ever fogged.
scene.fog = new THREE.Fog(PALETTE.skyBottom, 5, 12);

const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
camera.position.set(1.55, 1.18, 1.85);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.target.set(0.05, 0.42, 0);
controls.minDistance = 0.8;
controls.maxDistance = 8;
controls.maxPolarAngle = Math.PI * 0.495;

// ---------------------------------------------------------------------------
// Lights (phase 5 replaces these with the analyser-driven set)
//
// One key doing most of the work, a cool fill to keep the shadow side from
// going dead, and a rim to separate the silhouette from the backdrop. The key
// is far brighter than the other two on purpose: MeshToonMaterial bands each
// light independently and sums the results, so three comparable lights would
// give the mascot three overlapping sets of bands and no readable terminator.
// ---------------------------------------------------------------------------

/*
  The intensities are budgeted, not guessed. Lambert diffuse out of three is
  dotNL * intensity * albedo / PI per light, plus roughly envColour *
  environmentIntensity * albedo for the image based term. The shell's albedo is
  0.93 — it is nearly white — so the lit side sums to about 0.78, which sits
  just under the 0.76 point where Neutral tone mapping begins to compress.
  Budgeting to that line is what keeps the shell reading as cream instead of
  bleaching to white, and the pads reading as colours instead of as pastels.
*/
const hemi = new THREE.HemisphereLight(PALETTE.skyTop, PALETTE.ground, 0.30);
scene.add(hemi);

const key = new THREE.DirectionalLight(0xfff3e0, 1.75);
key.position.set(2.2, 3.2, 2.0);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 12;
key.shadow.camera.left = -2.2;
key.shadow.camera.right = 2.2;
key.shadow.camera.top = 2.2;
key.shadow.camera.bottom = -2.2;
key.shadow.bias = -0.0006;
key.shadow.normalBias = 0.012;
scene.add(key);

const fill = new THREE.DirectionalLight(0xd6e6ff, 0.45);
fill.position.set(-2.6, 1.5, 1.4);
scene.add(fill);

const rim = new THREE.DirectionalLight(0xffffff, 0.38);
rim.position.set(-1.2, 1.8, -2.6);
scene.add(rim);

// ---------------------------------------------------------------------------
// Ground
// ---------------------------------------------------------------------------

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(14, 64),
  new THREE.MeshStandardMaterial({
    color: PALETTE.ground,
    roughness: 0.95,
    metalness: 0.0,
  })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

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

const mascot = buildMascot({ scale: 1.2 });
mascot.root.position.set(0.86, 0, 0.24);
mascot.root.rotation.y = -0.53; // turned between the pads and the camera
scene.add(mascot.root);

const hierarchy = initHierarchy({ rig });
const interaction = initInteraction({ canvas, camera, controls, rig });

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

/**
 * Power-on sequence.
 *
 * Knob positions are pushed here rather than at load because the audio nodes
 * they write into do not exist until the context is unlocked. The unfold is
 * delayed slightly so it begins after the overlay has faded rather than
 * underneath it.
 */
bus.once('started', () => {
  interaction.setKnob(KNOB_VOLUME, 0.8);
  interaction.setKnob(KNOB_FILTER, 1.0);
  for (let i = 0; i < 4; i++) interaction.setKnob(KNOB_LAYER_0 + i, 0.9);

  setTimeout(() => hierarchy.unfold(), 350);
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
  hierarchy.update();      // four scalars -> every joint transform
  audio.update();          // release scheduled events whose audio time has come
  rig.update(dt);          // pad press and rim glow decay
  mascot.update(dt, t);    // idle, blink, and the arm swing from the same hits
  controls.update();
  bus.emit('frame', { dt, t });

  renderer.render(scene, camera);
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
    `${fps} fps · ${calls} draw calls · ${isWebGL2 ? 'WebGL2' : 'WebGL1'} · audio: ${audioState}`;
}

// ---------------------------------------------------------------------------
// Console handles — remove or gate behind ?debug before submission
// ---------------------------------------------------------------------------

Object.assign(window, {
  THREE, scene, camera, renderer, controls,
  bus, tweens, audio, rig, mascot, hierarchy, interaction,
});
