/**
 * mascot.js — Otto, the eight-armed drummer.
 *
 * An octopus because the joke writes itself for a drum machine: eight arms,
 * and he only ever uses two of them.
 *
 * Otto is not decoration bolted onto the scene. He is a second hierarchical
 * model with his own joint chain, and he is animated by the same mechanism the
 * pads are — the rig subscribes to 'pad:hit' and flashes an LED, and this file
 * subscribes to the identical event and swings an arm. Neither knows the other
 * exists, and neither knows whether the hit came from a mouse, a key or the
 * sequencer. That is the decoupling rule paying for itself a third time: a
 * whole character was added to the project without editing audio.js,
 * interaction.js or rig.js.
 *
 * The chain, per arm:
 *
 *   ring point -> azimuth -> curl -> segment -> joint -> segment -> joint ->
 *   segment -> tip -> stick
 *
 * The azimuth group exists purely so no Euler order has to be reasoned about.
 * Spinning a tentacle around the body and then bending it are two different
 * rotations about two different axes; composing them in one Euler triple means
 * depending on the order three.js multiplies them in, and getting that wrong
 * produces tentacles that bend sideways at the far side of the body. A group
 * per axis makes the composition explicit and the bug impossible.
 */

import * as THREE from 'three';
import { bus } from './events.js';
import { PALETTE } from './palette.js';
import { PAD_INDEX } from './pads.js';
import { toonRamp } from './textures.js';
import { roundedCylinderGeometry } from './geometry.js';

// ---------------------------------------------------------------------------
// Proportions
//
// Cartoon proportion is mostly one rule: make the head far too big. Otto's
// mantle is wider than his whole arm span is long, which is what reads as
// "character" rather than "animal".
// ---------------------------------------------------------------------------

const MANTLE = { rx: 0.125, ry: 0.135, rz: 0.1225, y: 0.205 };
const RING = { radius: 0.088, y: 0.108 };

const SEGMENTS = [
  { r: 0.030, ry: 0.036, mid: 0.032, end: 0.064 },
  { r: 0.023, ry: 0.029, mid: 0.026, end: 0.052 },
  { r: 0.016, ry: 0.020, mid: 0.019, end: 0.038 },
];

/**
 * Where each arm sits around the body, and how it rests.
 *
 * `curl` values are negative because a negative rotation about the azimuth
 * group's local X axis tilts the arm *outward*: the group's local Z points
 * radially away from the body, so -x rotation swings the downward-hanging arm
 * onto that radial direction.
 *
 * The two front arms rest past 90 degrees, which is what holds them up in the
 * air with the sticks ready. The other six splay just enough to carry him.
 */
const ARMS = [
  { azimuth: -0.40, curl: -1.90, joints: [-0.35, 0.40], stick: true },
  { azimuth: 0.40, curl: -1.90, joints: [-0.35, 0.40], stick: true },
  { azimuth: -1.15, curl: -0.60, joints: [-0.35, -0.45], stick: false },
  { azimuth: 1.15, curl: -0.60, joints: [-0.35, -0.45], stick: false },
  { azimuth: -1.95, curl: -0.55, joints: [-0.35, -0.45], stick: false },
  { azimuth: 1.95, curl: -0.55, joints: [-0.35, -0.45], stick: false },
  { azimuth: -2.75, curl: -0.50, joints: [-0.35, -0.45], stick: false },
  { azimuth: 2.75, curl: -0.50, joints: [-0.35, -0.45], stick: false },
];

// ---------------------------------------------------------------------------

/**
 * Build Otto.
 *
 * @param {{ scale?: number }} options
 */
export function buildMascot({ scale = 1.2 } = {}) {
  /**
   * One ramp texture shared by every material on the character.
   *
   * MeshToonMaterial rather than MeshStandardMaterial, and only here. The rig
   * is a manufactured object and gets physically based shading; Otto is a
   * drawn character and gets a banded ramp. Using two shading models in one
   * scene is a deliberate art-direction choice, not an inconsistency — it is
   * the same separation an animated film makes between its sets and its cast,
   * and it is what stops him reading as another moulded plastic part.
   *
   * It also means the toon ramp is a genuinely different kind of texture from
   * the colour, normal and roughness maps the rig uses: this one is sampled as
   * a transfer function on the lighting, not as a property of a surface.
   */
  const gradientMap = toonRamp();

  function toon(colour) {
    return new THREE.MeshToonMaterial({ color: colour, gradientMap });
  }

  const materials = {
    skin: toon(PALETTE.mascotSkin),
    shade: toon(PALETTE.mascotShade),
    belly: toon(PALETTE.mascotBelly),
    eye: toon(PALETTE.mascotEye),
    ink: toon(PALETTE.ink),
    stick: toon(PALETTE.stick),
  };

  // One unit sphere, scaled per use. Every soft form on the character is an
  // ellipsoid, so sixteen-odd geometries collapse into one buffer that stays
  // resident and is drawn with different matrices.
  const ball = new THREE.SphereGeometry(1, 24, 16);

  function blob(material, sx, sy, sz, x = 0, y = 0, z = 0) {
    const mesh = new THREE.Mesh(ball, material);
    mesh.scale.set(sx, sy, sz);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  // --- the nesting that everything else hangs from -------------------------

  const root = new THREE.Group();
  root.scale.setScalar(scale);

  const sway = new THREE.Group();       // slow idle lean
  root.add(sway);

  const bob = new THREE.Group();        // breathing, and the squash on a hit
  sway.add(bob);

  // --- body ----------------------------------------------------------------

  bob.add(blob(materials.skin, MANTLE.rx, MANTLE.ry, MANTLE.rz, 0, MANTLE.y, 0));

  // The flared hood where the mantle meets the arms. A darker tone here does
  // the work an ambient occlusion pass would: it reads as the shadow under an
  // overhang and stops the arms looking glued on.
  bob.add(blob(materials.shade, 0.145, 0.058, 0.145, 0, 0.128, 0));

  // Mouth: barely there. A large mouth fixes an expression permanently; a
  // small one lets the eyes carry it.
  bob.add(blob(materials.ink, 0.024, 0.010, 0.010, 0, 0.168, 0.112));

  // --- eyes ----------------------------------------------------------------

  const eyes = [];

  for (const side of [-1, 1]) {
    // The blink group scales in Y. Its children — the pupil and its highlight
    // — are inside it, so they squash with the lid instead of floating in
    // front of a closed eye, which is the usual giveaway of a faked blink.
    const eye = new THREE.Group();
    eye.position.set(side * 0.055, 0.235, 0.092);
    bob.add(eye);

    eye.add(blob(materials.eye, 0.040, 0.040, 0.032));

    const pupil = new THREE.Group();
    pupil.position.z = 0.024;
    eye.add(pupil);

    pupil.add(blob(materials.ink, 0.019, 0.019, 0.012));
    pupil.add(blob(materials.eye, 0.007, 0.007, 0.005, side * 0.007, 0.009, 0.010));

    eyes.push({ group: eye, pupil });
  }

  // --- arms ----------------------------------------------------------------

  const stickGeometry = roundedCylinderGeometry(0.0072, 0.115, 0.0072, 16, 3);

  const arms = ARMS.map((spec) => {
    const azimuth = new THREE.Group();
    azimuth.rotation.y = spec.azimuth;
    azimuth.position.set(
      Math.sin(spec.azimuth) * RING.radius,
      RING.y,
      Math.cos(spec.azimuth) * RING.radius
    );
    bob.add(azimuth);

    const curl = new THREE.Group();
    curl.rotation.x = spec.curl;
    azimuth.add(curl);

    // Walk down the chain, hanging a segment off each joint and creating the
    // next joint at the far end of it.
    let parent = curl;
    const joints = [];

    SEGMENTS.forEach((segment, i) => {
      parent.add(blob(
        materials.skin,
        segment.r, segment.ry, segment.r,
        0, -segment.mid, 0
      ));

      const next = new THREE.Group();
      next.position.y = -segment.end;
      if (i < SEGMENTS.length - 1) next.rotation.x = spec.joints[i];
      parent.add(next);

      joints.push(next);
      parent = next;
    });

    if (spec.stick) {
      const stick = new THREE.Mesh(stickGeometry, materials.stick);
      // The lathe builds upward from its own origin, so a half turn about X
      // points it down out of the tentacle tip; the extra tilt angles it the
      // way a held stick actually sits.
      stick.rotation.x = Math.PI * 0.86;
      stick.castShadow = true;
      parent.add(stick);
    }

    return {
      curl,
      elbow: joints[0],
      wrist: joints[1],
      rest: { curl: spec.curl, elbow: spec.joints[0], wrist: spec.joints[1] },
      phase: spec.azimuth * 1.7,
      holdsStick: spec.stick,
      strike: 0,
    };
  });

  const stickArms = arms.filter((arm) => arm.holdsStick);

  // -----------------------------------------------------------------------
  // Reacting to hits
  // -----------------------------------------------------------------------

  let nextArm = 0;
  const pupilTarget = new THREE.Vector2(0, 0);

  bus.on('pad:hit', ({ padId, velocity = 1 }) => {
    // Alternate hands. A drummer who strikes everything with the same arm
    // reads as a machine, which is the one thing a mascot must not read as.
    const arm = stickArms[nextArm % stickArms.length];
    nextArm += 1;
    if (arm) arm.strike = Math.max(arm.strike, velocity);

    // Glance at the pad that fired. The grid is four wide and Otto stands off
    // to one side, so this is a suggestion of attention rather than a real
    // look-at — which is all it needs to be at this size on screen.
    const index = PAD_INDEX.get(padId);
    if (index !== undefined) {
      pupilTarget.set(
        ((index % 4) - 1.5) * 0.0048,
        -(Math.floor(index / 4) - 1.5) * 0.0034
      );
    }
  });

  // -----------------------------------------------------------------------
  // Per-frame animation
  // -----------------------------------------------------------------------

  let blinkCountdown = 2.0;
  let blinking = 0;

  const BLINK_DURATION = 0.16;

  /**
   * @param {number} dt seconds since the last frame
   * @param {number} t  seconds since the page started
   */
  function update(dt, t) {
    // Strike envelopes, decayed exactly the way pad presses are. Same problem,
    // same answer: a tween per hit would have to be cancelled and restarted on
    // every retrigger, where multiplying by exp(-dt*k) retriggers for free.
    let impulse = 0;
    for (const arm of arms) {
      arm.strike *= Math.exp(-dt * 9);
      if (arm.strike < 0.001) arm.strike = 0;
      impulse = Math.max(impulse, arm.strike);
    }

    // --- body ------------------------------------------------------------
    sway.rotation.z = Math.sin(t * 0.9) * 0.035;
    bob.position.y = Math.sin(t * 2.1) * 0.010 - impulse * 0.022;

    // Squash and stretch, conserving rough volume: what is lost in height is
    // returned in width. Without the widening a squash just looks like the
    // character shrank.
    bob.scale.set(1 + impulse * 0.06, 1 - impulse * 0.09, 1 + impulse * 0.06);

    // --- arms ------------------------------------------------------------
    for (const arm of arms) {
      const wave = Math.sin(t * 1.7 + arm.phase);

      if (arm.holdsStick) {
        // strike = 1 at the instant of the hit, so the arm is at the bottom
        // of its swing exactly when the sound lands and rebounds afterwards.
        // Animating the approach instead would need the strike known in
        // advance, which for a live hit it never is.
        arm.curl.rotation.x = arm.rest.curl + arm.strike * 0.85 + wave * 0.04;
        arm.elbow.rotation.x = arm.rest.elbow + arm.strike * 0.55;
        arm.wrist.rotation.x = arm.rest.wrist - arm.strike * 0.30;
      } else {
        arm.curl.rotation.x = arm.rest.curl + wave * 0.10;
        arm.elbow.rotation.x = arm.rest.elbow + Math.sin(t * 1.7 + arm.phase + 0.7) * 0.14;
      }
    }

    // --- eyes ------------------------------------------------------------
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

    for (const eye of eyes) {
      eye.group.scale.y = openness;
      // Drift rather than snap. A pupil that teleports to a new target reads
      // as a glitch; one that takes a few frames reads as a glance.
      eye.pupil.position.x += (pupilTarget.x - eye.pupil.position.x) * Math.min(1, dt * 8);
      eye.pupil.position.y += (pupilTarget.y - eye.pupil.position.y) * Math.min(1, dt * 8);
    }
  }

  return { root, update, materials };
}
