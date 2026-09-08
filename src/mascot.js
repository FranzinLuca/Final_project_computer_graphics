
/**
  mascot.js — Rob8
*/

import * as THREE from 'three';
import { bus } from './events.js';
import { PALETTE } from './palette.js';
import { PAD_BY_ID, PAD_INDEX } from './pads.js';
import { toonRamp } from './textures.js';
import { roundedBoxGeometry, roundedCylinderGeometry } from './geometry.js';

// -----------
// Proportions
// -----------

const BODY = { w: 0.20, h: 0.19, d: 0.16, y: 0.145 };
const TREAD = { w: 0.055, h: 0.075, d: 0.21, x: 0.105 };
const EYE = { offset: 0.048, radius: 0.040, barrel: 0.055 };

/** Where each arm hangs, and how it rests with the sticks up and ready. */
const ARMS = [
  { side: -1, swing: -0.25 },
  { side: 1, swing: 0.25 },
];

const REST = { lift: -1.50, elbow: 0.60, wrist: 0.30 };

/**
  Build Rob8.
  @param {{ scale?: number }} options
*/
export function buildMascot({ scale = 1.2 } = {}) {
  /**
    One ramp texture shared by every material on the character.
  */
  const gradientMap = toonRamp();

  const toon = (colour, extra = {}) =>
    new THREE.MeshToonMaterial({ color: colour, gradientMap, ...extra });

  const materials = {
    shell: toon(PALETTE.mascotBody),
    shade: toon(PALETTE.mascotShade),
    metal: toon(PALETTE.mascotMetal),
    dark: toon(PALETTE.mascotDark),
    lens: toon(PALETTE.mascotLens),
    stick: toon(PALETTE.stick),
    // One iris material for both eyes, so they light as a pair
    iris: toon(PALETTE.mascotLens, {
      emissive: new THREE.Color(PALETTE.mascotIris),
      emissiveIntensity: 1.0,
    }),
  };

  // shared geometry

  function axialCylinder(radius, length, corner, axis) {
    const geo = roundedCylinderGeometry(radius, length, corner, 24, 3);
    geo.translate(0, -length / 2, 0);
    if (axis === 'z') geo.rotateX(Math.PI / 2);
    else if (axis === 'x') geo.rotateZ(-Math.PI / 2);
    return geo;
  }

  const GEO = {
    body: roundedBoxGeometry(BODY.w, BODY.h, BODY.d, 0.028, 3),
    hatch: roundedBoxGeometry(0.115, 0.075, 0.012, 0.006, 3),
    tread: roundedBoxGeometry(TREAD.w, TREAD.h, TREAD.d, 0.030, 3),
    wheel: axialCylinder(0.024, 0.014, 0.006, 'x'),
    neck: roundedBoxGeometry(0.045, 0.055, 0.045, 0.018, 3),
    bridge: roundedBoxGeometry(0.075, 0.028, 0.030, 0.013, 3),
    barrel: axialCylinder(EYE.radius, EYE.barrel, 0.014, 'z'),
    lens: axialCylinder(EYE.radius * 0.82, 0.012, 0.005, 'z'),
    iris: axialCylinder(EYE.radius * 0.42, 0.010, 0.004, 'z'),
    upperArm: roundedBoxGeometry(0.024, 0.075, 0.024, 0.011, 3),
    forearm: roundedBoxGeometry(0.021, 0.065, 0.021, 0.010, 3),
    hand: roundedBoxGeometry(0.030, 0.022, 0.026, 0.009, 3),
    stick: roundedCylinderGeometry(0.0072, 0.115, 0.0072, 16, 3),
  };

  function part(geometry, material, x = 0, y = 0, z = 0) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  // the nesting that everything else hangs from

  const root = new THREE.Group();
  root.scale.setScalar(scale);

  const sway = new THREE.Group();       // slow idle lean
  root.add(sway);

  const bob = new THREE.Group();        // breathing, and the squash on a hit
  sway.add(bob);

  // chassis and tracks

  const body = part(GEO.body, materials.shell, 0, BODY.y, 0);
  bob.add(body);

  // A recessed panel on the chest
  bob.add(part(GEO.hatch, materials.shade, 0, BODY.y - 0.005, BODY.d / 2 - 0.002));

  const wheelSets = [];

  for (const side of [-1, 1]) {
    bob.add(part(GEO.tread, materials.dark, side * TREAD.x, TREAD.h / 2, 0));

    // Road wheels, on the outer face where they can be seen
    const wheels = [];
    for (const z of [-0.068, 0, 0.068]) {
      const wheel = part(
        GEO.wheel,
        materials.metal,
        side * (TREAD.x + TREAD.w / 2 - 0.004),
        TREAD.h / 2,
        z
      );
      bob.add(wheel);
      wheels.push(wheel);
    }
    wheelSets.push(wheels);
  }

  // neck and head

  const neck = new THREE.Group();
  neck.position.set(0, BODY.y + BODY.h / 2 - 0.005, -0.01);
  bob.add(neck);
  neck.add(part(GEO.neck, materials.metal, 0, 0.0275, 0));

  const headYaw = new THREE.Group();
  headYaw.position.y = 0.055;
  neck.add(headYaw);

  const headPitch = new THREE.Group();
  headYaw.add(headPitch);

  headPitch.add(part(GEO.bridge, materials.dark, 0, 0, 0));

  /**
    The eye barrels.
  */
  const eyes = [-1, 1].map((side) => {
    const group = new THREE.Group();
    group.position.set(side * EYE.offset, 0, 0.004);
    headPitch.add(group);

    group.add(part(GEO.barrel, materials.shell, 0, 0, -0.026));
    group.add(part(GEO.lens, materials.lens, 0, 0, 0.030));

    const iris = new THREE.Group();
    iris.position.z = 0.034;
    group.add(iris);
    iris.add(part(GEO.iris, materials.iris));

    return { group, iris, side };
  });

  // arms

  const arms = ARMS.map(({ side, swing }) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * (BODY.w / 2 - 0.004), BODY.y + 0.045, 0.01);
    shoulder.rotation.z = swing;
    bob.add(shoulder);

    const lift = new THREE.Group();
    lift.rotation.x = REST.lift;
    shoulder.add(lift);
    lift.add(part(GEO.upperArm, materials.metal, 0, -0.0375, 0));

    const elbow = new THREE.Group();
    elbow.position.y = -0.075;
    elbow.rotation.x = REST.elbow;
    lift.add(elbow);
    elbow.add(part(GEO.forearm, materials.metal, 0, -0.0325, 0));

    const wrist = new THREE.Group();
    wrist.position.y = -0.065;
    wrist.rotation.x = REST.wrist;
    elbow.add(wrist);
    wrist.add(part(GEO.hand, materials.dark, 0, -0.011, 0));

    const stick = part(GEO.stick, materials.stick, 0, -0.016, 0);
    stick.rotation.x = Math.PI * 0.86;
    wrist.add(stick);

    return { shoulder, lift, elbow, wrist, side, strike: 0, swing0: swing };
  });

  // ----------------
  // Reacting to hits
  // ----------------

  let nextArm = 0;
  const lookTarget = new THREE.Vector2(0, 0);
  const irisColour = new THREE.Color(PALETTE.mascotIris);
  const irisTarget = new THREE.Color(PALETTE.mascotIris);
  let flash = 0;

  /**
    Swing an arm, without a pad being involved.
    @param {number} velocity
    @param {number | null} side  -1 or 1 to choose a specific arm
  */
  function strike(velocity = 1, side = null) {
    const arm = side === null
      ? arms[nextArm++ % arms.length]
      : arms.find((a) => a.side === side) ?? arms[0];

    if (arm) arm.strike = Math.max(arm.strike, velocity);
    flash = Math.max(flash, velocity);
    return arm;
  }

  bus.on('pad:hit', ({ padId, velocity = 1 }) => {
    // Alternate hands
    strike(velocity);

    // The eyes take the colour of the pad that fired
    const pad = PAD_BY_ID.get(padId);
    if (pad) irisTarget.setHSL(pad.hue, 0.75, 0.62);

    const index = PAD_INDEX.get(padId);
    if (index !== undefined) {
      lookTarget.set(
        ((index % 4) - 1.5) * 0.10,
        -(Math.floor(index / 4) - 1.5) * 0.06
      );
    }
  });

  // -------------------
  // Per-frame animation
  // -------------------

  let blinkCountdown = 2.0;
  let blinking = 0;

  const BLINK_DURATION = 0.16;

  // ------------
  // Keeping time
  // ------------
  let bpm = 100;
  let playing = false;

  /**
    Beats since the transport started, as a running float.
  */
  let beatPhase = 0;

  /** How much of the groove is showing, 0..1. Ramped, never switched. */
  let grooveAmount = 0;

  bus.on('transport:bpm', (payload) => { bpm = payload.bpm; });

  bus.on('transport:start', () => {
    playing = true;
    beatPhase = 0;
  });

  bus.on('transport:stop', () => { playing = false; });

  bus.on('transport:step', ({ step }) => {
    // Resync on the downbeat only
    if (step % 4 === 0) beatPhase = Math.round(beatPhase);
  });

  /**
   * @param {number} dt seconds since the last frame
   * @param {number} t  seconds since the page started
   */
  function update(dt, t) {
    let impulse = 0;
    for (const arm of arms) {
      arm.strike *= Math.exp(-dt * 9);
      if (arm.strike < 0.001) arm.strike = 0;
      impulse = Math.max(impulse, arm.strike);
    }
    flash *= Math.exp(-dt * 6);

    // the beat .
    if (playing) beatPhase += dt * (bpm / 60);

    const grooveTarget = playing ? 1 : 0;
    grooveAmount += (grooveTarget - grooveAmount) * Math.min(1, dt * 3.2);

    const beat = beatPhase * Math.PI * 2;

    // chassis
    sway.rotation.z = Math.sin(t * 0.9) * 0.030;

    bob.position.y =
      Math.sin(t * 2.1) * 0.006
      - impulse * 0.020
      - grooveAmount * Math.max(0, Math.sin(beat * 2)) * 0.012;

    bob.scale.set(1 + impulse * 0.05, 1 - impulse * 0.075, 1 + impulse * 0.05);

    // Tracks rock back under the recoil.
    for (const wheels of wheelSets) {
      for (const wheel of wheels) wheel.rotation.x = -impulse * 0.9;
    }

    // arms
    for (const arm of arms) {
      /**
        Opposite phase per side, so the sticks alternate.
      */
      const phase = beat + (arm.side > 0 ? Math.PI : 0);
      const groove = Math.sin(phase) * grooveAmount * 0.20;

      // Idle sway, so he is never completely still even stopped.
      const idle = Math.sin(t * 1.1 + arm.side) * 0.035 * (1 - grooveAmount);

      arm.lift.rotation.x = REST.lift + groove + idle + arm.strike * 0.62;
      arm.elbow.rotation.x = REST.elbow - groove * 0.45 - arm.strike * 0.38;
      arm.wrist.rotation.x = REST.wrist - groove * 0.30 + arm.strike * 0.70;

      // A little shoulder rotation with the swing, so the arm travels slightly
      // outward as it lifts instead of hinging in one plane like a pump handle.
      arm.shoulder.rotation.z = arm.swing0 + groove * 0.12 * arm.side;
    }

    // head
    // Drift rather than snap
    const ease = Math.min(1, dt * 6);
    headYaw.rotation.y += (lookTarget.x - headYaw.rotation.y) * ease;
    headPitch.rotation.x +=
      (lookTarget.y + 0.06 - impulse * 0.16 - headPitch.rotation.x) * ease;

    // Brows: outer edges lift with the impact, and breathe when idle.
    for (const eye of eyes) {
      const idle = Math.sin(t * 1.6 + eye.side) * 0.02;
      eye.group.rotation.z = eye.side * (0.10 + impulse * 0.22) + idle;
    }

    // blink
    blinkCountdown -= dt;
    if (blinkCountdown <= 0 && blinking <= 0) {
      blinking = BLINK_DURATION;
      blinkCountdown = 2.4 + Math.random() * 3.6;
    }

    let openness = 1;
    if (blinking > 0) {
      blinking -= dt;
      // Half a cosine period over the blink: open, shut, open.
      const phase = Math.max(blinking, 0) / BLINK_DURATION;
      openness = Math.max(0.08, Math.abs(Math.cos(Math.PI * phase)));
    }

    for (const eye of eyes) eye.iris.scale.y = openness;

    // eye colour
    irisColour.lerp(irisTarget, Math.min(1, dt * 7));
    materials.iris.emissive.copy(irisColour);
    materials.iris.emissiveIntensity = 0.85 + flash * 2.2;
  }

  /** Point the head somewhere in its own local space, for the intro. */
  function look(x, y) {
    lookTarget.set(x, y);
  }

  return { root, update, materials, strike, look, arms };
}