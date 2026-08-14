/**
 * rig.js — the slab: geometry, materials, and the joint skeleton.
 *
 * Division of labour with hierarchy.js is unchanged: this file builds the
 * parts and arranges them into the parent-child tree with correct pivot
 * placement. It never writes to a joint transform. hierarchy.js owns all
 * motion and all constraints; rig.js owns shape and appearance.
 *
 * This module never imports audio.js. It listens on the event bus for
 * 'pad:hit' and does not know or care whether that came from a mouse click, a
 * key press or the sequencer.
 *
 *
 * WHAT REPLACED WHAT, AND WHY
 *
 * The folding road case is gone. Three panels rotating up and outward around a
 * low horizontal plinth is, geometrically, a chair — a back and two arms
 * around a seat — and no amount of material work was going to talk the eye out
 * of that reading. The knobs were the second failure: they hung off a linkage
 * rooted in the case body, which left them below the deck and in its shadow.
 *
 * The object is now a tri-fold slab. A fixed 4x4 grid in a recessed bezel,
 * flanked by two wings hinged on the grid's left and right edges. Open, the
 * wings lie coplanar with the grid and carry the knobs — the control surface
 * is one continuous plane, which is what the reference hardware does and what
 * the old layout could not achieve. Closed, the wings rotate 180 degrees
 * inward and meet at a centre seam, covering the pads completely.
 *
 * Two consequences worth stating out loud, because they are the marks:
 *
 *   1. The wing width is NOT a design choice. Folded inward each wing must
 *      reach the centreline, so wingW is exactly slabW/2 — any narrower and
 *      the shut slab shows a gap onto the pads, any wider and the wings
 *      collide at the seam before reaching 180 degrees. It is derived, and
 *      DIMS derives it rather than restating it as a number.
 *
 *   2. The hinge cannot be fixed. Open, the wing must be exactly coplanar with
 *      the bezel — offset zero. Closed, it must clear pads that stand 12 mm
 *      proud of that same plane. One stationary axis cannot satisfy both, so
 *      the hinge translates as it rotates. hierarchy.js owns that constraint;
 *      this file only places the hinge at its open position and states the
 *      clearance it must reach.
 *
 * The scissor lift is not here. It belongs to the base, which is deliberately
 * out of scope for this pass — but everything below hangs off a single
 * `slabRoot` group that owns nothing above itself, so adding a base later is a
 * reparent (`deck.add(slabRoot)`) and not a rewrite.
 *
 * Every solid is a rounded box or a lathed cylinder from geometry.js. Nothing
 * has a hard 90-degree edge, because nothing manufactured does.
 */

import * as THREE from 'three';
import { bus } from './events.js';
import { PADS } from './pads.js';
import { PALETTE, padGlow } from './palette.js';
import { roundedBoxGeometry, roundedCylinderGeometry } from './geometry.js';
import {
  mouldedMaps,
  rubberMaps,
  brushedMetalMaps,
  configureMaps,
  glyphTexture,
} from './textures.js';

// ---------------------------------------------------------------------------
// Dimensions
//
// One place, so nothing is a magic number buried in a call. Each solid carries
// its own fillet radius next to its size: a single global radius does not work,
// because the same fillet that reads as a soft shoulder on a 500 mm slab would
// swallow a 12 mm pad rim whole. Radius is a proportion of the part.
//
// The chain of dependencies, top to bottom — these are checked arithmetic, not
// taste, and changing one number means rechecking the ones below it:
//
//   wellFloorY = slabT - wellDepth            = 0.032
//   padTopY    = wellFloorY + ledH + padH     = 0.072   (12 mm proud of bezel)
//   hingeClear = padTopY - slabT + tolerance  = 0.020
//   closed wing underside = slabT + hingeClear = 0.080  (8 mm over the pads)
// ---------------------------------------------------------------------------

const SLAB_W = 0.50;

export const DIMS = {
  // --- centre section ------------------------------------------------------
  slabW: SLAB_W,
  slabD: 0.48,
  slabT: 0.060,
  slabR: 0.014,

  wellInset: 0.030,   // bezel rail width, all four sides
  wellDepth: 0.028,   // how far the pad floor sits below the bezel top

  // --- wings ---------------------------------------------------------------
  /**
   * Derived, not chosen. See the header: folded inward, two wings of this
   * width meet exactly at x = 0 and cover the centre section completely.
   * Open span is consequently exactly twice the closed span, which is a
   * pleasing thing to be able to say and a direct consequence of the same
   * constraint.
   */
  wingW: SLAB_W / 2,
  wingT: 0.034,
  wingR: 0.012,

  /**
   * How far the hinge axis must rise between open and shut.
   *
   * Open it is zero: the wing's top face has to be flush with the bezel or the
   * control surface is not one plane. Shut it has to be enough that the wing's
   * underside passes over the pads. 12 mm of protrusion plus 8 mm of tolerance.
   */
  hingeClear: 0.020,

  hingeBarrelR: 0.009,
  hingeBarrelL: 0.055,

  // --- pads ----------------------------------------------------------------
  padPitch: 0.104,
  padSize: 0.088,
  padH: 0.030,
  padR: 0.012,
  ledSize: 0.098,
  ledH: 0.010,
  ledR: 0.005,
  padTravel: 0.010,   // how far a pad sinks when struck

  // --- knobs ---------------------------------------------------------------
  knobR: 0.030,
  knobH: 0.026,
  knobCorner: 0.011,
  knobPitch: 0.125,   // three per wing, spaced along the wing's depth

  /**
   * Reserved. The wings are cut deep enough for a row of soft buttons above
   * the knob column — the reference hardware has one — but building it now
   * would be a seventeenth instance of the raycast the pads already
   * demonstrate, at a point in the schedule where the lighting phase has not
   * started. The space is kept so adding them later needs no relayout.
   */
  buttonBandD: 0.09,
};

/** Where the pad floor sits. Used by rig.js and by hierarchy.js's solver. */
export const WELL_FLOOR_Y = DIMS.slabT - DIMS.wellDepth;

/**
 * Pad emissive levels, in one table because they have to be balanced against
 * each other rather than chosen one at a time.
 *
 * `idle` is not zero. A grid of sixteen identical grey caps is unreadable as a
 * kit — you cannot tell the kicks from the cymbals without striking them — so
 * every pad sits at a low tint of its own hue. It is deliberately below the
 * threshold where it competes with a struck pad: 0.07 against 2.4 is a factor
 * of thirty-four, which after tone mapping still reads as "off" beside "on".
 *
 * The rim runs hotter than the cap and falls slower. A cap is a diffuser and a
 * diffuser is always dimmer than the source behind it, so a seam brighter than
 * the face it surrounds is what sells the cap as translucent rather than as a
 * painted plate. The slower fall does the same job in time: the housing stays
 * lit for a moment after the face has dropped, the way a real one does.
 */
export const PAD_EMISSIVE = {
  idle: 0.07,
  peak: 2.40,
  rimIdle: 0.22,
  rimPeak: 4.20,
  capDecay: 11,   // reciprocal seconds
  rimDecay: 7,    // slower, so the seam outlives the face
};

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

function buildMaterials(anisotropy) {
  // Repeats are counted in world units, because geometry.js unwraps with a box
  // projection in metres rather than 0..1 per face. Three tiles per metre puts
  // the grain at roughly the same visual density on a 500 mm slab and on a
  // 30 mm knob, which per-face UVs could never do.
  const mouldedSet = configureMaps(mouldedMaps(256), 4, 4, anisotropy);
  const padSet = configureMaps(rubberMaps(256), 16, 16, anisotropy);
  const metalSet = configureMaps(brushedMetalMaps(512), 8, 8, anisotropy);

  /**
   * The slab body and its bezel rails.
   *
   * normalScale is a third of what the cream shell used. That shell's noise
   * read as felt at this camera distance — upholstery, which was half of why
   * the old case looked like furniture — and it fought the toon-shaded mascot
   * standing next to it. A dark moulded surface wants the grain present enough
   * to break up the specular and no more.
   */
  const slab = new THREE.MeshStandardMaterial({
    ...mouldedSet,
    color: PALETTE.slab,
    metalness: 0.0,
    roughness: 0.52,
    normalScale: new THREE.Vector2(0.12, 0.12),
  });

  /** Wing undersides — which is to say, the exterior of the shut slab. */
  const slabDeep = new THREE.MeshStandardMaterial({
    ...mouldedSet,
    color: PALETTE.slabDeep,
    metalness: 0.0,
    roughness: 0.58,
    normalScale: new THREE.Vector2(0.12, 0.12),
  });

  /**
   * The recessed floor. Nearly matte and nearly black: its whole job is to be
   * the dark field the lit pads read against, so any specular it catches is
   * working against it.
   */
  const well = new THREE.MeshStandardMaterial({
    color: PALETTE.well,
    metalness: 0.0,
    roughness: 0.92,
  });

  /**
   * The cap material TEMPLATE. Cloned once per pad, never used directly.
   *
   * This has now moved twice, and the middle position was wrong, so it is
   * worth recording all three:
   *
   *   1. Originally a Map of one material per hue — cap colour was a property
   *      of the plastic, as it was on the old cream case.
   *   2. Then a single shared neutral material, with hue arriving entirely as
   *      emission from a rim plate underneath. Sixteen materials became one.
   *   3. Now a template cloned sixteen times, with the emission on the CAP.
   *
   * Step 2 was the right idea implemented on the wrong surface. Making the
   * colour emissive rather than diffuse is correct and stays. But putting that
   * emission on a rim *beneath* the cap means only a hairline around the base
   * lights up, and the reference hardware does not behave that way: the cap is
   * a translucent diffuser with the LED behind it, so the whole face floods.
   *
   * Emission is animated per pad, and `emissiveIntensity` is a uniform, so a
   * shared material cannot express sixteen different states. Sixteen clones is
   * the price of the effect. It is a cheaper price than it looks: `clone()`
   * copies texture *references*, so all sixteen still sample one set of maps,
   * and they compile to the same shader program because the defines are
   * identical — the cost is sixteen uniform blocks, not sixteen programs, and
   * each pad was already its own draw call regardless.
   *
   * The optimisation was real. It was just paying for the wrong picture.
   */
  const padCap = new THREE.MeshStandardMaterial({
    ...padSet,
    color: PALETTE.padCap,
    metalness: 0.0,
    roughness: 0.68,
    normalScale: new THREE.Vector2(0.4, 0.4),
  });

  /**
   * Hinge barrels, and the only metal left in the rig.
   *
   * Metalness needs something to reflect. A metallic surface has no diffuse
   * response at all, so with no environment map it renders as whatever the
   * specular lobes happen to catch — which is to say, nearly black. main.js
   * builds a procedural studio environment precisely so this material has
   * something to be. Drop that and the hinges go dead.
   */
  const mech = new THREE.MeshStandardMaterial({
    ...metalSet,
    color: PALETTE.mech,
    metalness: 0.72,
    roughness: 0.32,
    normalScale: new THREE.Vector2(0.5, 0.5),
  });

  const accent = new THREE.MeshStandardMaterial({
    color: PALETTE.accent,
    metalness: 0.15,
    roughness: 0.38,
  });

  return { slab, slabDeep, well, padCap, mech, accent, padSet };
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
 * so rotating a wing mesh directly spins it about its middle like a propeller.
 * Putting an empty Group on the hinge line and offsetting the mesh by half its
 * width inside that group means rotating the group swings the mesh about its
 * edge, which is what a hinge does.
 *
 * These hinges also translate, which is unusual and is the point: hierarchy.js
 * writes both `rotation.z` and `position.y` on the same group. Placing it here
 * at its open position means the pose at rest is the identity transform.
 */
function hinge(position) {
  const group = new THREE.Group();
  group.position.copy(position);
  return group;
}

function buildPad(padDef, materials, label) {
  const group = new THREE.Group();

  const glow = padGlow(padDef.hue);

  /**
   * The cap: a translucent diffuser with the LED behind it.
   *
   * The whole face emits, because that is what the hardware does. A pad on a
   * grid controller is a moulded piece of frosted plastic with an RGB LED
   * under it — when the LED fires, the entire cap becomes the light source,
   * not a ring around its base.
   *
   * Emissive on a MeshStandardMaterial is added AFTER shading and is uniform
   * across the surface, which would be a defect on a solid object — it flattens
   * the form. Here it is exactly right, and for a physical reason: a
   * backlit diffuser genuinely has no shading. It is an area emitter, so it
   * looks the same from every direction and has no terminator. The one case
   * where the crude approximation is the accurate one.
   *
   * `emissive` holds the hue and `emissiveIntensity` is the only thing that
   * moves. Animating the colour instead would mean three float writes and a
   * material flag per pad per frame; animating one scalar against a fixed
   * colour is one write, and it keeps hue a property of the pad while
   * brightness stays a property of its state.
   */
  const capMaterial = materials.padCap.clone();
  capMaterial.emissive = glow;
  capMaterial.emissiveIntensity = PAD_EMISSIVE.idle;

  /**
   * The rim, demoted.
   *
   * It used to carry the whole effect. Now it is a hairline of light escaping
   * around the base of the cap — the seam an LED well always leaks through —
   * and it is driven a little brighter and a little slower than the cap so the
   * pad reads as a lamp in a housing rather than as one flat plate.
   *
   * Its base colour stays near-black: this is a dark object whose only visible
   * contribution is emission.
   */
  const ledMaterial = new THREE.MeshStandardMaterial({
    color: 0x12151f,
    emissive: glow,
    emissiveIntensity: PAD_EMISSIVE.rimIdle,
    metalness: 0.0,
    roughness: 0.45,
  });

  const led = roundedBox(DIMS.ledSize, DIMS.ledH, DIMS.ledSize, DIMS.ledR, ledMaterial, false);
  led.position.y = DIMS.ledH / 2;
  group.add(led);

  const cap = roundedBox(DIMS.padSize, DIMS.padH, DIMS.padSize, DIMS.padR, capMaterial);
  cap.position.y = DIMS.ledH + DIMS.padH / 2;
  group.add(cap);

  // The key letter, screen-printed on the cap. Drawn on a plane rather than
  // baked into the cap's colour map, because the cap's UVs are a world-space
  // box projection shared with every other moulded part — good for grain,
  // useless for placing a glyph. It also has to sit on top of an emissive
  // surface without being lit by it, which is why it is a MeshBasicMaterial:
  // the printed legend on a backlit key is opaque ink and stays dark while the
  // plastic around it floods.
  if (label) {
    const print = new THREE.Mesh(
      new THREE.PlaneGeometry(DIMS.padSize * 0.6, DIMS.padSize * 0.6),
      new THREE.MeshBasicMaterial({
        map: glyphTexture(label),
        color: PALETTE.ink,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      })
    );
    print.rotation.x = -Math.PI / 2;
    print.position.y = DIMS.ledH + DIMS.padH + 0.0015;
    group.add(print);
  }

  // Everything a hit needs to touch, gathered up front so the per-frame update
  // never has to search the scene graph.
  return {
    id: padDef.id,
    label: padDef.label,
    group,
    cap,
    led,
    capMaterial,
    ledMaterial,
    restY: 0,
    press: 0,
    glow: 0,
  };
}

function buildKnob(label, materials) {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    roundedCylinderGeometry(DIMS.knobR, DIMS.knobH, DIMS.knobCorner, 40, 5),
    materials.slabDeep
  );
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // Pointer stripe, so rotation is legible at a glance. Sunk a hair into the
  // cap rather than floated on top, so it reads as inlaid.
  const indicator = roundedBox(0.006, 0.005, DIMS.knobR * 0.72, 0.0025, materials.accent, false);
  indicator.position.set(0, DIMS.knobH - 0.001, -DIMS.knobR * 0.40);
  group.add(indicator);

  return { label, group, value: 0.5 };
}

/**
 * One wing: the hinge group, the panel it swings, its knobs, and a barrel on
 * the hinge line so the axis is a visible part rather than an implied one.
 *
 * `side` is -1 for left, +1 for right. Everything mirrors off it, including
 * the direction the panel extends from its hinge — which is what makes the
 * sign of the rotation in hierarchy.js come out opposite on the two sides.
 */
function buildWing(side, knobLabels, materials) {
  const pivot = hinge(new THREE.Vector3(side * DIMS.slabW / 2, DIMS.slabT, 0));

  /**
   * The panel hangs so its TOP face is level with the hinge plane, which is
   * the bezel top. That is what "coplanar when open" means in geometry: not
   * that the wing's centre is at the bezel height, but that its working
   * surface is. Get this offset wrong by half a thickness and the control
   * surface has a visible step in it.
   */
  const panel = roundedBox(DIMS.wingW, DIMS.wingT, DIMS.slabD, DIMS.wingR, materials.slab);
  panel.position.set(side * DIMS.wingW / 2, -DIMS.wingT / 2, 0);
  pivot.add(panel);

  /**
   * A skin on the underside, in the darker tone.
   *
   * When the slab is shut this face is what the viewer sees — it is the lid.
   * Giving it its own material rather than letting it inherit whatever the top
   * happens to be is the difference between a designed exterior and the back
   * of a part.
   */
  const skin = roundedBox(
    DIMS.wingW * 0.92, 0.003, DIMS.slabD * 0.92, 0.0015, materials.slabDeep, false
  );
  skin.position.set(side * DIMS.wingW / 2, -DIMS.wingT - 0.0005, 0);
  pivot.add(skin);

  const barrel = new THREE.Mesh(
    roundedCylinderGeometry(DIMS.hingeBarrelR, DIMS.hingeBarrelL, 0.003, 20, 3),
    materials.mech
  );
  // The lathe runs up +Y; the hinge axis runs along +Z. Rotating the mesh
  // rather than generating a second geometry keeps one buffer for both barrels.
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, -DIMS.wingT / 2, -DIMS.hingeBarrelL / 2);
  barrel.castShadow = true;
  pivot.add(barrel);

  const knobs = knobLabels.map((label, i) => {
    const knob = buildKnob(label, materials);
    const span = (knobLabels.length - 1) * DIMS.knobPitch;
    // Centred across the wing's width, spaced along its depth, sitting on the
    // panel's top face — which is y = 0 in the pivot's frame, by construction.
    knob.group.position.set(
      side * DIMS.wingW / 2,
      0,
      i * DIMS.knobPitch - span / 2
    );
    pivot.add(knob.group);
    return knob;
  });

  return { pivot, panel, knobs };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Build the whole rig.
 *
 * Every joint is left at its identity transform, which here means the OPEN
 * pose — hinges are placed at their open position and unrotated. hierarchy.js
 * poses the skeleton before the first frame is drawn.
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

  const root = new THREE.Group();

  /**
   * The reparent point.
   *
   * Everything the mechanism owns hangs off this and nothing above it. If the
   * base is built later, `deck.add(slabRoot)` is the entire integration: the
   * slab rides the lift, the wings ride the slab, the knobs ride the wings,
   * and not one line inside this file changes. Designing for that now costs a
   * Group.
   */
  const slabRoot = new THREE.Group();
  root.add(slabRoot);

  // --- centre section ------------------------------------------------------
  //
  // Built as a base plate plus four bezel rails rather than one solid box with
  // a recess. Three.js has no CSG, so a "recess" made by placing a darker box
  // inside a larger one is simply invisible — the well has to be an actual
  // opening between actual walls.

  const centre = new THREE.Group();
  slabRoot.add(centre);

  const basePlate = roundedBox(
    DIMS.slabW, WELL_FLOOR_Y, DIMS.slabD, DIMS.slabR, materials.slab
  );
  basePlate.position.y = WELL_FLOOR_Y / 2;
  centre.add(basePlate);

  // The dark floor, sitting a hair above the base plate's top so there is no
  // coplanar z-fight between them.
  const wellFloor = roundedBox(
    DIMS.slabW - DIMS.wellInset * 2,
    0.002,
    DIMS.slabD - DIMS.wellInset * 2,
    0.001,
    materials.well,
    false
  );
  wellFloor.position.y = WELL_FLOOR_Y + 0.001;
  centre.add(wellFloor);

  // Four rails standing wellDepth proud of the floor, forming the bezel. The
  // front and back rails run the full width; the side rails fill what is left,
  // so the corners meet without overlapping geometry.
  const railY = WELL_FLOOR_Y + DIMS.wellDepth / 2;
  const sideRailD = DIMS.slabD - DIMS.wellInset * 2;

  for (const z of [-1, 1]) {
    const rail = roundedBox(
      DIMS.slabW, DIMS.wellDepth, DIMS.wellInset, DIMS.slabR * 0.5, materials.slab
    );
    rail.position.set(0, railY, z * (DIMS.slabD - DIMS.wellInset) / 2);
    centre.add(rail);
  }

  for (const x of [-1, 1]) {
    const rail = roundedBox(
      DIMS.wellInset, DIMS.wellDepth, sideRailD, DIMS.slabR * 0.5, materials.slab
    );
    rail.position.set(x * (DIMS.slabW - DIMS.wellInset) / 2, railY, 0);
    centre.add(rail);
  }

  // --- pad grid ------------------------------------------------------------

  const padGrid = new THREE.Group();
  padGrid.position.y = WELL_FLOOR_Y;
  centre.add(padGrid);

  const pads = [];
  const padById = new Map();
  const span = (4 - 1) * DIMS.padPitch;

  PADS.forEach((padDef, index) => {
    const row = Math.floor(index / 4);
    const col = index % 4;

    const pad = buildPad(padDef, materials, labelFor?.(padDef.id) ?? null);
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

  // --- wings ---------------------------------------------------------------
  //
  // Three knobs each, which is exactly the six parameters that already exist.
  // No new audio parameter, no new interaction path: interaction.js indexes
  // `rig.knobs` and this array is assembled to preserve that order.

  const wingLeft = buildWing(-1, ['Master volume', 'Master filter', 'Layer 1'], materials);
  const wingRight = buildWing(+1, ['Layer 2', 'Layer 3', 'Layer 4'], materials);

  slabRoot.add(wingLeft.pivot, wingRight.pivot);

  const knobs = [...wingLeft.knobs, ...wingRight.knobs];

  // -----------------------------------------------------------------------
  // Joints: everything hierarchy.js is allowed to touch.
  // -----------------------------------------------------------------------
  const joints = {
    slabRoot,
    centre,
    padGrid,
    wingLeftPivot: wingLeft.pivot,
    wingRightPivot: wingRight.pivot,
  };

  // -----------------------------------------------------------------------
  // Reacting to hits
  //
  // Subscribing to the bus rather than being called by audio.js is what keeps
  // the two halves independent. rig.js has no idea the sequencer exists.
  // -----------------------------------------------------------------------
  bus.on('pad:hit', ({ padId, velocity = 1 }) => {
    const pad = padById.get(padId);
    if (!pad) return;
    // Max, not assignment: a retrigger during a decay must not be allowed to
    // make a pad dimmer than it already is.
    pad.press = Math.max(pad.press, velocity);
    pad.glow = Math.max(pad.glow, velocity);
  });

  /**
   * Per-frame pad response.
   *
   * `press` decays exponentially rather than running a tween per hit. A tween
   * would have to be cancelled and restarted on every retrigger, and at
   * sixteenth notes on a fast tempo that is a lot of allocation for an effect
   * that is one number. Exponential decay also retriggers correctly for free:
   * setting press back to 1 mid-decay simply restarts the fall.
   *
   * There are now TWO decays, not one, and they are separate on purpose. The
   * cap is the diffuser and the rim is the housing the light leaks out of, so
   * the rim is held brighter and released slower. One shared value would make
   * the pad a single flat plate flashing; two make it an object with a lamp
   * inside it.
   *
   * `press` itself — the mechanical travel — still uses the cap's rate, because
   * the physical dip and the visual flash are the same event.
   */
  function update(dt) {
    const capDecay = Math.exp(-dt * PAD_EMISSIVE.capDecay);
    const rimDecay = Math.exp(-dt * PAD_EMISSIVE.rimDecay);

    for (const pad of pads) {
      // Idle short-circuit. Once both envelopes are under the threshold there
      // is nothing left to animate, so the pad is snapped to rest exactly once
      // and then skipped — sixteen pads times two materials times sixty frames
      // is a lot of pointless uniform writes on a stopped transport.
      if (pad.press < 0.001 && pad.glow < 0.001) {
        if (pad.press !== 0 || pad.glow !== 0) {
          pad.press = 0;
          pad.glow = 0;
          pad.group.position.y = pad.restY;
          pad.capMaterial.emissiveIntensity = PAD_EMISSIVE.idle;
          pad.ledMaterial.emissiveIntensity = PAD_EMISSIVE.rimIdle;
        }
        continue;
      }

      pad.press *= capDecay;
      pad.glow *= rimDecay;

      pad.group.position.y = pad.restY - pad.press * DIMS.padTravel;

      // Interpolating from idle to peak rather than adding to idle, so a
      // full-velocity hit lands on exactly `peak` regardless of what the idle
      // level is set to. Adding would make the two numbers interact, and every
      // future adjustment of the resting tint would quietly change how bright
      // a struck pad gets.
      pad.capMaterial.emissiveIntensity =
        PAD_EMISSIVE.idle + pad.press * (PAD_EMISSIVE.peak - PAD_EMISSIVE.idle);
      pad.ledMaterial.emissiveIntensity =
        PAD_EMISSIVE.rimIdle + pad.glow * (PAD_EMISSIVE.rimPeak - PAD_EMISSIVE.rimIdle);
    }
  }

  return { root, joints, pads, padById, knobs, materials, update };
}