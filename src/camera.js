/**
 * camera.js — authored camera shots and the transitions between them.
 *
 * This module owns the camera. That is the whole design, and everything below
 * follows from it.
 *
 * Before this phase, two things wrote to the camera: OrbitControls, every
 * frame, and nothing else. Adding tweened shots creates a second writer, and
 * two writers on one transform is the classic way an interactive camera turns
 * into a fight — the tween sets a position, the controls recompute from their
 * own damped state and overwrite it, and the result stutters or drifts
 * depending on the frame rate.
 *
 * So main.js no longer calls `controls.update()`. It calls `cameraRig.update()`
 * and this file decides which of the two is driving. There is exactly one
 * writer at any instant, and the handover is explicit.
 *
 *
 * WHY TRANSITIONS ARE SPHERICAL AND NOT LINEAR
 *
 * The obvious implementation tweens `camera.position` from A to B. It is
 * wrong, and measurably so. Two shots at the same distance from the target sit
 * on a sphere around it; a straight line between two points on a sphere is a
 * chord, and a chord passes *inside*.
 *
 * Measured on this scene's own shots: a linear move from the overview to the
 * opposite side, both at radius 1.20, dips to radius 0.51 at the midpoint —
 * 42% of where it started. The slab is 0.50 units to its half-width with the
 * wings out. The camera does not merely dive; it passes through the
 * instrument.
 *
 * Interpolating the spherical coordinates instead — radius, polar angle,
 * azimuth — keeps the camera on an arc around the target. Radius moves
 * monotonically between the two values and never dips below either, which is a
 * property of the parameterisation rather than something that has to be
 * checked. A camera move should be an orbit, so it is expressed as one.
 */

import * as THREE from 'three';
import { Tween, Easing } from '@tweenjs/tween.js';
import { tweens } from './tweens.js';
import { bus } from './events.js';

// ---------------------------------------------------------------------------
// Shots
//
// Stored as spherical coordinates about a target, not as positions, because
// that is the space the transitions run in — storing Cartesian positions would
// mean converting at the start of every move and losing the authored radius to
// floating-point round-tripping.
//
//   radius  distance from the target
//   phi     polar angle from +Y. 0 is directly overhead, PI/2 is the horizon.
//   theta   azimuth about Y, measured from +Z towards +X.
//
// Two limits every shot has to respect, both enforced by clamp() below rather
// than by trusting the numbers:
//
//   radius <= MAX_ORBIT   or the camera leaves the cyclorama and the room,
//                         drawn from the inside, disappears
//   phi    <= MAX_PHI     or the camera drops below the floor
// ---------------------------------------------------------------------------

/** Matches environment.js's MAX_ORBIT. Passed in rather than imported. */
let maxRadius = 2.75;

/** Matches controls.maxPolarAngle. Just under the horizon. */
const MAX_PHI = Math.PI * 0.495;
const MIN_PHI = 0.12;

export const SHOTS = [
  {
    name: 'Overview',
    description: 'The default framing. Reads the whole instrument and the room.',
    radius: 1.20,
    phi: 1.09,
    theta: 0.60,
    target: [0.02, 0.05, 0],
  },
  {
    name: 'Player',
    description: 'Low and square on, roughly where a player stands.',
    radius: 0.86,
    phi: 1.28,
    theta: 0.04,
    target: [0, 0.06, 0],
  },
  {
    name: 'Mechanism',
    // Nearly side-on, because that is the one angle where the fold is legible:
    // the wings rotate about an axis parallel to Z, so a viewer looking down
    // that axis sees the rotation edge-on and reads nothing. This shot is for
    // demonstrating the graded pillar, and it is worth having a button for it
    // rather than hoping to orbit there smoothly during a defence.
    description: 'Side-on and low, where the wing fold reads clearly.',
    radius: 1.02,
    phi: 1.36,
    theta: 1.45,
    target: [0, 0.09, 0],
  },
  {
    name: 'Room',
    // The plan called for three. This fourth costs four numbers and is the
    // only view that shows the speaker stacks, the beams and the cyclorama
    // together — which is to say, the only view that shows phases 5, 6 and 10
    // at all. It earns its place twice over now that the stacks are what
    // frames the instrument: the wide shot is the one that reads as a stage.
    description: 'Pulled back to the stacks and the cyc.',
    radius: 2.45,
    phi: 1.02,
    theta: 0.78,
    target: [0, 0.30, 0],
  },
];

export const SHOT_BY_NAME = new Map(SHOTS.map((s) => [s.name, s]));

// ---------------------------------------------------------------------------

/**
 * Wrap an angular difference into (-PI, PI].
 *
 * Without this, moving from theta = 0.04 to theta = 6.10 interpolates the long
 * way — nearly a full revolution the wrong direction — because the numbers say
 * to, even though the two angles are 0.22 radians apart. Angles are not
 * ordinary scalars and interpolating them as though they were is one of the
 * most common bugs in camera code.
 *
 * The double modulo is because JavaScript's `%` keeps the sign of the left
 * operand, so a negative input would come back out of range. The same defensive
 * shape as the modulo in `audio.quantizeToStep`, for the same reason.
 */
function shortestAngle(delta) {
  return ((((delta + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
}

function clampPhi(phi) {
  return Math.min(MAX_PHI, Math.max(MIN_PHI, phi));
}

/**
 * @param {{ camera: THREE.Camera, controls: any, maxOrbit?: number }} deps
 */
export function initCamera({ camera, controls, maxOrbit }) {
  if (maxOrbit) maxRadius = maxOrbit;

  /** The live state a transition writes into. */
  const state = {
    radius: 1.2,
    phi: 1.09,
    theta: 0.6,
    tx: 0,
    ty: 0.05,
    tz: 0,
  };

  /** @type {Tween[]} */
  let active = [];
  let transitioning = false;

  const offset = new THREE.Vector3();
  const spherical = new THREE.Spherical();

  /**
   * Read the camera's current position back into spherical state.
   *
   * Called at the start of every transition so a move begins from wherever the
   * user has orbited to, not from the last shot's nominal values. Without this
   * the camera would jump to the previous shot before starting to move, which
   * is the single most obvious way a preset camera looks broken.
   */
  function sync() {
    offset.copy(camera.position).sub(controls.target);
    spherical.setFromVector3(offset);
    state.radius = spherical.radius;
    state.phi = spherical.phi;
    state.theta = spherical.theta;
    state.tx = controls.target.x;
    state.ty = controls.target.y;
    state.tz = controls.target.z;
  }

  /** Write spherical state back onto the camera and the orbit target. */
  function apply() {
    controls.target.set(state.tx, state.ty, state.tz);
    offset.setFromSphericalCoords(
      Math.min(state.radius, maxRadius),
      clampPhi(state.phi),
      state.theta
    );
    camera.position.copy(controls.target).add(offset);
    camera.lookAt(controls.target);
  }

  function stopActive() {
    for (const tween of active) {
      tweens.remove(tween);
      tween.stop();
    }
    active = [];
  }

  /**
   * Move to a named shot.
   *
   * One tween over one object rather than six tweens over six scalars. The
   * mechanism in hierarchy.js splits its two joints deliberately, because
   * staggering them is the point; here the opposite is true — radius, angles
   * and target must arrive together or the move arcs and then snaps. A single
   * tween guarantees one easing curve across all six values.
   *
   * `Cubic.InOut`, and no overshoot. A camera that overshoots and settles reads
   * as a physical camera being handled, which is a specific and often desirable
   * effect — but here the shots sit close to the cyclorama and to the
   * horizon-limit on phi, and an overshoot would push through both. Same
   * reasoning as the wing fold: when the ends of the travel are hard limits,
   * the easing has to be monotonic.
   */
  function goTo(name, duration = 1100) {
    const shot = SHOT_BY_NAME.get(name);
    if (!shot) {
      console.error(`[camera] no shot named "${name}"`);
      return;
    }

    stopActive();
    sync();

    // Controls off for the duration. OrbitControls and the tween would
    // otherwise both write the camera in the same frame, and which one wins
    // depends on call order — a bug that appears only when the user happens to
    // be dragging as a shot button is pressed.
    controls.enabled = false;
    transitioning = true;

    const from = { ...state };
    const to = {
      radius: Math.min(shot.radius, maxRadius),
      // The absolute target angle is discarded in favour of the current angle
      // plus the shortest signed difference, so the move always takes the near
      // way round regardless of how many turns the user has orbited through.
      phi: clampPhi(from.phi + shortestAngle(shot.phi - from.phi)),
      theta: from.theta + shortestAngle(shot.theta - from.theta),
      tx: shot.target[0],
      ty: shot.target[1],
      tz: shot.target[2],
    };

    const tween = new Tween(from)
      .to(to, duration)
      .easing(Easing.Cubic.InOut)
      .onUpdate(() => Object.assign(state, from))
      .onComplete(() => {
        transitioning = false;
        controls.enabled = true;
        active = [];
        bus.emit('camera:arrived', { name });
      })
      .start();

    tweens.add(tween);
    active = [tween];
    bus.emit('camera:moving', { name });
  }

  /**
   * Hand back to the user.
   *
   * Called if anything wants to abort a move — a pointer down on the canvas,
   * say. Syncs first so the controls pick up exactly where the tween left the
   * camera rather than snapping back.
   */
  function release() {
    if (!transitioning) return;
    stopActive();
    sync();
    transitioning = false;
    controls.enabled = true;
  }

  /**
   * Once per frame, from main.js, in place of `controls.update()`.
   *
   * The branch is the whole ownership rule in two lines: while a shot is
   * running this module drives the camera and the controls are inert; the rest
   * of the time the controls drive and this module does nothing at all.
   */
  function update() {
    if (transitioning) apply();
    else controls.update();
  }

  // Put the camera on the first shot before the first frame is drawn, so the
  // authored framing is what loads rather than whatever main.js happened to
  // construct the camera with.
  Object.assign(state, {
    radius: SHOTS[0].radius,
    phi: SHOTS[0].phi,
    theta: SHOTS[0].theta,
    tx: SHOTS[0].target[0],
    ty: SHOTS[0].target[1],
    tz: SHOTS[0].target[2],
  });
  apply();

  return {
    update,
    goTo,
    release,
    sync,
    isTransitioning: () => transitioning,
    state,
    SHOTS,
  };
}