/**
  camera.js — camera shots and the transitions between them.
  
  The need for a camera module is concurrency. if i want to move 
  between shots i have to move the camera in that coordinates, but if i
  have two systems that move the camera (the one that load the shots and
  orbitcontrol from three) the wins the last one to fire. 
  This module manage that interaction
*/

import * as THREE from 'three';
import { Tween, Easing } from '@tweenjs/tween.js';
import { tweens } from './tweens.js';
import { bus } from './events.js';

// -----
// Shots
// -----

/** 
  The shots are stored as spherical coord w.r.t. a target so that it does not
  lose the reference point:
  - radius  distance from the target
  - phi     polar angle from +Y. 0 is directly overhead, PI/2 is the horizon
  - theta   azimuth about Y, measured from +Z towards +X

  two limits:
  - radius <= MAX_ORBIT   or the camera backs out into the fog
  - phi    <= MAX_PHI     or the camera drops below the floor
*/

let maxRadius = 5.00; // match max_orbit

/** Matches controls.maxPolarAngle. Just under the horizon. */
const MAX_PHI = Math.PI * 0.495;
const MIN_PHI = 0.12;

/**
  Shot lists
*/
export const SHOTS = [
  {
    name: 'Overview',
    description: 'The default. The instrument, both stacks and Rob8 in one frame.',
    radius: 2.90,
    phi: 1.10,
    theta: 0.72,
    target: [0.02, 0.38, 0],
  },
  {
    name: 'Overview #2',
    description: 'Low and near-frontal, where the wing fold reads.',
    radius: 1.90,
    phi: 1.36,
    theta: 0.30,
    target: [0, 0.25, 0],
  },
  {
    name: 'Player',
    description: 'Square on and close, where a player stands. The pad grid fills the frame.',
    radius: 1.80,
    phi: 1.18,
    theta: 0.00,
    target: [0, 0.18, 0],
  },
  {
    name: 'Rob8',
    description: 'Close on the mascot, for his own joint chain.',
    radius: 1.10,
    phi: 1.25,
    theta: -0.28,
    target: [1.02, 0.20, 0.20],
  },
  {
    name: 'Stage',
    description: 'Wide. Both stacks, the console, the mascot and the room.',
    radius: 3.44,
    phi: 1.15,
    theta: 0.52,
    target: [0.25, 0.34, 0.05],
  },
  {
    name: 'Beams',
    description: 'Low and back, looking up into the shafts where they cross.',
    radius: 2.60,
    phi: 1.42,
    theta: 0.10,
    target: [0, 1.00, 0],
  },
];

export const SHOT_BY_NAME = new Map(SHOTS.map((s) => [s.name, s]));

// ---------------------------------------------------------------------------

/**
  Wrap an angular difference into (-PI, PI].
  
  Choose the shortest path

  The double modulo is because JavaScript's `%` keeps the sign of the left
  operand, so a negative input would come back out of range. The same defensive
  shape as the modulo in `audio.quantizeToStep`, for the same reason.
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
    Read the camera's current position back into spherical state.
    Called at the start of every transition so a move begins from wherever the
    user has orbited to, not from the last shot's nominal values. Without this
    the camera would jump to the previous shot before starting to move, which
    is the single most obvious way a preset camera looks broken.
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

  // guard for concurrency
  function stopActive() {
    for (const tween of active) {
      tweens.remove(tween);
      tween.stop();
    }
    active = [];
  }

  /**
    Move to a named shot.
  */
  function goTo(name, duration = 1100) {
    const shot = SHOT_BY_NAME.get(name);
    if (!shot) {
      console.error(`[camera] no shot named "${name}"`);
      return;
    }
    moveTo(shot, duration, name);
  }

  /**
    Move to an arbitrary spherical framing.
    @param {{radius: number, phi: number, theta: number, target: number[]}} shot
  */
  function moveTo(shot, duration = 1100, name = 'custom') {
    stopFollowing();
    stopActive();
    sync();

    // Controls off for the duration. OrbitControls and the tween would
    // otherwise both write the camera in the same frame
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
    Hand back to the user.
  */
  function release() {
    stopFollowing();
    if (!transitioning) return;
    stopActive();
    sync();
    transitioning = false;
    controls.enabled = true;
  }

  // -------------------------
  // Following a moving object
  // -------------------------

  /**
    Follow and object for intro.
    keep the orbit parameters fixed and move te target

    if i use tween like before i have to time perfectly every camera movement
  */

  /** @type {null | {object: THREE.Object3D, ty: number, ease: number}} */
  let following = null;
  const followPoint = new THREE.Vector3();

  /**
   * Orbit a moving object at a fixed framing.
   *
   * The target is LERPED towards the object rather than snapped to it, and the
   * rate is deliberately slow. A camera pinned exactly to a moving subject
   * transfers every bump in the subject's motion into the frame, so the world
   * appears to shake while the subject sits still — the classic mistake in a
   * follow cam. Trailing slightly means the subject drifts a little within the
   * frame, which is what a real operator's panning does and what makes the
   * motion read as observed rather than as welded on.
   *
   * @param {THREE.Object3D} object
   * @param {{radius: number, phi: number, theta: number, ty?: number, ease?: number}} spec
   */
  function followObject(object, spec) {
    stopActive();
    controls.enabled = false;
    transitioning = false;

    state.radius = Math.min(spec.radius, maxRadius);
    state.phi = clampPhi(spec.phi);
    state.theta = spec.theta;

    object.getWorldPosition(followPoint);
    state.tx = followPoint.x;
    state.ty = followPoint.y + (spec.ty ?? 0.16);
    state.tz = followPoint.z;

    following = { object, ty: spec.ty ?? 0.16, ease: spec.ease ?? 3.2 };
    apply();
  }

  function stopFollowing() {
    if (!following) return;
    following = null;
    controls.enabled = true;
    sync();
  }

  /**
    Once per frame, from main.js, in place of `controls.update()`.
    this is the state machine that help solve the concurrecny problem

    manage the main camera controllers
  */
  function update(dt = 0.016) {
    if (following) {
      following.object.getWorldPosition(followPoint);
      // Framerate-independent approach, the same form the lighting envelopes
      // use. A bare lerp factor would make the camera trail further behind on
      // a slow machine than on a fast one.
      const k = 1 - Math.exp(-dt * following.ease);
      state.tx += (followPoint.x - state.tx) * k;
      state.ty += (followPoint.y + following.ty - state.ty) * k;
      state.tz += (followPoint.z - state.tz) * k;
      apply();
      return;
    }

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
    moveTo,
    followObject,
    stopFollowing,
    release,
    sync,
    isTransitioning: () => transitioning,
    state,
    SHOTS,
  };
}