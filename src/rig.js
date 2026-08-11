/**
 * rig.js — the road case: geometry, materials, and the joint skeleton.
 *
 * Division of labour with hierarchy.js: this file builds the parts and
 * arranges them into the parent-child tree with correct pivot placement. It
 * never writes to a joint transform. hierarchy.js owns all motion and all
 * constraints; rig.js owns shape and appearance.
 *
 * This module never imports audio.js. It listens on the event bus for
 * 'pad:hit' and does not know or care whether that came from a mouse click, a
 * key press or the sequencer.
 */

import * as THREE from 'three';
import { bus } from './events.js';
import { PADS } from './pads.js';
import { brushedMetalMaps, rubberMaps, plasticMaps, configureMaps } from './textures.js';

// ---------------------------------------------------------------------------
// Dimensions — one place, so nothing is a magic number buried in a call
// ---------------------------------------------------------------------------

export const DIMS = {
  bodyW: 1.10,
  bodyD: 0.78,
  bodyH: 0.30,

  wallT: 0.03,   // panel thickness, used by lid and wings

  wingW: 0.34,

  deckW: 0.74,
  deckD: 0.58,
  deckT: 0.03,

  padPitch: 0.135,
  padSize: 0.10,
  padH: 0.022,
  ledSize: 0.118,
  ledH: 0.006,
  padTravel: 0.014,   // how far a pad sinks when struck

  /**
   * Half-length of a scissor arm: the distance from the centre cross pin to
   * either end. hierarchy.js derives deck height from it.
   */
  armHalf: 0.16,
  armT: 0.026,

  armSpread: 0.20,      // front/back separation of the two arm pairs
  scissorBaseY: 0.24,   // where the scissor stands inside the case

  panelW: 0.72,
  panelD: 0.17,
  panelT: 0.022,
  linkageLen: 0.13,

  knobR: 0.030,
  knobH: 0.032,
};

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

function buildMaterials(anisotropy) {
  const chassisMaps = configureMaps(brushedMetalMaps(512), 2, 1, anisotropy);
  const padMaps = configureMaps(rubberMaps(256), 1, 1, anisotropy);
  const plasticMapSet = configureMaps(plasticMaps(256), 3, 1, anisotropy);

  const chassis = new THREE.MeshStandardMaterial({
    ...chassisMaps,
    color: 0x8f959c,
    metalness: 0.92,
    roughness: 0.44,
    normalScale: new THREE.Vector2(0.7, 0.7),
  });

  // Same maps, different tint and finish: painted flight-case panel rather
  // than bare metal. Reusing the maps costs nothing and ties the family
  // together visually.
  const shell = new THREE.MeshStandardMaterial({
    ...chassisMaps,
    color: 0x2f3338,
    metalness: 0.55,
    roughness: 0.62,
    normalScale: new THREE.Vector2(0.5, 0.5),
  });

  const rubber = new THREE.MeshStandardMaterial({
    ...padMaps,
    color: 0x2a2e33,
    metalness: 0.0,
    roughness: 0.88,
    normalScale: new THREE.Vector2(1.0, 1.0),
  });

  const plastic = new THREE.MeshStandardMaterial({
    ...plasticMapSet,
    color: 0x24272b,
    metalness: 0.1,
    roughness: 0.66,
  });

  const brass = new THREE.MeshStandardMaterial({
    color: 0xc9a227,
    metalness: 0.85,
    roughness: 0.32,
  });

  return { chassis, shell, rubber, plastic, brass };
}

// ---------------------------------------------------------------------------
// Part builders
// ---------------------------------------------------------------------------

function box(w, h, d, material, castShadow = true) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * A hinge is a Group placed exactly on the axis of rotation, with the mesh
 * offset inside it.
 *
 * This is the single most important habit in the whole hierarchy. Three.js
 * rotates an object about its own origin, and a BoxGeometry's origin is its
 * centre — so rotating a lid mesh directly spins it about its middle like a
 * propeller. Putting an empty Group at the hinge line and offsetting the mesh
 * by half its length inside that group means rotating the group swings the
 * mesh about its edge, which is what a hinge does.
 */
function hinge(position) {
  const group = new THREE.Group();
  group.position.copy(position);
  return group;
}

function buildPad(padDef, materials) {
  const group = new THREE.Group();

  // The LED is a slightly oversized plate under the cap, so a rim of colour
  // shows around the rubber. Each pad needs its own material instance because
  // each one's emissiveIntensity is animated independently.
  const ledMaterial = new THREE.MeshStandardMaterial({
    color: 0x0a0b0c,
    emissive: new THREE.Color().setHSL(padDef.hue, 0.85, 0.5),
    emissiveIntensity: 0.12,
    metalness: 0.0,
    roughness: 0.5,
  });

  const led = box(DIMS.ledSize, DIMS.ledH, DIMS.ledSize, ledMaterial, false);
  led.position.y = DIMS.ledH / 2;
  group.add(led);

  const cap = box(DIMS.padSize, DIMS.padH, DIMS.padSize, materials.rubber);
  cap.position.y = DIMS.ledH + DIMS.padH / 2;
  group.add(cap);

  // Everything a hit needs to touch, gathered up front so the per-frame
  // update never has to search the scene graph.
  return {
    id: padDef.id,
    label: padDef.label,
    group,
    cap,
    led,
    ledMaterial,
    restY: 0,
    press: 0,
  };
}

function buildKnob(label, materials) {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(DIMS.knobR * 0.86, DIMS.knobR, DIMS.knobH, 24),
    materials.plastic
  );
  body.castShadow = true;
  body.position.y = DIMS.knobH / 2;
  group.add(body);

  // Pointer stripe, so rotation is legible at a glance.
  const indicator = box(0.005, 0.004, DIMS.knobR * 0.8, materials.brass);
  indicator.position.set(0, DIMS.knobH + 0.001, -DIMS.knobR * 0.42);
  group.add(indicator);

  return { label, group, value: 0.5 };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Build the whole rig.
 *
 * Every joint is left at its identity transform. hierarchy.js poses the
 * skeleton before the first frame is drawn.
 *
 * @param {{ anisotropy?: number }} options
 */
export function buildRig({ anisotropy = 1 } = {}) {
  const materials = buildMaterials(anisotropy);

  const root = new THREE.Group();

  // --- case body ---------------------------------------------------------
  const caseBody = new THREE.Group();
  root.add(caseBody);

  const shell = box(DIMS.bodyW, DIMS.bodyH, DIMS.bodyD, materials.shell);
  shell.position.y = DIMS.bodyH / 2;
  caseBody.add(shell);

  // Corner protectors: pure decoration, but they are what make the silhouette
  // read as a flight case rather than a crate.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const corner = box(0.07, 0.07, 0.07, materials.chassis);
      corner.position.set(
        sx * (DIMS.bodyW / 2 - 0.02),
        DIMS.bodyH - 0.03,
        sz * (DIMS.bodyD / 2 - 0.02)
      );
      caseBody.add(corner);
    }
  }

  // --- lid: hinged along the top rear edge --------------------------------
  const lidPivot = hinge(new THREE.Vector3(0, DIMS.bodyH, -DIMS.bodyD / 2));
  caseBody.add(lidPivot);

  const lid = box(DIMS.bodyW, DIMS.wallT, DIMS.bodyD, materials.shell);
  lid.position.set(0, DIMS.wallT / 2, DIMS.bodyD / 2); // offset forward from the hinge
  lidPivot.add(lid);

  // --- wings: hinged along the top side edges -----------------------------
  const wingLeftPivot = hinge(new THREE.Vector3(-DIMS.bodyW / 2, DIMS.bodyH, 0));
  const wingRightPivot = hinge(new THREE.Vector3(DIMS.bodyW / 2, DIMS.bodyH, 0));
  caseBody.add(wingLeftPivot, wingRightPivot);

  const wingLeft = box(DIMS.wingW, DIMS.wallT, DIMS.bodyD, materials.shell);
  wingLeft.position.set(-DIMS.wingW / 2, DIMS.wallT / 2, 0);
  wingLeftPivot.add(wingLeft);

  const wingRight = box(DIMS.wingW, DIMS.wallT, DIMS.bodyD, materials.shell);
  wingRight.position.set(DIMS.wingW / 2, DIMS.wallT / 2, 0);
  wingRightPivot.add(wingRight);

  // --- scissor lift -------------------------------------------------------
  const scissor = new THREE.Group();
  scissor.position.y = DIMS.scissorBaseY;
  caseBody.add(scissor);

  // Two pairs of crossed arms, front and back, so the lift reads as a
  // mechanism with width rather than a single flat linkage. Both members of a
  // pair share an angle — hierarchy.js drives them from one value.
  const armPivotsA = [];
  const armPivotsB = [];

  for (const z of [DIMS.armSpread, -DIMS.armSpread]) {
    const a = new THREE.Group();
    const b = new THREE.Group();
    a.position.z = z;
    b.position.z = z;

    a.add(box(DIMS.armHalf * 2, DIMS.armT, DIMS.armT, materials.chassis));
    b.add(box(DIMS.armHalf * 2, DIMS.armT, DIMS.armT, materials.chassis));

    scissor.add(a, b);
    armPivotsA.push(a);
    armPivotsB.push(b);
  }

  // --- deck, carried by the scissor ---------------------------------------
  const deck = new THREE.Group();
  scissor.add(deck);

  const deckPlate = box(DIMS.deckW, DIMS.deckT, DIMS.deckD, materials.chassis);
  deckPlate.position.y = DIMS.deckT / 2;
  deck.add(deckPlate);

  // --- pad grid, carried by the deck --------------------------------------
  const padGrid = new THREE.Group();
  padGrid.position.y = DIMS.deckT;
  deck.add(padGrid);

  const pads = [];
  const padById = new Map();
  const span = (4 - 1) * DIMS.padPitch;

  PADS.forEach((padDef, index) => {
    const row = Math.floor(index / 4);
    const col = index % 4;

    const pad = buildPad(padDef, materials);
    pad.group.position.set(
      col * DIMS.padPitch - span / 2,
      0,
      row * DIMS.padPitch - span / 2
    );
    pad.restY = pad.group.position.y;

    padGrid.add(pad.group);
    pads.push(pad);
    padById.set(pad.id, pad);
  });

  // --- control panel on a linkage -----------------------------------------
  const linkagePivot = hinge(
    new THREE.Vector3(0, DIMS.bodyH, -DIMS.bodyD / 2 + 0.10)
  );
  caseBody.add(linkagePivot);

  const linkageArm = box(0.05, DIMS.linkageLen, 0.04, materials.chassis);
  linkageArm.position.y = DIMS.linkageLen / 2;
  linkagePivot.add(linkageArm);

  // The panel hangs off the far end of the arm and is counter-rotated by
  // hierarchy.js so the knobs stay level as the arm pitches.
  const controlPanel = new THREE.Group();
  controlPanel.position.y = DIMS.linkageLen;
  linkagePivot.add(controlPanel);

  const panelPlate = box(DIMS.panelW, DIMS.panelT, DIMS.panelD, materials.plastic);
  panelPlate.position.y = DIMS.panelT / 2;
  controlPanel.add(panelPlate);

  const KNOB_LABELS = [
    'Master volume', 'Master filter',
    'Layer 1', 'Layer 2', 'Layer 3', 'Layer 4',
  ];

  const knobs = KNOB_LABELS.map((label, i) => {
    const knob = buildKnob(label, materials);
    const knobSpan = (KNOB_LABELS.length - 1) * 0.105;
    knob.group.position.set(i * 0.105 - knobSpan / 2, DIMS.panelT, 0);
    controlPanel.add(knob.group);
    return knob;
  });

  // -----------------------------------------------------------------------
  // Joints: everything hierarchy.js is allowed to touch.
  // -----------------------------------------------------------------------
  const joints = {
    caseBody,
    lidPivot,
    wingLeftPivot,
    wingRightPivot,
    scissor,
    armPivotsA,
    armPivotsB,
    deck,
    padGrid,
    linkagePivot,
    controlPanel,
  };

  // -----------------------------------------------------------------------
  // Reacting to hits
  //
  // Subscribing to the bus rather than being called by audio.js is what keeps
  // the two halves independent. rig.js has no idea the sequencer exists.
  // -----------------------------------------------------------------------
  bus.on('pad:hit', ({ padId, velocity = 1 }) => {
    const pad = padById.get(padId);
    if (pad) pad.press = Math.max(pad.press, velocity);
  });

  /**
   * Per-frame pad response.
   *
   * `press` decays exponentially rather than running a tween per hit. A tween
   * would have to be cancelled and restarted on every retrigger, and at
   * sixteenth notes on a fast tempo that is a lot of allocation for an effect
   * that is one number. Exponential decay also retriggers correctly for free:
   * setting press back to 1 mid-decay simply restarts the fall.
   */
  function update(dt) {
    const decay = Math.exp(-dt * 11);

    for (const pad of pads) {
      if (pad.press < 0.001) {
        if (pad.press !== 0) {
          pad.press = 0;
          pad.group.position.y = pad.restY;
          pad.ledMaterial.emissiveIntensity = 0.12;
        }
        continue;
      }

      pad.press *= decay;
      pad.group.position.y = pad.restY - pad.press * DIMS.padTravel;
      pad.ledMaterial.emissiveIntensity = 0.12 + pad.press * 2.2;
    }
  }

  return { root, joints, pads, padById, knobs, materials, update };
}