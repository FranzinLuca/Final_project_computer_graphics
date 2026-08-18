/**
 * interaction.js — turning input into intent.
 *
 * This module raycasts, reads the keyboard and tracks drags. It does not know
 * that an audio engine or a folding case exists. Everything it detects is
 * published on the bus as intent:
 *
 *   'pad:trigger'      { padId, velocity }
 *   'knob:change'      { index, label, value }
 *   'button:press'     { id }
 *   'hover'            { label, detail } | null
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
  { code: 'KeyO',  label: 'O',     description: 'Unfold / fold the slab' },
  { code: 'KeyV',  label: 'V',     description: 'Cycle the camera shots' },
];

// ---------------------------------------------------------------------------
// Knob feel
// ---------------------------------------------------------------------------

/** Pixels of vertical travel for the full 0..1 range. */
const DRAG_RANGE_PX = 220;

/** Hold Shift to divide the sensitivity by this, for fine adjustment. */
const FINE_FACTOR = 5;

// ---------------------------------------------------------------------------

/**
 * @param {{ canvas: HTMLCanvasElement, camera: THREE.Camera,
 *           controls: { enabled: boolean }, rig: any }} deps
 */
export function initInteraction({ canvas, camera, controls, rig }) {
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  /**
   * What the instrument will currently accept.
   *
   *   'open'    everything: pads, knobs, buttons, keyboard
   *   'closed'  nothing but a click anywhere on the slab, which opens it
   *   'locked'  nothing at all, for the power-on sequence
   *
   * A mode rather than a boolean, because "disabled" is not one state here.
   * A shut slab is not an instrument that has stopped working — it is an
   * object with exactly one affordance, and the difference between an
   * unresponsive control surface and a lid you can open matters entirely.
   *
   * The gate lives here rather than in main.js because it is a question about
   * INPUT: which gestures are meaningful right now. main.js still decides what
   * each gesture means; this decides which ones exist.
   */
  let mode = 'open';

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

  /**
   * The four soft buttons on the front band.
   *
   * Only the cap is pickable, not the printed label next to it — a legend is
   * not a control, and making it clickable would mean the hit area is a
   * different shape from the thing that looks pressable.
   */
  const meshToButton = new Map();

  for (const button of rig.buttons ?? []) {
    pickable.push(button.cap);
    meshToButton.set(button.cap.id, button);
  }

  /**
   * Every mesh in the instrument, for the shut state.
   *
   * When the slab is closed the pads are underneath two wings and the knobs
   * are face-down, so the controls are not merely disabled — they are not
   * there. What IS there is a closed box, and the whole box has to be
   * clickable, including the wing undersides that are now the exterior.
   *
   * Collected once by traversing the rig, the same way the pickable set is
   * built: the graph is walked at init rather than recursed on every pointer
   * move.
   */
  const slabMeshes = [];
  rig.root.traverse((object) => {
    if (object.isMesh) slabMeshes.push(object);
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

    // Shut: one target, the whole object.
    if (mode === 'closed') {
      const closedHits = raycaster.intersectObjects(slabMeshes, false);
      return closedHits.length ? { type: 'slab' } : null;
    }

    // `false` = don't recurse; `pickable` already holds leaf meshes.
    const hits = raycaster.intersectObjects(pickable, false);
    if (hits.length === 0) return null;

    const mesh = hits[0].object;
    const pad = meshToPad.get(mesh.id);
    if (pad) return { type: 'pad', pad };

    const knob = meshToKnob.get(mesh.id);
    if (knob) return { type: 'knob', ...knob };

    const button = meshToButton.get(mesh.id);
    if (button) return { type: 'button', button };

    return null;
  }

  // -----------------------------------------------------------------------
  // Knob values
  // -----------------------------------------------------------------------

  /**
   * Set a knob's value, and publish the change.
   *
   * What the knob LOOKS like is no longer decided here. `rig.setKnobValue`
   * turns the cap and redraws the printed collar from the same scalar, because
   * both are appearance and appearance is rig.js's business — this module's
   * job ends at turning a drag into a number.
   *
   * That split is what makes the collar trustworthy. There is exactly one
   * function that renders a knob's state, so the arc on the panel cannot show
   * one value while the cap points at another, no matter whether the change
   * came from a drag, from the GUI, or from the power-on defaults.
   */
  function setKnob(index, value, notify = true) {
    const knob = rig.knobs[index];
    if (!knob) return;

    rig.setKnobValue(index, value);

    if (notify) {
      bus.emit('knob:change', { index, label: knob.label, value: knob.value });
    }
  }

  // -----------------------------------------------------------------------
  // Pointer handling
  // -----------------------------------------------------------------------

  /** @type {null | { index: number, startY: number, startValue: number, pointerId: number }} */
  let drag = null;

  /** Last published hover key, so the bus is not spammed on every move. */
  let lastHover = '';

  function onPointerDown(event) {
    if (event.button !== 0) return; // left button only; right stays for orbit
    if (mode === 'locked') return;

    const hit = pick(event);
    if (!hit) return;

    // The one thing a shut slab does.
    if (hit.type === 'slab') {
      bus.emit('case:toggle', {});
      return;
    }

    // Suppress the camera for this gesture. OrbitControls checks `enabled` at
    // the top of its own move handler, so clearing it here stops the orbit
    // even though its pointerdown has already run.
    controls.enabled = false;

    if (hit.type === 'pad') {
      bus.emit('pad:trigger', { padId: hit.pad.id, velocity: velocityFor(event) });
      return;
    }

    // A button publishes its identity and nothing else. What 'fold' means is
    // main.js's decision, exactly as it is for a key press — which is why the
    // button and the O key end up running the same code with no duplication.
    if (hit.type === 'button') {
      bus.emit('button:press', { id: hit.button.id });
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

    /**
     * Hover feedback, and now a readout as well as a cursor.
     *
     * The cursor change said "this is interactive" and nothing else, which is
     * why four buttons on the front panel were unusable: their printed legends
     * are 12 mm of text on a 500 mm object, so at any framing that shows the
     * whole instrument they are below the resolution of the screen, and at a
     * framing close enough to read them you cannot see what you are doing.
     *
     * A hardware panel solves this by being physically present — you can lean
     * in. A screen cannot, so the label has to come to the pointer instead.
     * The readout is published as an intent like everything else; main.js
     * decides it means a DOM tooltip, and could equally decide it means the
     * instrument's own display.
     *
     * One raycast per pointer move against ~45 meshes is cheap, and it was
     * already happening for the cursor.
     */
    if (mode === 'locked') {
      canvas.style.cursor = '';
      if (lastHover !== '') { lastHover = ''; bus.emit('hover', null); }
      return;
    }

    const hit = pick(event);
    canvas.style.cursor = !hit ? '' : hit.type === 'knob' ? 'ns-resize' : 'pointer';

    let hover = null;
    if (hit?.type === 'slab') {
      hover = { label: 'Drum Rig', detail: 'Click to open the slab' };
    }
    else if (hit?.type === 'pad') {
      hover = {
        label: hit.pad.label,
        detail: `key ${KEY_LABELS.get(hit.pad.id) ?? ''} · click to play`,
      };
    } else if (hit?.type === 'knob') {
      hover = {
        label: hit.knob.label,
        detail: `${Math.round(hit.knob.value * 100)}% · drag up and down`,
      };
    } else if (hit?.type === 'button') {
      hover = { label: hit.button.name ?? hit.button.id, detail: hit.button.hint ?? '' };
    }

    // Only published when it CHANGES. A pointermove fires every few
    // milliseconds and the tooltip's content changes only when the pointer
    // crosses onto a different control, so comparing first turns a stream of
    // DOM writes into one per transition.
    const key = hover ? `${hover.label}|${hover.detail}` : '';
    if (key !== lastHover) {
      lastHover = key;
      bus.emit('hover', hover);
    }
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
    // Don't steal keys from a focused text field.
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (mode === 'locked') return;

    /**
     * Shut: the fold key is the only one that works.
     *
     * Handled before every other key rather than after, so there is one place
     * that says what a closed instrument responds to. Letting the pad keys
     * fall through and silently do nothing would be the same behaviour and a
     * worse expression of it — the next person reading this would have to
     * check four branches to learn that the slab is locked.
     */
    if (mode === 'closed') {
      if (event.code === 'KeyO') {
        bus.emit('case:toggle', {});
        event.preventDefault();
      }
      return;
    }

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
      return;
    }

    /**
     * A one-key way back to a good framing.
     *
     * This is the mitigation that makes free orbit safe rather than a trap.
     * The cost of letting the user move the camera is that they can put it
     * somewhere useless — under the floor's horizon limit, nose-first into a
     * speaker cabinet — and then have to fight it back by hand. A key that
     * cycles the authored shots means being lost is one keystroke deep instead
     * of a recovery task.
     */
    if (event.code === 'KeyV') {
      bus.emit('camera:next', {});
      event.preventDefault();
    }
  }

  // -----------------------------------------------------------------------

  function onPointerLeave() {
    if (lastHover !== '') {
      lastHover = '';
      bus.emit('hover', null);
    }
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('keydown', onKeyDown);

  function dispose() {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    window.removeEventListener('keydown', onKeyDown);
  }

  /**
   * @param {'open'|'closed'|'locked'} next
   */
  function setMode(next) {
    mode = next;
    canvas.style.cursor = '';
    if (lastHover !== '') { lastHover = ''; bus.emit('hover', null); }
  }

  return { setKnob, setMode, getMode: () => mode, dispose, KEY_MAP, KEY_LABELS, COMMAND_KEYS };
}