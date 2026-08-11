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
import { buildRig } from './rig.js';
import { initHierarchy } from './hierarchy.js';
import { initInteraction } from './interaction.js';

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
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

// ---------------------------------------------------------------------------
// Scene and camera
// ---------------------------------------------------------------------------

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0c0d);
scene.fog = new THREE.Fog(0x0b0c0d, 8, 30);

const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
camera.position.set(1.35, 1.15, 1.65);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.target.set(0, 0.45, 0);
controls.minDistance = 0.8;
controls.maxDistance = 8;
controls.maxPolarAngle = Math.PI * 0.495;

// ---------------------------------------------------------------------------
// Lights (phase 5 replaces these with the analyser-driven set)
// ---------------------------------------------------------------------------

const ambient = new THREE.HemisphereLight(0x8899aa, 0x141414, 0.45);
scene.add(ambient);

const key = new THREE.DirectionalLight(0xfff2dd, 2.6);
key.position.set(2.2, 3.4, 1.8);
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

const rim = new THREE.DirectionalLight(0x6699cc, 0.8);
rim.position.set(-2.6, 1.4, -2.0);
scene.add(rim);

// ---------------------------------------------------------------------------
// PLACEHOLDER ENVIRONMENT — phase 6 replaces this with the booth
// ---------------------------------------------------------------------------

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.9, metalness: 0.0 })
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const grid = new THREE.GridHelper(20, 40, 0x2a2d31, 0x1e2124);
grid.position.y = 0.001;
scene.add(grid);

// ---------------------------------------------------------------------------
// The rig, its mechanism, and the input layer
// ---------------------------------------------------------------------------

const rig = buildRig({ anisotropy: renderer.capabilities.getMaxAnisotropy() });
scene.add(rig.root);

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

  tweens.update(timeMs);   // tween.js expects performance.now()-style ms
  hierarchy.update();      // four scalars -> every joint transform
  audio.update();          // release scheduled events whose audio time has come
  rig.update(dt);          // pad press and LED decay
  controls.update();
  bus.emit('frame', { dt, t: timeMs / 1000 });

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
  bus, tweens, audio, rig, hierarchy, interaction,
});