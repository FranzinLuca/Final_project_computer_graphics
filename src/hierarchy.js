/**
 * hierarchy.js — the constraint solver and the fold sequence.
 *
 * Exactly one function in this project writes to a joint transform, and it is
 * `applyPose` below. Everything else moves a scalar and lets the constraint
 * propagate. Transforms are a pure function of state, recomputed every frame,
 * so they cannot drift out of sync with it.
 *
 * The state is TWO numbers: `{ phiL, phiR }`, the fold angle of each wing,
 * running 0 (open, coplanar with the bezel) to PI (shut, meeting at the seam).
 *
 * Two scalars rather than one is a deliberate choice and not a lazy one. A
 * single shared angle would fold both wings in perfect lockstep, which is what
 * a rigid object scaling does, not what a mechanism does — and it would make
 * the two wings meet edge-to-edge at the seam with no way to decide which lies
 * over which. Splitting them lets the sequence stagger the sides, so the slab
 * closes the way a book does.
 */

import { Tween, Easing } from '@tweenjs/tween.js';
import { tweens } from './tweens.js';
import { bus } from './events.js';
import { DIMS, WELL_FLOOR_Y } from './rig.js';

// ---------------------------------------------------------------------------
// Poses
// ---------------------------------------------------------------------------

const OPEN = { phiL: 0, phiR: 0 };
const SHUT = { phiL: Math.PI, phiR: Math.PI };

// ---------------------------------------------------------------------------
// The constraint
// ---------------------------------------------------------------------------

/**
 * The hinge-lift shaping function, s(phi) = sin^2(phi / 2).
 *
 * The problem it solves: a wing hinged on the bezel edge and rotated 180
 * degrees lands exactly where the pads are. The pads stand 12 mm proud, so the
 * hinge has to be 20 mm higher at the shut end than at the open end. But the
 * open end cannot be raised at all — the whole point of the redesign is that
 * the wings are coplanar with the grid, and coplanar means an offset of zero.
 * One fixed axis cannot satisfy both, so the axis translates as it rotates.
 *
 * Any function from 0 to 1 would clear the pads. This one is chosen because
 * `sin^2(phi/2)` is the same as `(1 - cos phi) / 2`, whose derivative is
 * `sin(phi) / 2` — zero at BOTH ends. That is the property that matters:
 *
 *   - At phi = 0 the lift leaves with zero slope, so the seam between wing and
 *     bezel does not visibly crack open the instant the fold begins. A linear
 *     ramp would lift fastest exactly when the wing is still flat and facing
 *     the camera, which is the one moment the gap is legible.
 *   - At phi = PI it arrives with zero slope, so the two wings settle onto the
 *     closed position instead of stopping dead against it.
 *
 * All the travel happens in the middle of the arc, where the wings are edge-on
 * and nobody can see it. This is not an easing curve — easing shapes motion in
 * time, and this is a function of configuration, not of time. It holds no
 * matter how the fold is driven, including if a slider drives it by hand.
 */
function hingeLift(phi) {
  const s = Math.sin(phi / 2);
  return s * s;
}

/**
 * Solve the two state scalars into every joint transform.
 *
 * The sign asymmetry between the wings is not arbitrary. Rotation about +Z
 * carries +X toward +Y. The left wing extends toward -X from its hinge, so a
 * NEGATIVE rotation lifts it; the right wing extends toward +X, so a positive
 * one does. Both then arrive at the centreline at phi = PI. Deriving the signs
 * from the geometry rather than discovering them by trial is what makes the
 * mirror hold if the dimensions change.
 */
function applyPose(joints, state) {
  const { wingLeftPivot, wingRightPivot, padGrid } = joints;

  wingLeftPivot.rotation.z = -state.phiL;
  wingRightPivot.rotation.z = +state.phiR;

  wingLeftPivot.position.y = DIMS.slabT + DIMS.hingeClear * hingeLift(state.phiL);
  wingRightPivot.position.y = DIMS.slabT + DIMS.hingeClear * hingeLift(state.phiR);

  /**
   * The pads dip a little as the wings come over them.
   *
   * Driven by whichever wing is FURTHER along, because the clearance has to be
   * there by the time the first arrival gets to it, not the second. `max` is
   * the correct operator here and `min` would be a bug that only shows up
   * during the stagger — which is exactly the window where the two scalars
   * differ, so it would never appear in a static screenshot.
   *
   * The same s(phi) as the hinge lift, reused rather than reinvented: the
   * zero-slope-at-both-ends argument applies identically, and two derived
   * quantities sharing one shaping function is one fewer thing to defend.
   */
  const lead = Math.max(state.phiL, state.phiR);
  padGrid.position.y = WELL_FLOOR_Y - DIMS.padTravel * 0.5 * hingeLift(lead);
}

// ---------------------------------------------------------------------------
// The fold sequence
// ---------------------------------------------------------------------------

/**
 * Staggering the two wings is what turns a symmetric collapse into a fold.
 *
 * The right wing leads by 260 ms in both directions, so the left always lies
 * ON TOP of the right when shut and always lifts off it first when opening.
 * That is a real mechanical fact about a tri-fold, not decoration: two panels
 * meeting at a seam have to have an order, and picking one and being
 * consistent about it is the difference between a fold and a clash.
 *
 * NO OVERSHOOT ANYWHERE, and this is the interesting difference from the
 * scissor lift the old case used. There, `Back.Out` overshooting past the
 * target was checked against the monotonic region of `sin` and found safe —
 * the worst case was a visible stutter. Here both ends of the travel are hard
 * mechanical stops: below phi = 0 the wing drives into the slab body, above
 * phi = PI the two wings drive into each other at the seam. An overshoot is
 * not a cosmetic risk, it is interpenetration. So the easings are all
 * strictly monotonic, and the settle at the ends comes from the constraint's
 * own zero slope instead.
 */
const SEQUENCE = {
  open: [
    { joint: 'phiR', delay: 0,   duration: 820, easing: Easing.Cubic.Out },
    { joint: 'phiL', delay: 260, duration: 820, easing: Easing.Cubic.Out },
  ],

  // Closing reverses the order — left stows first, so it ends up underneath —
  // and uses an In curve, because a panel being swung shut accelerates into
  // its stop rather than easing off it.
  shut: [
    { joint: 'phiL', delay: 0,   duration: 700, easing: Easing.Cubic.In },
    { joint: 'phiR', delay: 260, duration: 700, easing: Easing.Cubic.In },
  ],
};

// ---------------------------------------------------------------------------

/**
 * @param {{ rig: { joints: object } }} deps
 */
export function initHierarchy({ rig }) {
  /** The entire configuration of the mechanism: two numbers. */
  const state = { ...SHUT };

  /** @type {Tween[]} tweens in flight, so a mid-motion reverse can cancel them. */
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
   * Each tween starts from the joint's CURRENT value, not from the nominal
   * pose. Pressing the toggle halfway through a fold reverses each wing from
   * wherever it happens to be, with no jump — and because the two wings are
   * staggered, they will be at different angles at that moment, which is
   * precisely the case a shared scalar could not represent.
   */
  function run(name) {
    stopActive();

    const target = name === 'open' ? OPEN : SHUT;

    for (const step of SEQUENCE[name]) {
      const from = { v: state[step.joint] };
      const tween = new Tween(from)
        .to({ v: target[step.joint] }, step.duration)
        .delay(step.delay)
        .easing(step.easing)
        .onUpdate(() => { state[step.joint] = from.v; })
        .start();

      tweens.add(tween);
      active.push(tween);
    }

    open = name === 'open';
    bus.emit('rig:fold', { open });
  }

  /** Called once per frame by main.js, after tweens.update(). */
  function update() {
    applyPose(rig.joints, state);
  }

  // Pose the skeleton before the first frame is drawn, so nothing is ever
  // rendered at its identity transform.
  update();

  return {
    update,
    open: () => run('open'),
    shut: () => run('shut'),
    toggle: () => run(open ? 'shut' : 'open'),
    isOpen: () => open,
    state,
  };
}