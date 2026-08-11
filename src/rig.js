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
 *
 * Every solid here is a rounded box or a lathed cylinder from geometry.js.
 * Nothing in the rig has a hard 90-degree edge, because nothing manufactured
 * does: an injection mould cannot fill a sharp internal corner and a milled
 * part is deburred before it ships. The fillets are the difference between the
 * object reading as a product and reading as a diagram of one.
 */

import * as THREE from 'three';
import { bus } from './events.js';
import { PADS } from './pads.js';
import { PALETTE, padColour, padGlow } from './palette.js';
import { roundedBoxGeometry, roundedCylinderGeometry } from './geometry.js';
import {
  mouldedMaps,
  rubberMaps,
  brushedMetalMaps,
  configureMaps,
  glyphTexture,
} from './textures.js';

// ---------------------------------------------------------------------------
// Dimensions — one place, so nothing is a magic number buried in a call
//
// Each solid carries its own fillet radius next to its size. A single global
// radius does not work: the same 40 mm fillet that reads as a soft shoulder on
// the case shell would swallow a 12 mm pad rim whole. Radius is a proportion
// of the part, not a property of the scene.
// ---------------------------------------------------------------------------

export const DIMS = {
  bodyW: 1.10,
  bodyD: 0.78,
  bodyH: 0.30,
  bodyR: 0.055,

  wallT: 0.038,  // panel thickness, used by lid and wings
  wallR: 0.019,

  wingW: 0.34,

  deckW: 0.74,
  deckD: 0.58,
  deckT: 0.036,
  deckR: 0.016,

  padPitch: 0.135,
  padSize: 0.104,
  padH: 0.038,
  padR: 0.015,
  ledSize: 0.120,
  ledH: 0.012,
  ledR: 0.006,
  padTravel: 0.014,   // how far a pad sinks when struck

  /**
   * Half-length of a scissor arm: the distance from the centre cross pin to
   * either end. hierarchy.js derives deck height from it.
   */
  armHalf: 0.16,
  armT: 0.028,
  armR: 0.014,

  armSpread: 0.20,      // front/back separation of the two arm pairs
  scissorBaseY: 0.24,   // where the scissor stands inside the case

  panelW: 0.72,
  panelD: 0.17,
  panelT: 0.028,
  panelR: 0.013,
  linkageLen: 0.13,

  knobR: 0.034,
  knobH: 0.030,
  knobCorner: 0.013,
};

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

function buildMaterials(anisotropy) {
  // Repeats are counted in world units now, because geometry.js unwraps with a
  // box projection in metres rather than 0..1 per face. Three tiles per metre
  // puts the grain at roughly the same visual density on a 1.1 m shell and on
  // a 30 mm knob, which per-face UVs could never do.
  const mouldedSet = configureMaps(mouldedMaps(256), 3, 3, anisotropy);
  const padSet = configureMaps(rubberMaps(256), 14, 14, anisotropy);
  const metalSet = configureMaps(brushedMetalMaps(512), 6, 6, anisotropy);

  /** Soft moulded plastic: the case, its lid and its wings. */
  const shell = new THREE.MeshStandardMaterial({
    ...mouldedSet,
    color: PALETTE.shell,
    metalness: 0.0,
    roughness: 0.58,
    normalScale: new THREE.Vector2(0.35, 0.35),
  });

  const shellDeep = new THREE.MeshStandardMaterial({
    ...mouldedSet,
    color: PALETTE.shellDeep,
    metalness: 0.0,
    roughness: 0.64,
    normalScale: new THREE.Vector2(0.35, 0.35),
  });

  const deck = new THREE.MeshStandardMaterial({
    ...mouldedSet,
    color: PALETTE.deck,
    metalness: 0.0,
    roughness: 0.55,
    normalScale: new THREE.Vector2(0.3, 0.3),
  });

  const panel = new THREE.MeshStandardMaterial({
    ...mouldedSet,
    color: PALETTE.panel,
    metalness: 0.0,
    roughness: 0.5,
    normalScale: new THREE.Vector2(0.3, 0.3),
  });

  /**
   * The mechanism, and the only metal left in the rig.
   *
   * Metalness needs something to reflect. A metallic surface has no diffuse
   * response at all, so with no environment map it renders as whatever the
   * specular lobes happen to catch — which is to say, nearly black. main.js
   * builds a procedural studio environment precisely so this material has
   * something to be. Drop that and the scissor arms go dead.
   */
  const mech = new THREE.MeshStandardMaterial({
    ...metalSet,
    color: PALETTE.mech,
    metalness: 0.62,
    roughness: 0.36,
    normalScale: new THREE.Vector2(0.5, 0.5),
  });

  const accent = new THREE.MeshStandardMaterial({
    color: PALETTE.accent,
    metalness: 0.15,
    roughness: 0.38,
  });

  /** The recessed bay the pad deck rises out of. */
  const recess = new THREE.MeshStandardMaterial({
    color: 0x3c4256,
    metalness: 0.0,
    roughness: 0.85,
  });

  return { shell, shellDeep, deck, panel, mech, accent, recess, padSet };
}

// ---------------------------------------------------------------------------
// Part builders
// ---------------------------------------------------------------------------

function roundedBox(w, h, d, radius, material, castShadow = true) {
  const mesh = new THREE.Mesh(roundedBoxGeometry(w, h, d, radius), material);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * A hinge is a Group placed exactly on the axis of rotation, with the mesh
 * offset inside it.
 *
 * This is the single most important habit in the whole hierarchy. Three.js
 * rotates an object about its own origin, and a box's origin is its centre —
 * so rotating a lid mesh directly spins it about its middle like a propeller.
 * Putting an empty Group at the hinge line and offsetting the mesh by half its
 * length inside that group means rotating the group swings the mesh about its
 * edge, which is what a hinge does.
 */
function hinge(position) {
  const group = new THREE.Group();
  group.position.copy(position);
  return group;
}

function buildPad(padDef, materials, capMaterials, label) {
  const group = new THREE.Group();

  /**
   * The rim is a slightly oversized plate under the cap, so a band of colour
   * shows around the pad and lights up when it is struck. Each pad needs its
   * own material instance because each one's emissiveIntensity is animated
   * independently — the price of driving sixteen glows without a shader.
   */
  const ledMaterial = new THREE.MeshStandardMaterial({
    color: 0x1b1f2e,
    emissive: padGlow(padDef.hue),
    emissiveIntensity: 0.35,
    metalness: 0.0,
    roughness: 0.45,
  });

  const led = roundedBox(DIMS.ledSize, DIMS.ledH, DIMS.ledSize, DIMS.ledR, ledMaterial, false);
  led.position.y = DIMS.ledH / 2;
  group.add(led);

  const cap = roundedBox(DIMS.padSize, DIMS.padH, DIMS.padSize, DIMS.padR, capMaterials.get(padDef.hue));
  cap.position.y = DIMS.ledH + DIMS.padH / 2;
  group.add(cap);

  // The key letter, screen-printed on the cap. Drawn on a plane rather than
  // baked into the cap's colour map, because the cap's UVs are a world-space
  // box projection shared with every other moulded part — good for grain,
  // useless for placing a glyph.
  if (label) {
    const print = new THREE.Mesh(
      new THREE.PlaneGeometry(DIMS.padSize * 0.6, DIMS.padSize * 0.6),
      new THREE.MeshBasicMaterial({
        map: glyphTexture(label),
        color: PALETTE.ink,
        transparent: true,
        opacity: 0.72,
        depthWrite: false,
      })
    );
    print.rotation.x = -Math.PI / 2;
    print.position.y = DIMS.ledH + DIMS.padH + 0.0015;
    group.add(print);
  }

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
    roundedCylinderGeometry(DIMS.knobR, DIMS.knobH, DIMS.knobCorner, 40, 5),
    materials.shellDeep
  );
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // Pointer stripe, so rotation is legible at a glance. Sunk a hair into the
  // cap rather than floated on top, so it reads as inlaid.
  const indicator = roundedBox(0.007, 0.006, DIMS.knobR * 0.72, 0.003, materials.accent, false);
  indicator.position.set(0, DIMS.knobH - 0.001, -DIMS.knobR * 0.40);
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
 * `labelFor` is injected rather than imported: the key letters live in
 * interaction.js because they are a property of the input map, and rig.js has
 * no business knowing an input layer exists. main.js owns the wiring, here as
 * everywhere else.
 *
 * @param {{ anisotropy?: number, labelFor?: (padId: string) => string }} options
 */
export function buildRig({ anisotropy = 1, labelFor = null } = {}) {
  const materials = buildMaterials(anisotropy);

  // One cap material per hue rather than per pad. Cap colour never animates —
  // only the rim's emissive does — so sixteen instances would be fifteen
  // redundant shader binds for no visible difference.
  const capMaterials = new Map();
  for (const padDef of PADS) {
    if (capMaterials.has(padDef.hue)) continue;
    capMaterials.set(padDef.hue, new THREE.MeshStandardMaterial({
      ...materials.padSet,
      color: padColour(padDef.hue),
      metalness: 0.0,
      roughness: 0.72,
      normalScale: new THREE.Vector2(0.45, 0.45),
    }));
  }

  const root = new THREE.Group();

  // --- case body ---------------------------------------------------------
  const caseBody = new THREE.Group();
  root.add(caseBody);

  const shell = roundedBox(DIMS.bodyW, DIMS.bodyH, DIMS.bodyD, DIMS.bodyR, materials.shell);
  shell.position.y = DIMS.bodyH / 2;
  caseBody.add(shell);

  // The bay the deck rises out of. Without it the deck plate simply passes
  // through an unbroken top surface, which the eye reads instantly as two
  // objects intersecting rather than one mechanism emerging.
  const recess = roundedBox(
    DIMS.deckW + 0.03,
    0.02,
    DIMS.deckD + 0.03,
    0.008,
    materials.recess,
    false
  );
  recess.position.y = DIMS.bodyH - 0.008;
  caseBody.add(recess);

  // --- lid: hinged along the top rear edge --------------------------------
  const lidPivot = hinge(new THREE.Vector3(0, DIMS.bodyH, -DIMS.bodyD / 2));
  caseBody.add(lidPivot);

  const lid = roundedBox(DIMS.bodyW, DIMS.wallT, DIMS.bodyD, DIMS.wallR, materials.shellDeep);
  lid.position.set(0, DIMS.wallT / 2, DIMS.bodyD / 2); // offset forward from the hinge
  lidPivot.add(lid);

  // --- wings: hinged along the top side edges -----------------------------
  const wingLeftPivot = hinge(new THREE.Vector3(-DIMS.bodyW / 2, DIMS.bodyH, 0));
  const wingRightPivot = hinge(new THREE.Vector3(DIMS.bodyW / 2, DIMS.bodyH, 0));
  caseBody.add(wingLeftPivot, wingRightPivot);

  const wingLeft = roundedBox(DIMS.wingW, DIMS.wallT, DIMS.bodyD, DIMS.wallR, materials.shellDeep);
  wingLeft.position.set(-DIMS.wingW / 2, DIMS.wallT / 2, 0);
  wingLeftPivot.add(wingLeft);

  const wingRight = roundedBox(DIMS.wingW, DIMS.wallT, DIMS.bodyD, DIMS.wallR, materials.shellDeep);
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

    a.add(roundedBox(DIMS.armHalf * 2, DIMS.armT, DIMS.armT, DIMS.armR, materials.mech));
    b.add(roundedBox(DIMS.armHalf * 2, DIMS.armT, DIMS.armT, DIMS.armR, materials.mech));

    scissor.add(a, b);
    armPivotsA.push(a);
    armPivotsB.push(b);
  }

  // --- deck, carried by the scissor ---------------------------------------
  const deck = new THREE.Group();
  scissor.add(deck);

  const deckPlate = roundedBox(DIMS.deckW, DIMS.deckT, DIMS.deckD, DIMS.deckR, materials.deck);
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

    const pad = buildPad(padDef, materials, capMaterials, labelFor?.(padDef.id) ?? null);
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

  const linkageArm = roundedBox(0.05, DIMS.linkageLen, 0.04, 0.018, materials.mech);
  linkageArm.position.y = DIMS.linkageLen / 2;
  linkagePivot.add(linkageArm);

  // The panel hangs off the far end of the arm and is counter-rotated by
  // hierarchy.js so the knobs stay level as the arm pitches.
  const controlPanel = new THREE.Group();
  controlPanel.position.y = DIMS.linkageLen;
  linkagePivot.add(controlPanel);

  const panelPlate = roundedBox(
    DIMS.panelW, DIMS.panelT, DIMS.panelD, DIMS.panelR, materials.panel
  );
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
          pad.ledMaterial.emissiveIntensity = 0.35;
        }
        continue;
      }

      pad.press *= decay;
      pad.group.position.y = pad.restY - pad.press * DIMS.padTravel;
      pad.ledMaterial.emissiveIntensity = 0.35 + pad.press * 3.0;
    }
  }

  return { root, joints, pads, padById, knobs, materials, update };
}
