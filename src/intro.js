
/**
  intro.js — the power-on sequence.
*/

import * as THREE from 'three';
import { Tween, Easing } from '@tweenjs/tween.js';
import { tweens } from './tweens.js';
import { bus } from './events.js';
import { PALETTE } from './palette.js';
import { roundedBoxGeometry, roundedCylinderGeometry } from './geometry.js';
import { makeContactShadow, ROOM } from './environment.js';
import { radialFalloffTexture } from './textures.js';

// -------
// Staging
// -------

/** 
  Drop values
*/
const RIG_DROP = 2.20;
const TOWER_DROP = 2.40;

const FLOOR_LIMIT = ROOM.stageR - 0.15;

/**
  Rob8's entry: behind and to the right, on flat ground.
*/
const ENTRY = { x: 2.30, z: -1.70 };

/**
  Project a ground position back inside the flat floor if it is outside it.
*/
function clampToFloor(x, z) {
  const r = Math.hypot(x, z);
  if (r <= FLOOR_LIMIT) return { x, z };
  const k = FLOOR_LIMIT / r;
  return { x: x * k, z: z * k };
}

/** Where the console stands, and where he pulls up beside it. */
const CONSOLE = { x: 1.66, z: 0.52 };

/** Absolute times in milliseconds from the start. */
const CUE = {
  driveIn: 0,
  driveDuration: 2300,
  reach: 1950,
  throwHandle: 2200,
  pullBack: 2300,
  pullBackDuration: 1500,
  towers: 2600,
  towerFall: 1000,
  rig: 3050,
  rigFall: 950,
  settle: 3100,
  settleDuration: 1300,
  done: 4500,
};

/**
 * @param {{
 *   scene: THREE.Scene, rigRoot: THREE.Object3D, stacksGroup: THREE.Object3D,
 *   mascot: any, hierarchy: any, cameraRig: any,
 *   mascotHome: THREE.Vector3, contactShadows?: THREE.Object3D[],
 * }} deps
 */
export function initIntro(deps) {
  /**
    Dependency validation, and the reason it is worth six lines.
  */
  const REQUIRED = ['scene', 'rigRoot', 'stacksGroup', 'mascot', 'hierarchy', 'cameraRig', 'mascotHome'];
  const missing = REQUIRED.filter((key) => !deps?.[key]);
  if (missing.length) {
    throw new Error(
      `[intro] missing dependencies: ${missing.join(', ')}. ` +
      `main.js passes 'stacksGroup: lighting.stacks' — if that one is missing, ` +
      `lighting.js predates the split of the cabinets out of the light rig.`
    );
  }

  const {
    scene, rigRoot, stacksGroup, mascot, hierarchy, cameraRig,
    mascotHome, contactShadows = [],
  } = deps;

  // -----------
  // The console
  // -----------

  const consoleRoot = new THREE.Group();
  consoleRoot.position.set(CONSOLE.x, 0, CONSOLE.z);
  // Turned to face the point Rob8 stops at, so the panel is raked towards him
  // and the throw is broadside to the default camera.
  consoleRoot.rotation.y = -0.62;
  scene.add(consoleRoot);

  const housingMat = new THREE.MeshStandardMaterial({
    color: PALETTE.cab, metalness: 0.05, roughness: 0.72,
  });
  const bezelMat = new THREE.MeshStandardMaterial({
    color: PALETTE.bezel, metalness: 0.85, roughness: 0.40,
  });
  const insetMat = new THREE.MeshStandardMaterial({
    color: PALETTE.grille, metalness: 0.0, roughness: 0.9,
  });
  const shaftMat = new THREE.MeshStandardMaterial({
    color: PALETTE.mech, metalness: 0.75, roughness: 0.28,
  });

  /**
    The grip and the two indicator lamps are unlit `MeshBasicMaterial`.
  */
  const gripMat = new THREE.MeshBasicMaterial({ color: 0xff5245 });
  const lampOff = new THREE.MeshBasicMaterial({ color: 0x2a1a1a });
  const lampOn = new THREE.MeshBasicMaterial({ color: 0x5fe6a8 });

  function part(geometry, material, x, y, z, parent) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    (parent ?? consoleRoot).add(mesh);
    return mesh;
  }

  // Plinth and body
  part(roundedBoxGeometry(0.280, 0.036, 0.240, 0.012, 3), bezelMat, 0, 0.018, 0);
  part(roundedBoxGeometry(0.250, 0.240, 0.210, 0.020, 3), housingMat, 0, 0.156, 0);

  // Four feet, visible under the plinth's overhang.
  for (const fx of [-1, 1]) {
    for (const fz of [-1, 1]) {
      part(roundedCylinderGeometry(0.016, 0.014, 0.005, 12, 2), insetMat,
        fx * 0.105, 0, fz * 0.085);
    }
  }

  /**
    The raked control panel: a thin slab pitched back 22 degrees, sitting in a
    machined bezel one size larger.
  */
  const panel = new THREE.Group();
  panel.position.set(0, 0.282, 0.010);
  panel.rotation.x = -THREE.MathUtils.degToRad(22);
  consoleRoot.add(panel);

  part(roundedBoxGeometry(0.230, 0.022, 0.190, 0.010, 3), bezelMat, 0, 0, 0, panel);
  part(roundedBoxGeometry(0.190, 0.016, 0.150, 0.007, 3), insetMat, 0, 0.010, 0, panel);

  // The gate the handle travels through: a raised collar with a slot in it,
  // built as two blocks either side of the gap
  for (const gx of [-1, 1]) {
    part(roundedBoxGeometry(0.060, 0.020, 0.120, 0.008, 3), bezelMat,
      gx * 0.052, 0.019, 0, panel);
  }

  const lamps = [-1, 1].map((lx) =>
    part(roundedCylinderGeometry(0.011, 0.008, 0.004, 14, 2), lampOff,
      lx * 0.062, 0.020, 0.056, panel)
  );

  /**
    The pivot
   */
  const pivot = new THREE.Group();
  pivot.position.set(0, 0.014, 0);
  panel.add(pivot);

  // Boss, shaft, collar and ball grip
  const boss = part(roundedCylinderGeometry(0.026, 0.070, 0.008, 20, 2), shaftMat, 0, 0, 0, pivot);
  boss.rotation.z = Math.PI / 2;
  boss.position.x = -0.035;

  part(roundedCylinderGeometry(0.013, 0.150, 0.006, 16, 2), shaftMat, 0, 0.010, 0, pivot);
  part(roundedCylinderGeometry(0.020, 0.020, 0.008, 16, 2), bezelMat, 0, 0.118, 0, pivot);
  part(roundedBoxGeometry(0.056, 0.056, 0.056, 0.028, 4), gripMat, 0, 0.168, 0, pivot);

  /** Thrown position and rest position, in the panel's own tilted frame. */
  const HANDLE_UP = -0.46;
  const HANDLE_DOWN = 0.62;
  pivot.rotation.x = HANDLE_UP;

  const consoleShadow = makeContactShadow(0.22, 0.58);
  consoleShadow.position.set(CONSOLE.x, 0.0012, CONSOLE.z);
  scene.add(consoleShadow);

  // ----
  // Dust
  // ----

  const DUST_POOL = 180;
  const DUST_PER_BURST = 44;

  const dustPositions = new Float32Array(DUST_POOL * 3);
  const dustVelocities = new Float32Array(DUST_POOL * 3);
  const dustLife = new Float32Array(DUST_POOL);
  const dustSeed = new Float32Array(DUST_POOL);
  let dustCursor = 0;

  const dustGeometry = new THREE.BufferGeometry();
  dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
  const dustColours = new Float32Array(DUST_POOL * 3);
  dustGeometry.setAttribute('color', new THREE.BufferAttribute(dustColours, 3));

  const dustMaterial = new THREE.PointsMaterial({
    size: 0.055,
    map: radialFalloffTexture(32, 1.6),
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
    fog: false,
    toneMapped: false,
  });

  const dust = new THREE.Points(dustGeometry, dustMaterial);
  dust.frustumCulled = false;
  dust.renderOrder = 3;
  scene.add(dust);

  /**
    Throw a ring of dust outward from an impact.
  */
  function burst(x, z, radius, strength = 1) {
    for (let i = 0; i < DUST_PER_BURST; i++) {
      const index = dustCursor;
      dustCursor = (dustCursor + 1) % DUST_POOL;

      const theta = Math.random() * Math.PI * 2;
      const r = radius * (0.55 + Math.random() * 0.45);
      const j = index * 3;

      dustPositions[j] = x + Math.cos(theta) * r * 0.4;
      dustPositions[j + 1] = 0.012 + Math.random() * 0.03;
      dustPositions[j + 2] = z + Math.sin(theta) * r * 0.4;

      const speed = (0.35 + Math.random() * 0.55) * strength;
      dustVelocities[j] = Math.cos(theta) * speed;
      dustVelocities[j + 1] = (0.12 + Math.random() * 0.30) * strength;
      dustVelocities[j + 2] = Math.sin(theta) * speed;

      dustLife[index] = 1;
      dustSeed[index] = 0.55 + Math.random() * 0.45;
    }
  }

  function updateDust(dt) {
    let alive = false;

    for (let i = 0; i < DUST_POOL; i++) {
      if (dustLife[i] <= 0) continue;
      alive = true;

      const j = i * 3;

      dustPositions[j] += dustVelocities[j] * dt;
      dustPositions[j + 1] += dustVelocities[j + 1] * dt;
      dustPositions[j + 2] += dustVelocities[j + 2] * dt;

      const drag = Math.exp(-dt * 2.6);
      dustVelocities[j] *= drag;
      dustVelocities[j + 1] = dustVelocities[j + 1] * drag + dt * 0.045;
      dustVelocities[j + 2] *= drag;

      dustLife[i] -= dt * 0.62;
      const fade = Math.max(0, dustLife[i]);
      const value = fade * fade * dustSeed[i] * 0.5;

      dustColours[j] = value * 0.95;
      dustColours[j + 1] = value * 0.92;
      dustColours[j + 2] = value * 0.86;
    }

    if (alive) {
      dustGeometry.attributes.position.needsUpdate = true;
      dustGeometry.attributes.color.needsUpdate = true;
    }
    dust.visible = alive;
  }

  // ------------------
  // Staging the actors
  // ------------------

  const rigHome = rigRoot.position.y;
  const stacksHome = stacksGroup.position.y;

  const shadowOpacities = contactShadows.map((s) => s.material.opacity);

  function stage() {
    rigRoot.position.y = rigHome + RIG_DROP;
    stacksGroup.position.y = stacksHome + TOWER_DROP;

    const entry = clampToFloor(ENTRY.x, ENTRY.z);
    mascot.root.position.set(entry.x, 0, entry.z);
    // Facing his direction of travel
    mascot.root.rotation.y = Math.atan2(
      CONSOLE.x - 0.40 - entry.x,
      CONSOLE.z + 0.20 - entry.z
    );
    pivot.rotation.x = HANDLE_UP;

    lamps.forEach((lamp) => { lamp.material = lampOff; });
    contactShadows.forEach((s) => { s.material.opacity = 0; });
    consoleShadow.material.opacity = 0;
    dust.visible = false;
    dustLife.fill(0);
  }

  // ------------
  // The sequence
  // ------------

  let timers = [];
  let running = false;
  let finished = false;

  function tween(target, to, duration, easing = Easing.Cubic.Out, delay = 0) {
    const t = new Tween(target).to(to, duration).easing(easing).delay(delay).start();
    tweens.add(t);
    return t;
  }

  function fadeShadow(mesh, to, duration, delay = 0) {
    tween(mesh.material, { opacity: to }, duration, Easing.Quadratic.Out, delay);
  }

  function opacityOf(mesh) {
    const index = contactShadows.indexOf(mesh);
    return index < 0 ? 0.5 : shadowOpacities[index];
  }

  function schedule() {
    const cues = [];
    const at = (ms, run) => cues.push({ ms, run });

    // Rob8 arrives, and the camera goes with him
    at(CUE.driveIn, () => {
      /**
        The camera FOLLOWS rather than being tweened to where he will be.
      */
      cameraRig.followObject(mascot.root, {
        radius: 1.55, phi: 1.24, theta: 0.86, ty: 0.22, ease: 2.6,
      });

      const stop = clampToFloor(CONSOLE.x - 0.40, CONSOLE.z + 0.20);
      tween(mascot.root.position, { x: stop.x, z: stop.z },
        CUE.driveDuration, Easing.Cubic.InOut);
      // Turning as he travels, so he arrives already facing the console rather
      // than arriving and then rotating, which reads as two separate moves.
      tween(mascot.root.rotation, { y: -0.95 }, CUE.driveDuration, Easing.Cubic.InOut);
      fadeShadow(consoleShadow, 0.58, 800, 700);
    });

    // he reaches
    at(CUE.reach, () => {
      mascot.look(0.26, -0.34);
      mascot.strike(1.0, -1);
    });

    // the throw
    at(CUE.throwHandle, () => {
      tween(pivot.rotation, { x: HANDLE_DOWN }, 380, Easing.Back.Out);
      lamps.forEach((lamp) => { lamp.material = lampOn; });
      bus.emit('intro:activate', {});
    });

    // camera pulls back to frame the stage
    at(CUE.pullBack, () => {
      cameraRig.moveTo(
        { radius: 2.05, phi: 1.06, theta: 0.66, target: [0.10, 0.42, 0] },
        CUE.pullBackDuration,
        'intro'
      );
    });

    // the stacks drop
    at(CUE.towers, () => {
      tween(stacksGroup.position, { y: stacksHome }, CUE.towerFall, Easing.Bounce.Out);
    });

    // Dust on contact
    at(CUE.towers + CUE.towerFall * 0.36, () => {
      for (const side of [-1, 1]) burst(side * 1.38, -0.12, 0.42, 1.15);
      contactShadows
        .filter((s) => s.userData.kind === 'tower')
        .forEach((s) => fadeShadow(s, opacityOf(s), 420));
    });

    // he backs off to his playing position
    at(CUE.settle, () => {
      tween(mascot.root.position, { x: mascotHome.x, z: mascotHome.z },
        CUE.settleDuration, Easing.Cubic.InOut);
      tween(mascot.root.rotation, { y: -0.62 }, CUE.settleDuration, Easing.Cubic.InOut);
      mascot.look(0, 0);
    });

    // the instrument drops
    at(CUE.rig, () => {
      tween(rigRoot.position, { y: rigHome }, CUE.rigFall, Easing.Bounce.Out);
    });

    at(CUE.rig + CUE.rigFall * 0.36, () => {
      burst(0, 0, 0.62, 1.0);
      contactShadows
        .filter((s) => s.userData.kind !== 'tower')
        .forEach((s) => fadeShadow(s, opacityOf(s), 420));
    });

    // and stops there, shut
    at(CUE.done, () => {
      finished = true;
      running = false;
      cameraRig.stopFollowing();
      bus.emit('intro:done', {});
    });

    return cues;
  }

  /**
    Run it.
  */
  function start() {
    if (running || finished) return;
    running = true;

    stage();
    timers = schedule().map((cue) => setTimeout(cue.run, cue.ms));
    bus.emit('intro:start', {});
  }

  /**
    Jump to the end
   */
  function skip() {
    if (!running) return;

    for (const timer of timers) clearTimeout(timer);
    timers = [];

    rigRoot.position.y = rigHome;
    stacksGroup.position.y = stacksHome;
    mascot.root.position.set(mascotHome.x, 0, mascotHome.z);
    mascot.root.rotation.y = -0.62;
    pivot.rotation.x = HANDLE_DOWN;
    lamps.forEach((lamp) => { lamp.material = lampOn; });

    contactShadows.forEach((s, i) => { s.material.opacity = shadowOpacities[i]; });
    consoleShadow.material.opacity = 0.58;
    dustLife.fill(0);
    dust.visible = false;

    cameraRig.stopFollowing();
    cameraRig.goTo('Overview', 700);

    finished = true;
    running = false;
    bus.emit('intro:done', { skipped: true });
  }

  // Park everything before the first frame, so the scene is never rendered
  // fully assembled and then yanked into the air.
  stage();

  return {
    start,
    skip,
    update: updateDust,
    burst,
    console: consoleRoot,
    pivot,
    isRunning: () => running,
    isFinished: () => finished,
  };
}