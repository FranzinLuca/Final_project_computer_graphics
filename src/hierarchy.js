/**
  hierarchy.js

  This file is mainly a constraint solver
*/

import { Tween, Easing } from '@tweenjs/tween.js';
import { tweens } from './tweens.js';
import { bus } from './events.js';
import { DIMS, WELL_FLOOR_Y } from './rig.js';

// -----
// Poses
// -----

/**
  The two poses the lid can have
*/

const OPEN = { phiL: 0, phiR: 0 };
const SHUT = { phiL: Math.PI, phiR: Math.PI };

// --------------
// The constraint
// --------------

/**
  The hinge-lift shaping function, s(phi) = sin^2(phi / 2).
*/
function hingeLift(phi) {
  const s = Math.sin(phi / 2);
  return s * s;
}

function applyPose(joints, state) {
  const { wingLeftPivot, wingRightPivot, padGrid } = joints;

  wingLeftPivot.rotation.z = -state.phiL;
  wingRightPivot.rotation.z = +state.phiR;

  wingLeftPivot.position.y = DIMS.slabT + DIMS.hingeClear * hingeLift(state.phiL);
  wingRightPivot.position.y = DIMS.slabT + DIMS.hingeClear * hingeLift(state.phiR);

  const lead = Math.max(state.phiL, state.phiR);
  padGrid.position.y = WELL_FLOOR_Y - DIMS.padTravel * 0.5 * hingeLift(lead);
}

// -----------------
// The fold sequence
// -----------------

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
    Run one of the sequences.
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