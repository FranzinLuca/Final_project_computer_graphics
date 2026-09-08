
/**
  interaction.js — turning input into intent.

  This module raycasts, reads the keyboard and tracks drags. 
  Everything it detects is published on the bus as intent:

    'pad:trigger'      { padId, velocity }
    'knob:change'      { index, label, value }
    'button:press'     { id }
    'hover'            { label, detail } | null
    'transport:toggle' {}
    'case:toggle'      {}
*/

import * as THREE from 'three';
import { bus } from './events.js';
import { PADS } from './pads.js';

// ------------
// Keyboard map
// ------------

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

/** padId -> human-readable key label */
export const KEY_LABELS = new Map(
  KEY_ORDER.map((code, i) => [PADS[i].id, code.replace(/^(Digit|Key)/, '')])
);

/** Non-pad keys. */
export const COMMAND_KEYS = [
  { code: 'Space', label: 'Space', description: 'Start / stop the sequencer' },
  { code: 'KeyO',  label: 'O',     description: 'Unfold / fold the slab' },
  { code: 'KeyV',  label: 'V',     description: 'Cycle the camera shots' },
];

// ---------
// Knob feel
// ---------

/** Pixels of vertical travel for the full 0..1 range. */
const DRAG_RANGE_PX = 220;

/** Hold Shift to divide the sensitivity by this, for fine adjustment. */
const FINE_FACTOR = 5;

/**
  @param {{ canvas: HTMLCanvasElement, camera: THREE.Camera,
            controls: { enabled: boolean }, rig: any }} deps
 */
export function initInteraction({ canvas, camera, controls, rig }) {
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  /**
    What the instrument will currently accept.

      'open'    everything: pads, knobs, buttons, keyboard
      'closed'  nothing but a click anywhere on the slab, which opens it
      'locked'  nothing at all, for the power-on sequence
  */
  let mode = 'open';

  // pickable sets, built once 

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
    The four soft buttons on the front band.
  */
  const meshToButton = new Map();

  for (const button of rig.buttons ?? []) {
    pickable.push(button.cap);
    meshToButton.set(button.cap.id, button);
  }

  /**
    Every mesh in the instrument, for the shut state.
  */
  const slabMeshes = [];
  rig.root.traverse((object) => {
    if (object.isMesh) slabMeshes.push(object);
  });

  // -------
  // Picking
  // -------

  /**
    Convert a pointer position into normalised device coordinates.
  */
  function updatePointer(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  /**
    Nearest pickable under the pointer, or null.
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

  // -----------
  // Knob values
  // -----------

  /**
    Set a knob's value, and publish the change.
  */
  function setKnob(index, value, notify = true) {
    const knob = rig.knobs[index];
    if (!knob) return;

    rig.setKnobValue(index, value);

    if (notify) {
      bus.emit('knob:change', { index, label: knob.label, value: knob.value });
    }
  }

  // ----------------
  // Pointer handling
  // ----------------

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

    // Suppress the camera for this gesture. 
    controls.enabled = false;

    if (hit.type === 'pad') {
      bus.emit('pad:trigger', { padId: hit.pad.id, velocity: velocityFor(event) });
      return;
    }

    // A button publishes its identity and nothing else
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

    // Capture keeps the drag alive if the pointer leaves the canvas
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

    // Only published when it changes
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

  function velocityFor(event) {
    if (event.pointerType === 'mouse') return 1.0;
    return THREE.MathUtils.clamp(0.35 + event.pressure * 0.65, 0.35, 1.0);
  }

  // --------
  // Keyboard
  // --------

  function onKeyDown(event) {
    // Don't steal keys from a focused text field.
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (mode === 'locked') return;

    /**
      Shut: the fold key is the only one that works.
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
      A one-key way back to a good framing.
    */
    if (event.code === 'KeyV') {
      bus.emit('camera:next', {});
      event.preventDefault();
    }
  }

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
    @param {'open'|'closed'|'locked'} next
  */
  function setMode(next) {
    mode = next;
    canvas.style.cursor = '';
    if (lastHover !== '') { lastHover = ''; bus.emit('hover', null); }
  }

  return { setKnob, setMode, getMode: () => mode, dispose, KEY_MAP, KEY_LABELS, COMMAND_KEYS };
}