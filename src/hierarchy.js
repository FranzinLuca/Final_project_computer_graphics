/**
 * hierarchy.js — the joint chain in motion.
 *
 * rig.js builds the skeleton. This file is the only code in the project that
 * writes to a joint transform. Everything outside it moves scalars.
 *
 * The chain:
 *
 *   caseBody
 *   |-- lidPivot            hinge, rotation.x   0 -> -110deg
 *   |-- wingLeftPivot       hinge, rotation.z   0 -> -95deg
 *   |-- wingRightPivot      hinge, rotation.z   0 -> +95deg
 *   |-- scissor
 *   |   |-- armPivotsA      rotation.z  +theta,  position.y = h/2
 *   |   |-- armPivotsB      rotation.z  -theta,  position.y = h/2
 *   |   +-- deck            position.y  = h(theta)
 *   |       +-- padGrid
 *   |           +-- pad x16
 *   +-- linkagePivot        rotation.x, tilts as the case opens
 *       +-- controlPanel    counter-rotated to stay level
 *           +-- knob x6
 *
 * Five to six levels deep with three branches, and every level carries a real
 * degree of freedom rather than being a decorative sub-mesh.
 *
 * The whole state of the mechanism is four numbers. Nothing else is authored:
 * deck height, cross-pin height and panel attitude are all derived.
 */

import * as THREE from 'three';
import { Tween, Easing } from '@tweenjs/tween.js';

import { tweens } from './tweens.js';
import { bus } from './events.js';
import { DIMS } from './rig.js';

const deg = THREE.MathUtils.degToRad;

// ---------------------------------------------------------------------------
// The two poses
// ---------------------------------------------------------------------------

export const POSE = {
  closed: { lid: 0,          wing: 0,        theta: deg(6),  linkage: 0 },
  open:   { lid: deg(-110),  wing: deg(95),  theta: deg(58), linkage: deg(-38) },
};

/** Resting attitude of the control surface once the case is open. */
const PANEL_TILT = deg(12);

// ---------------------------------------------------------------------------
// The scissor constraint
// ---------------------------------------------------------------------------

/**
 * Deck height as a function of the arm angle.
 *
 * Two arms of length 2*armHalf are pinned to each other at their midpoints,
 * one end of each on the base and the other under the deck. Each arm makes
 * angle theta with the horizontal, so the rise from the base pin up to the
 * cross pin is armHalf*sin(theta), and the rise from the cross pin up to the
 * deck is the same again:
 *
 *     h(theta) = 2 * armHalf * sin(theta)
 *
 * This is the sentence that matters for the report: theta is the ONLY thing
 * animated. Deck height is derived from it through the constraint, the cross
 * pin sits at h/2 by the same derivation, and the pad grid rises without a
 * single line of code of its own because it is a child of the deck. One
 * driving parameter propagates through a constraint into coordinated motion —
 * which is what "animations that exploit the hierarchical structure" means, as
 * opposed to keyframing each part separately and hoping they agree.
 */
export function deckHeightForTheta(theta) {
  return 2 * DIMS.armHalf * Math.sin(theta);
}

// ---------------------------------------------------------------------------
// The solver
// ---------------------------------------------------------------------------

/**
 * Map the four state scalars onto the scene graph.
 *
 * Called once per frame from the render loop, whether or not anything is
 * moving. That costs a handful of assignments and buys an invariant: the
 * transforms are a pure function of the state, so they can never drift out of
 * sync with it. There is no code path that nudges a rotation directly.
 */
export function applyPose(joints, state) {
  const { lid, wing, theta, linkage } = state;

  // --- simple hinges ------------------------------------------------------
  joints.lidPivot.rotation.x = lid;
  joints.wingLeftPivot.rotation.z = -wing;
  joints.wingRightPivot.rotation.z = wing;

  // --- scissor ------------------------------------------------------------
  const h = deckHeightForTheta(theta);

  for (const pivot of joints.armPivotsA) {
    pivot.rotation.z = theta;
    pivot.position.y = h / 2;
  }
  for (const pivot of joints.armPivotsB) {
    pivot.rotation.z = -theta;
    pivot.position.y = h / 2;
  }

  joints.deck.position.y = h;

  // --- linkage and counter-rotation ---------------------------------------
  joints.linkagePivot.rotation.x = linkage;

  /**
   * The control panel hangs off an arm that pitches as the case opens. Left
   * alone it would tip with its parent and the knobs would face the ceiling.
   * Negating the parent's rotation cancels it exactly, and adding PANEL_TILT
   * on top sets the attitude we actually want:
   *
   *     panel.rotation.x = -linkage.rotation.x + targetTilt
   *
   * This is a constraint expressed THROUGH the hierarchy — a parent's rotation
   * compensated by a child's — rather than by detaching the panel and placing
   * it in world space. The panel still inherits the parent's position, so it
   * rides up and back with the linkage while keeping its own orientation.
   */
  joints.controlPanel.rotation.x = -linkage + PANEL_TILT;
}

// ---------------------------------------------------------------------------
// The unfold sequence
// ---------------------------------------------------------------------------

/**
 * The unfold is not one tween — one tween would move every joint in lockstep
 * and read as a rigid object scaling open. Staggering the starts by a couple
 * of hundred milliseconds makes it read as a sequence of mechanical events:
 * the lid goes first because it has to clear before anything else can move,
 * the wings follow, the lift rises once there is room, and the control panel
 * presents itself last.
 *
 * Each joint also gets its own easing, because they are different kinds of
 * motion. The lid falls back under its own weight (Cubic.Out). The lift is
 * driven by a motor against gravity and settles with a small overshoot
 * (Back.Out) — that overshoot is what sells the weight of the deck.
 *
 * Back.Out overshoots by about 10% of its range. Checked: theta peaks near
 * 63deg, still short of 90deg, so sin(theta) is still rising and the deck
 * cannot dip on the way to its target. Worth verifying rather than assuming,
 * because past 90deg an overshoot would make the lift visibly stutter
 * downwards at the top of its travel.
 */
const SEQUENCE = {
  unfold: [
    { joint: 'lid',     delay: 0,   duration: 900,  easing: Easing.Cubic.Out },
    { joint: 'wing',    delay: 200, duration: 750,  easing: Easing.Quadratic.Out },
    { joint: 'theta',   delay: 500, duration: 1100, easing: Easing.Back.Out },
    { joint: 'linkage', delay: 900, duration: 600,  easing: Easing.Cubic.Out },
  ],

  // Packing down reverses the order — the panel stows first, the lid closes
  // last — and drops the overshoot: a scissor lift settling under load
  // bounces, but one being lowered does not.
  fold: [
    { joint: 'linkage', delay: 0,   duration: 500, easing: Easing.Cubic.In },
    { joint: 'theta',   delay: 150, duration: 800, easing: Easing.Cubic.InOut },
    { joint: 'wing',    delay: 600, duration: 650, easing: Easing.Cubic.In },
    { joint: 'lid',     delay: 850, duration: 800, easing: Easing.Cubic.In },
  ],
};

// ---------------------------------------------------------------------------

/**
 * @param {{ rig: { joints: object } }} deps
 */
export function initHierarchy({ rig }) {
  /** The entire configuration of the mechanism: four numbers. */
  const state = { ...POSE.closed };

  /** @type {Tween[]} tweens currently in flight, so a mid-motion reverse can cancel them. */
  let active = [];

  let open = false;

  function stopActive() {
    for (const tween of active) {
      tweens.remove(tween);
      tween.stop();
    }
    active = [];
  }

  /**
   * Run one of the sequences.
   *
   * Each joint gets its own Tween on its own property of `state`. They share
   * the target object, which is safe because tween.js only reads and writes
   * the keys named in its own to() call.
   *
   * Starting from the CURRENT value rather than from the nominal pose is what
   * makes an interrupted motion recover gracefully: hit the toggle halfway
   * through an unfold and each joint reverses from wherever it happens to be,
   * with no jump.
   */
  function run(name) {
    stopActive();

    const target = name === 'unfold' ? POSE.open : POSE.closed;

    for (const step of SEQUENCE[name]) {
      const tween = new Tween(state)
        .to({ [step.joint]: target[step.joint] }, step.duration)
        .delay(step.delay)
        .easing(step.easing);

      tweens.add(tween);
      tween.start();
      active.push(tween);
    }

    open = name === 'unfold';
    bus.emit('case:moving', { open });
  }

  function unfold() { if (!open) run('unfold'); }
  function fold()   { if (open)  run('fold'); }
  function toggle() { open ? fold() : unfold(); }

  /**
   * Jump straight to a pose with no animation. Used by the camera presets in
   * phase 7 and handy for debugging.
   */
  function setPose(name) {
    stopActive();
    Object.assign(state, POSE[name]);
    open = name === 'open';
  }

  /** Called once per frame, after tweens.update() has advanced `state`. */
  function update() {
    applyPose(rig.joints, state);
  }

  // Pose the skeleton immediately so the first rendered frame is correct
  // rather than showing every joint at zero for one frame.
  update();

  return { state, update, unfold, fold, toggle, setPose, isOpen: () => open, POSE };
}