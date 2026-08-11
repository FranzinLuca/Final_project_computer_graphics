/**
 * interaction.js — turning input into intent.
 *
 * This module raycasts, reads the keyboard and tracks drags. It does not know
 * that an audio engine or a folding case exists. Everything it detects is
 * published on the bus as intent:
 *
 *   'pad:trigger'      { padId, velocity }
 *   'knob:change'      { index, label, value }
 *   'transport:toggle' {}
 *   'case:toggle'      {}
 *
 * main.js decides what those mean. The payoff is that phase 7's presets and
 * the lil-gui panel can drive the instrument through the same events, and that
 * this file can be reasoned about without opening audio.js.
 *
 * Note what does NOT happen here: nothing lights up a pad. A click emits
 * 'pad:trigger', main.js calls audio.trigger(), audio emits 'pad:hit', and
 * rig.js flashes the LED. The sequencer emits the same 'pad:hit'. One code
 * path serves both.
 */

import * as THREE from 'three';
import { bus } from './events.js';
import { PADS } from './pads.js';

// ---------------------------------------------------------------------------
// Keyboard map
//
// Keyed on event.code, not event.key. `code` is the physical key position, so
// the 4x4 block stays a 4x4 block on AZERTY and QWERTZ keyboards, where
// event.key would scatter it. It also means the map is unaffected by whether
// Shift is held.
// ---------------------------------------------------------------------------

const KEY_ORDER = [
  'Digit1', 'Digit2', 'Digit3', 'Digit4',
  'KeyQ',   'KeyW',   'KeyE',   'KeyR',
  'KeyA',   'KeyS',   'KeyD',   'KeyF',
  'KeyZ',   'KeyX',   'KeyC',   'KeyV',
];

/** code -> padId */
export const KEY_MAP = new Map(
  KEY_ORDER.map((code, i) => [code, PADS[i].id])
);

/** padId -> human-readable key label, for the user manual and the GUI. */
export const KEY_LABELS = new Map(
  KEY_ORDER.map((code, i) => [PADS[i].id, code.replace(/^(Digit|Key)/, '')])
);

/** Non-pad keys. Kept separate so the manual can list them as one table. */
export const COMMAND_KEYS = [
  { code: 'Space', label: 'Space', description: 'Start / stop the sequencer' },
  { code: 'KeyO',  label: 'O',     description: 'Unfold / fold the case' },
];

// ---------------------------------------------------------------------------
// Knob feel
// ---------------------------------------------------------------------------

/** Pixels of vertical travel for the full 0..1 range. */
const DRAG_RANGE_PX = 220;

/** Hold Shift to divide the sensitivity by this, for fine adjustment. */
const FINE_FACTOR = 5;

/** Total rotation of a knob across its range: 270 degrees, as on real gear. */
const KNOB_SWEEP = THREE.MathUtils.degToRad(270);

// ---------------------------------------------------------------------------

/**
 * @param {{ canvas: HTMLCanvasElement, camera: THREE.Camera,
 *           controls: { enabled: boolean }, rig: any }} deps
 */
export function initInteraction({ canvas, camera, controls, rig }) {
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  // --- pickable sets, built once ------------------------------------------
  // Flat arrays of meshes rather than recursive traversal at pick time: the
  // scene graph is walked once here instead of on every pointer move.

  const pickable = [];
  const meshToPad = new Map();
  const meshToKnob = new Map();

  for (const pad of rig.pads) {
    for (const mesh of [pad.cap, pad.led]) {
      pickable.push(mesh);
      meshToPad.set(mesh.id, pad);
    }
  }

  rig.knobs.forEach((knob, index) => {
    knob.group.traverse((object) => {
      if (object.isMesh) {
        pickable.push(object);
        meshToKnob.set(object.id, { knob, index });
      }
    });
  });

  // -----------------------------------------------------------------------
  // Picking
  // -----------------------------------------------------------------------

  /**
   * Convert a pointer position into normalised device coordinates.
   *
   * NDC runs -1..1 across the viewport with +Y upward, while DOM coordinates
   * run 0..width from the top-left with +Y downward — hence the flip on the
   * second line. getBoundingClientRect() rather than canvas.width, because the
   * drawing buffer is devicePixelRatio times larger than the CSS box.
   */
  function updatePointer(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  /**
   * Nearest pickable under the pointer, or null.
   *
   * Note this works unchanged while the case is unfolding: the raycaster tests
   * against world matrices, which the renderer refreshes every frame, so a pad
   * riding up on the scissor lift is hit exactly where it is drawn.
   */
  function pick(event) {
    updatePointer(event);
    raycaster.setFromCamera(pointer, camera);

    // `false` = don't recurse; `pickable` already holds leaf meshes.
    const hits = raycaster.intersectObjects(pickable, false);
    if (hits.length === 0) return null;

    const mesh = hits[0].object;
    const pad = meshToPad.get(mesh.id);
    if (pad) return { type: 'pad', pad };

    const knob = meshToKnob.get(mesh.id);
    if (knob) return { type: 'knob', ...knob };

    return null;
  }

  // -----------------------------------------------------------------------
  // Knob values
  // -----------------------------------------------------------------------

  /**
   * Set a knob's value and its visible rotation.
   *
   * Centre of travel points the indicator straight ahead; increasing the value
   * turns it clockwise seen from above. The negative sign is because a
   * positive rotation about +Y carries the indicator anticlockwise.
   */
  function setKnob(index, value, notify = true) {
    const knob = rig.knobs[index];
    if (!knob) return;

    knob.value = THREE.MathUtils.clamp(value, 0, 1);
    knob.group.rotation.y = -(knob.value - 0.5) * KNOB_SWEEP;

    if (notify) {
      bus.emit('knob:change', { index, label: knob.label, value: knob.value });
    }
  }

  // -----------------------------------------------------------------------
  // Pointer handling
  // -----------------------------------------------------------------------

  /** @type {null | { index: number, startY: number, startValue: number, pointerId: number }} */
  let drag = null;

  function onPointerDown(event) {
    if (event.button !== 0) return; // left button only; right stays for orbit

    const hit = pick(event);
    if (!hit) return;

    // Suppress the camera for this gesture. OrbitControls checks `enabled` at
    // the top of its own move handler, so clearing it here stops the orbit
    // even though its pointerdown has already run.
    controls.enabled = false;

    if (hit.type === 'pad') {
      bus.emit('pad:trigger', { padId: hit.pad.id, velocity: velocityFor(event) });
      return;
    }

    drag = {
      index: hit.index,
      startY: event.clientY,
      startValue: hit.knob.value,
      pointerId: event.pointerId,
    };

    // Capture keeps the drag alive if the pointer leaves the canvas, which it
    // will — a 220px vertical drag from a knob near the edge goes off-screen.
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (drag) {
      const range = DRAG_RANGE_PX * (event.shiftKey ? FINE_FACTOR : 1);
      // Up is positive: dragging up increases the value, as on every mixer.
      const delta = (drag.startY - event.clientY) / range;
      setKnob(drag.index, drag.startValue + delta);
      return;
    }

    // Hover feedback. One raycast per move against ~40 meshes is cheap, and it
    // is the only cue that the pads and knobs are interactive at all.
    const hit = pick(event);
    canvas.style.cursor = !hit ? '' : hit.type === 'knob' ? 'ns-resize' : 'pointer';
  }

  function onPointerUp(event) {
    if (drag && drag.pointerId === event.pointerId) {
      canvas.releasePointerCapture(event.pointerId);
      drag = null;
    }
    controls.enabled = true;
  }

  /**
   * Pen and touch report real pressure; a mouse always reports 0.5 when held,
   * which carries no information, so mouse hits are full velocity.
   */
  function velocityFor(event) {
    if (event.pointerType === 'mouse') return 1.0;
    return THREE.MathUtils.clamp(0.35 + event.pressure * 0.65, 0.35, 1.0);
  }

  // -----------------------------------------------------------------------
  // Keyboard
  // -----------------------------------------------------------------------

  function onKeyDown(event) {
    // Don't steal keys from a focused text field — lil-gui arrives in phase 7.
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    // Leave browser shortcuts alone.
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    // Auto-repeat would machine-gun a held pad at the OS repeat rate.
    if (event.repeat) return;

    const padId = KEY_MAP.get(event.code);
    if (padId) {
      bus.emit('pad:trigger', { padId, velocity: 1.0 });
      event.preventDefault();
      return;
    }

    if (event.code === 'Space') {
      bus.emit('transport:toggle', {});
      event.preventDefault(); // Space would otherwise scroll the page
      return;
    }

    if (event.code === 'KeyO') {
      bus.emit('case:toggle', {});
      event.preventDefault();
    }
  }

  // -----------------------------------------------------------------------

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('keydown', onKeyDown);

  function dispose() {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    window.removeEventListener('keydown', onKeyDown);
  }

  return { setKnob, dispose, KEY_MAP, KEY_LABELS, COMMAND_KEYS };
}