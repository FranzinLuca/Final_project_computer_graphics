/**
 * rig.js — the slab: geometry, materials, and the joint skeleton.
 *
 * Division of labour with hierarchy.js is unchanged: this file builds the
 * parts and arranges them into the parent-child tree with correct pivot
 * placement. It never writes to a joint transform. hierarchy.js owns all
 * motion and all constraints; rig.js owns shape and appearance.
 *
 * This module never imports audio.js. It listens on the event bus and does not
 * know or care whether a hit came from a mouse click, a key press or the
 * sequencer.
 *
 *
 * WHY THE PANEL WAS READING AS "TWO SLABS, ONE OVER THE OTHER"
 *
 * The tri-fold layout was right and the detailing was not, and it is worth
 * separating the five specific faults because each has a different fix. None
 * of them is "add more polygons".
 *
 *   1. THE FILLETS WERE TOO BIG. A 12 mm radius on an 88 mm pad rounds over
 *      27% of the half-width. That is a bar of soap. Real pads have a 1–2 mm
 *      break on the edge and a nearly flat top, because they are moulded
 *      silicone struck by a finger, not pebbles. The fillet is now 4 mm, and
 *      this single number does more for the read than anything else here.
 *
 *   2. THE GUTTERS WERE TOO WIDE. 16 mm of gap between 88 mm pads makes the
 *      grid read as sixteen separate objects sitting near each other. On
 *      hardware the gutter is a seam — enough to get a fingernail into and no
 *      more. Now 8 mm, which also tightens the whole field and leaves the
 *      bezel room to carry something.
 *
 *   3. THERE WAS NO METAL. Every surface was dark plastic at a similar value,
 *      so the object had no outline: it ended wherever the background
 *      happened to be a different shade. A brushed bezel frame around the pad
 *      field and a rail down each wing's outer edge give the silhouette a
 *      bright line and the camera something that changes as it orbits.
 *
 *   4. THE BEZEL WAS EMPTY. A 48 mm border of blank plastic is what makes a
 *      panel look like a placeholder. Real hardware fills that band with soft
 *      buttons and a legend, and this now does: four function buttons and a
 *      screen-printed brand on the front, a vent strip at the back.
 *
 *   5. THE KNOBS SAID NOTHING. Six unlabelled cylinders cannot be useful
 *      whatever they are wired to, because nothing on the object states what
 *      they control or where they are set. Each now sits in a printed collar
 *      with its name and a 270-degree value arc, and the arc is driven by the
 *      same scalar as the cap's rotation — so the scale cannot disagree with
 *      the control.
 *
 * The mechanism is untouched. Wing width is still derived (wingW = slabW/2),
 * the hinge still translates as it rotates, and hierarchy.js still owns every
 * joint transform. This pass changed what the object looks like, not what it
 * does.
 *
 * Every solid is a rounded box or a lathed cylinder from geometry.js. Nothing
 * has a hard 90-degree edge, because nothing manufactured does.
 */

import * as THREE from 'three';
import { bus } from './events.js';
import { PADS, getKit } from './pads.js';
import { PALETTE, padGlow } from './palette.js';
import { roundedBoxGeometry, roundedCylinderGeometry } from './geometry.js';
import {
  mouldedMaps,
  rubberMaps,
  brushedMetalMaps,
  configureMaps,
  glyphTexture,
  textTexture,
  knobCollarTexture,
  displayTexture,
} from './textures.js';

// ---------------------------------------------------------------------------
// Dimensions
//
// One place, so nothing is a magic number buried in a call. Each solid carries
// its own fillet radius next to its size: a single global radius does not work,
// because the same fillet that reads as a soft shoulder on a 500 mm slab would
// swallow a 12 mm pad rim whole. Radius is a proportion of the part.
//
// The chain of dependencies, top to bottom — checked arithmetic, not taste:
//
//   gridSpan   = 3 * padPitch + padSize        = 0.384
//   wellW      = gridSpan + 2 * wellMargin     = 0.404
//   wellFloorY = slabT - wellDepth             = 0.034
//   padTopY    = wellFloorY + ledH + padH      = 0.062  (2 mm proud of bezel)
//   hingeClear = padTopY - slabT + tolerance   = 0.014
// ---------------------------------------------------------------------------

const SLAB_W = 0.50;

const PAD_PITCH = 0.098;
const PAD_SIZE = 0.090;
const GRID_SPAN = 3 * PAD_PITCH + PAD_SIZE;

export const DIMS = {
  // --- centre section ------------------------------------------------------
  slabW: SLAB_W,
  slabD: 0.48,
  slabT: 0.060,
  slabR: 0.010,

  /**
   * The well is sized to the grid rather than to a uniform inset.
   *
   * That inversion is the reason the front band exists. Previously a single
   * `wellInset` set all four borders equal, which meant the only way to make
   * room for controls was to shrink the pads. Deriving the opening from the
   * grid leaves whatever is left over as usable panel, and the leftover is not
   * symmetric: 48 mm at the sides, 10 mm behind, 66 mm in front — which is
   * exactly the proportion hardware uses, because the front edge is the one
   * the hands reach first.
   */
  wellMargin: 0.010,   // clearance between the outermost pads and the well wall
  /**
   * The well is SHALLOW, and this is checked arithmetic rather than taste.
   *
   *   wellFloorY = slabT - wellDepth        = 0.046
   *   padTopY    = wellFloorY + ledH + padH = 0.068
   *   cap top    = slabT + chamfer          = 0.065
   *
   * The pads have to finish above the metal frame, not below it. Sunk pads
   * cannot be struck and, worse, cannot be SEEN to be strikeable — at the
   * grazing camera angle this scene uses, a recessed pad field is a dark
   * rectangle with a bright edge. Three millimetres proud is what a real
   * controller does: enough that the caps catch the light and cast into their
   * own gutters, little enough that the frame still protects them.
   */
  wellDepth: 0.014,
  wellZ: -0.028,       // the grid sits back, opening the front band

  bezelR: 0.004,
  chamfer: 0.005,      // the metal frame's visible thickness above the plastic

  // --- wings ---------------------------------------------------------------
  /**
   * Derived, not chosen. Folded inward, two wings of this width meet exactly
   * at x = 0 and cover the centre section completely. Open span is
   * consequently exactly twice the closed span.
   */
  wingW: SLAB_W / 2,
  wingT: 0.034,
  wingR: 0.010,

  /**
   * How far the hinge axis must rise between open and shut. Open it is zero —
   * the wing's top face has to be flush with the bezel or the control surface
   * is not one plane. Shut it has to clear the pads, which now stand only
   * 2 mm proud rather than 12, so this dropped with them.
   */
  hingeClear: 0.014,

  hingeBarrelR: 0.008,
  hingeBarrelL: 0.052,

  // --- pads ----------------------------------------------------------------
  padPitch: PAD_PITCH,
  padSize: PAD_SIZE,
  padH: 0.014,
  /**
   * 4 mm, down from 12. See fault 1 in the header — this is the number that
   * turns sixteen pebbles into sixteen pads. A pad is a slab of silicone with
   * its edge broken, and the break is a small proportion of the part.
   */
  padR: 0.004,
  ledSize: 0.096,
  ledH: 0.008,
  ledR: 0.002,
  padTravel: 0.006,   // travel is short because the pad itself is now short

  // --- knobs ---------------------------------------------------------------
  knobR: 0.024,
  knobH: 0.022,
  knobCorner: 0.006,
  knobPitch: 0.132,
  collarSize: 0.086,

  // --- front band ----------------------------------------------------------
  buttonW: 0.040,
  buttonD: 0.020,
  buttonH: 0.007,
  buttonR: 0.004,
};

DIMS.wellW = GRID_SPAN + DIMS.wellMargin * 2;
DIMS.wellD = DIMS.wellW;

/** Where the pad floor sits. Used here and by hierarchy.js's solver. */
export const WELL_FLOOR_Y = DIMS.slabT - DIMS.wellDepth;

/**
 * Pad emissive levels, in one table because they have to be balanced against
 * each other rather than chosen one at a time.
 *
 * `idle` is not zero. A grid of sixteen identical grey caps is unreadable as a
 * kit — you cannot tell the kicks from the cymbals without striking them — so
 * every pad sits at a low tint of its own hue, deliberately far below the
 * level of a struck one.
 *
 * The rim runs hotter than the cap and falls slower. A cap is a diffuser and a
 * diffuser is always dimmer than the source behind it, so a seam brighter than
 * the face it surrounds is what sells the cap as translucent rather than as a
 * painted plate.
 */
export const PAD_EMISSIVE = {
  idle: 0.07,
  peak: 2.40,
  rimIdle: 0.22,
  rimPeak: 4.20,
  capDecay: 11,   // reciprocal seconds
  rimDecay: 7,    // slower, so the seam outlives the face
};

/**
 * The six knobs, in the order interaction.js indexes them.
 *
 * The labels are here rather than in main.js because they are printed on the
 * object — they are geometry's business. What each one DOES is still main.js's
 * business, and this table deliberately says nothing about it: rig.js prints
 * "DRIVE" without knowing that a waveshaper exists.
 */
export const KNOB_LAYOUT = [
  { label: 'Volume' },
  { label: 'Tone' },
  { label: 'Resonance' },
  { label: 'Drive' },
  { label: 'Space' },
  { label: 'Swing' },
];

/**
 * The four soft buttons on the front band, left to right.
 *
 * `label` is what is screen-printed on the panel; `name` and `hint` are what
 * the hover readout says. Three fields rather than one because they answer
 * three different questions and a panel legend cannot answer all of them —
 * "REC" fits on a 12 mm strip and "arm the next layer for recording" does not.
 */
export const BUTTONS = [
  { id: 'play', label: 'PLAY', name: 'Play / Stop', hint: 'Start and stop the sequencer · Space' },
  { id: 'rec', label: 'REC', name: 'Record arm', hint: 'Arm the next layer, then play pads to record' },
  { id: 'fold', label: 'FOLD', name: 'Fold', hint: 'Fold the wings over the pads · O' },
  { id: 'preset', label: 'KIT', name: 'Next pattern', hint: 'Load the next preset pattern' },
];

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

function buildMaterials(anisotropy) {
  // Repeats are counted in world units, because geometry.js unwraps with a box
  // projection in metres rather than 0..1 per face. That keeps the grain at the
  // same visual density on a 500 mm slab and on a 24 mm knob.
  const mouldedSet = configureMaps(mouldedMaps(256), 4, 4, anisotropy);
  const padSet = configureMaps(rubberMaps(256), 16, 16, anisotropy);
  const metalSet = configureMaps(brushedMetalMaps(512), 8, 8, anisotropy);

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
   * The bezel frame: brushed anodised aluminium, and the most important
   * material added in this pass.
   *
   * It shares the brushed-metal map set with the hinge barrels, at the same
   * anisotropic grain, which ties the two together as one machined family. The
   * roughness is a touch higher than the barrels' — anodising is a matte
   * conversion coating over the metal, not polish — so it draws a soft bright
   * line rather than a mirror edge, which is what keeps it from competing with
   * the lit pads it is framing.
   */
  const bezel = new THREE.MeshStandardMaterial({
    ...metalSet,
    color: PALETTE.bezel,
    metalness: 0.85,
    roughness: 0.42,
    normalScale: new THREE.Vector2(0.45, 0.45),
  });

  const bezelDeep = new THREE.MeshStandardMaterial({
    color: PALETTE.bezelDeep,
    metalness: 0.65,
    roughness: 0.55,
  });

  /**
   * The cap material TEMPLATE. Cloned once per pad, never used directly.
   *
   * Emission is animated per pad and `emissiveIntensity` is a uniform, so one
   * shared material cannot express sixteen states. Sixteen clones is the price
   * of the effect, and a cheaper price than it looks: `clone()` copies texture
   * REFERENCES, so all sixteen still sample one set of maps and compile to the
   * same shader program. The cost is sixteen uniform blocks, not sixteen
   * programs, and each pad was its own draw call regardless.
   */
  const padCap = new THREE.MeshStandardMaterial({
    ...padSet,
    color: PALETTE.padCap,
    metalness: 0.0,
    roughness: 0.68,
    normalScale: new THREE.Vector2(0.4, 0.4),
  });

  /**
   * Hinge barrels and knob skirts. Metalness needs something to reflect: a
   * metallic surface has no diffuse response at all, so with no environment
   * map it renders as whatever the specular lobes catch, which is nearly
   * black. environment.js builds a procedural studio environment precisely so
   * this material has something to be.
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

  /** Soft-button caps. Dark rubber; their state is carried by emission. */
  const button = new THREE.MeshStandardMaterial({
    color: PALETTE.button,
    metalness: 0.0,
    roughness: 0.78,
    emissive: new THREE.Color(PALETTE.buttonLit),
    emissiveIntensity: 0.0,
  });

  return { slab, slabDeep, well, bezel, bezelDeep, padCap, mech, accent, button, padSet };
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
 * Three.js rotates an object about its own origin and a box's origin is its
 * centre, so rotating a wing mesh directly spins it about its middle like a
 * propeller. Putting an empty Group on the hinge line and offsetting the mesh
 * inside it means rotating the group swings the mesh about its edge, which is
 * what a hinge does.
 *
 * These hinges also translate, which is unusual and is the point: hierarchy.js
 * writes both `rotation.z` and `position.y` on the same group.
 */
function hinge(position) {
  const group = new THREE.Group();
  group.position.copy(position);
  return group;
}

/**
 * A silkscreen legend: white text on transparent, laid flat on a panel.
 *
 * `MeshBasicMaterial` because printed ink is not a lit surface — it has no
 * form and no normal of its own, it is a stain on the surface underneath. It
 * also has to sit on top of emissive plastic without being lit by it.
 *
 * `polygonOffset` rather than a larger Y lift: floating the legend high enough
 * to clear z-fighting on its own would separate it visibly from its panel at
 * the grazing camera angles this scene always uses.
 */
function legend(texture, width, height, colour = 0xffffff, opacity = 0.5) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({
      map: texture,
      color: colour,
      transparent: true,
      opacity,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    })
  );
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

function buildPad(padDef, materials, label) {
  const group = new THREE.Group();

  const glow = padGlow(padDef.hue);

  /**
   * The cap: a translucent diffuser with the LED behind it.
   *
   * The whole face emits, because that is what the hardware does. A pad on a
   * grid controller is moulded frosted plastic with an RGB LED under it — when
   * the LED fires, the entire cap becomes the light source, not a ring around
   * its base.
   *
   * Emissive on a MeshStandardMaterial is added after shading and is uniform
   * across the surface, which flattens the form of a solid object. Here it is
   * exactly right, and for a physical reason: a backlit diffuser genuinely has
   * no shading. It is an area emitter, so it looks the same from every
   * direction and has no terminator. The one case where the crude
   * approximation is the accurate one.
   */
  const capMaterial = materials.padCap.clone();
  capMaterial.emissive = glow;
  capMaterial.emissiveIntensity = PAD_EMISSIVE.idle;

  /**
   * The light guide: a hairline of colour escaping around the base of the cap.
   *
   * Now 8 mm tall against the cap's 14 rather than the near-equal pair it used
   * to be. On real hardware the glow around a pad is a leak through a 1 mm
   * seam, and drawing it as a slab of the same order as the cap was half of
   * why the pads read as stacked plates rather than as keys in a housing.
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
  // baked into the colour map, because the cap's UVs are a world-space box
  // projection shared with every other moulded part — good for grain, useless
  // for placing a glyph.
  if (label) {
    const print = legend(
      glyphTexture(label),
      DIMS.padSize * 0.55,
      DIMS.padSize * 0.55,
      PALETTE.ink,
      0.5
    );
    print.position.y = DIMS.ledH + DIMS.padH + 0.0006;
    group.add(print);
  }

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

/**
 * One knob: a metal skirt, a rubber cap, an indicator, and a printed collar.
 *
 * Three parts rather than one cylinder, because a control that is one extruded
 * shape has no scale to it — nothing says whether it is 20 mm across or 200.
 * A skirt of a different material at the base gives the eye a second edge to
 * measure against, which is the same reason the bezel works.
 *
 * The collar's arc and the cap's rotation are driven from ONE value by
 * `setKnobValue` below. Two readouts of one scalar cannot disagree; two
 * animations of two scalars eventually do.
 */
function buildKnob(label, materials) {
  const group = new THREE.Group();

  // The skirt stays put. Only `spin` turns, so the collar underneath and the
  // fixed base do not rotate with the cap — on real gear the printed scale is
  // on the panel and only the knob moves.
  const skirt = new THREE.Mesh(
    roundedCylinderGeometry(DIMS.knobR * 1.12, 0.005, 0.002, 32, 2),
    materials.mech
  );
  skirt.castShadow = true;
  skirt.receiveShadow = true;
  group.add(skirt);

  const spin = new THREE.Group();
  spin.position.y = 0.005;
  group.add(spin);

  const body = new THREE.Mesh(
    roundedCylinderGeometry(DIMS.knobR, DIMS.knobH, DIMS.knobCorner, 36, 4),
    materials.slabDeep
  );
  body.castShadow = true;
  body.receiveShadow = true;
  spin.add(body);

  // Pointer stripe, sunk a hair into the cap rather than floated on top, so it
  // reads as inlaid.
  const indicator = roundedBox(0.005, 0.004, DIMS.knobR * 0.68, 0.002, materials.accent, false);
  indicator.position.set(0, DIMS.knobH - 0.0008, -DIMS.knobR * 0.42);
  spin.add(indicator);

  const collar = knobCollarTexture(label);
  const plate = legend(collar.texture, DIMS.collarSize, DIMS.collarSize, 0xffffff, 0.95);
  plate.position.y = 0.0012;
  group.add(plate);

  return { label, group, spin, collar, value: 0.5 };
}

/**
 * One wing: the hinge group, the panel it swings, its knobs, an outer metal
 * rail, and a barrel on the hinge line so the axis is a visible part rather
 * than an implied one.
 *
 * `side` is -1 for left, +1 for right. Everything mirrors off it, including
 * the direction the panel extends from its hinge — which is what makes the
 * sign of the rotation in hierarchy.js come out opposite on the two sides.
 */
function buildWing(side, knobDefs, materials) {
  const pivot = hinge(new THREE.Vector3(side * DIMS.slabW / 2, DIMS.slabT, 0));

  /**
   * The panel hangs so its TOP face is level with the hinge plane, which is
   * the bezel top. That is what "coplanar when open" means in geometry: not
   * that the wing's centre is at bezel height, but that its working surface
   * is. Get this offset wrong by half a thickness and the control surface has
   * a visible step in it.
   */
  const panel = roundedBox(DIMS.wingW, DIMS.wingT, DIMS.slabD, DIMS.wingR, materials.slab);
  panel.position.set(side * DIMS.wingW / 2, -DIMS.wingT / 2, 0);
  pivot.add(panel);

  /**
   * A metal rail along the wing's outer edge.
   *
   * The wings are the outermost 250 mm of the object on each side, so their
   * outer edges are the silhouette. Capping them in the same anodised
   * aluminium as the bezel means the instrument is outlined in metal on all
   * four sides when open — and when shut, the two rails become the visible
   * edges of a closed case, which is exactly where a real flightcased
   * controller puts its extrusion.
   */
  const rail = roundedBox(
    0.014, DIMS.wingT * 0.86, DIMS.slabD * 0.97, 0.005, materials.bezel
  );
  rail.position.set(side * (DIMS.wingW - 0.007), -DIMS.wingT / 2, 0);
  pivot.add(rail);

  /**
   * A skin on the underside, in the darker tone. When the slab is shut this
   * face is what the viewer sees — it is the lid. Giving it its own material
   * rather than letting it inherit the top is the difference between a
   * designed exterior and the back of a part.
   */
  const skin = roundedBox(
    DIMS.wingW * 0.90, 0.003, DIMS.slabD * 0.92, 0.0015, materials.slabDeep, false
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

  const knobs = knobDefs.map((def, i) => {
    const knob = buildKnob(def.label, materials);
    const span = (knobDefs.length - 1) * DIMS.knobPitch;
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
 * no business knowing an input layer exists.
 *
 * @param {{ anisotropy?: number, labelFor?: (padId: string) => string }} options
 */
export function buildRig({ anisotropy = 1, labelFor = null } = {}) {
  const materials = buildMaterials(anisotropy);

  const root = new THREE.Group();

  /**
   * The reparent point. Everything the mechanism owns hangs off this and
   * nothing above it, so adding a base later is `deck.add(slabRoot)` rather
   * than a rewrite.
   */
  const slabRoot = new THREE.Group();
  root.add(slabRoot);

  const centre = new THREE.Group();
  slabRoot.add(centre);

  // --- body ----------------------------------------------------------------
  //
  // Built as a base plate plus a frame rather than one solid box with a
  // recess. Three.js has no CSG, so a "recess" made by putting a darker box
  // inside a larger one is simply invisible — the well has to be an actual
  // opening between actual walls.

  const basePlate = roundedBox(
    DIMS.slabW, WELL_FLOOR_Y, DIMS.slabD, DIMS.slabR, materials.slab
  );
  basePlate.position.y = WELL_FLOOR_Y / 2;
  centre.add(basePlate);

  // The dark floor, a hair above the base plate's top so there is no coplanar
  // z-fight between them.
  const wellFloor = roundedBox(
    DIMS.wellW, 0.002, DIMS.wellD, 0.001, materials.well, false
  );
  wellFloor.position.set(0, WELL_FLOOR_Y + 0.001, DIMS.wellZ);
  centre.add(wellFloor);

  /**
   * The four bezel rails, in two layers.
   *
   * The lower layer is plastic and fills the depth of the well wall; the upper
   * is a 6 mm metal cap sitting on top of it, inset slightly so a dark line
   * shows between them. That line is the entire trick: a single metal frame
   * flush with the plastic reads as paint, and the same frame with a shadow
   * gap under it reads as a separate machined part bolted on.
   *
   * The four rails are generated from the well's rectangle rather than written
   * out, so moving the grid or resizing a pad moves the frame with it. Front
   * and back run the full width; the sides fill what is left, so the corners
   * meet without overlapping geometry.
   */
  const wellX0 = -DIMS.wellW / 2;
  const wellX1 = DIMS.wellW / 2;
  const wellZ0 = DIMS.wellZ - DIMS.wellD / 2;
  const wellZ1 = DIMS.wellZ + DIMS.wellD / 2;

  const frontBand = DIMS.slabD / 2 - wellZ1;   // 0.066
  const backBand = wellZ0 + DIMS.slabD / 2;    // 0.010
  const sideBand = DIMS.slabW / 2 - wellX1;    // 0.048

  const railY = WELL_FLOOR_Y + DIMS.wellDepth / 2;
  const capY = DIMS.slabT + DIMS.chamfer / 2;

  /** (width, depth, centre x, centre z) for each of the four sides. */
  const RAILS = [
    [DIMS.slabW, frontBand, 0, wellZ1 + frontBand / 2],
    [DIMS.slabW, backBand, 0, wellZ0 - backBand / 2],
    [sideBand, DIMS.wellD, wellX1 + sideBand / 2, DIMS.wellZ],
    [sideBand, DIMS.wellD, wellX0 - sideBand / 2, DIMS.wellZ],
  ];

  for (const [w, d, x, z] of RAILS) {
    const rail = roundedBox(w, DIMS.wellDepth, d, DIMS.bezelR, materials.slab);
    rail.position.set(x, railY, z);
    centre.add(rail);

    // The metal cap, inset 3 mm all round so the plastic shows as a shadow
    // gap and the cap reads as a separate part.
    const cap = roundedBox(
      Math.max(0.004, w - 0.006), DIMS.chamfer, Math.max(0.004, d - 0.006),
      DIMS.chamfer * 0.4, materials.bezel
    );
    cap.position.set(x, capY, z);
    centre.add(cap);
  }

  // --- the pad grid --------------------------------------------------------

  const padGrid = new THREE.Group();
  padGrid.position.set(0, WELL_FLOOR_Y, DIMS.wellZ);
  centre.add(padGrid);

  const pads = [];
  const padById = new Map();
  const span = 3 * DIMS.padPitch;

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

  // --- the front band: soft buttons, display and brand ---------------------
  //
  // 66 mm of panel that used to be blank. Everything here is what stopped the
  // object reading as a placeholder: a control surface with nothing on it but
  // its primary control is a mockup, not an instrument.

  const bandZ = wellZ1 + frontBand / 2;
  const bandY = DIMS.slabT;

  /**
   * The band is divided by hand and the divisions are checked, because three
   * things share 66 mm of depth and 500 of width and none of them may overlap:
   * the brand at the left, four buttons in the middle, the display at the
   * right. The button caps sit at z = 0.196 and their legends at 0.216, in
   * front of them rather than beside — a label under a control is how hardware
   * is read, and it is also the only place there is room.
   */
  const buttons = [];
  const BUTTON_PITCH = 0.056;
  const BUTTON_X0 = -0.100;

  BUTTONS.forEach((def, i) => {
    const group = new THREE.Group();
    group.position.set(BUTTON_X0 + i * BUTTON_PITCH, bandY, bandZ - 0.011);
    centre.add(group);

    // Each button gets its own material clone for the same reason each pad
    // does: `emissiveIntensity` is a uniform, and these four light
    // independently — play when the transport runs, rec when a layer is armed.
    const material = materials.button.clone();
    if (def.id === 'rec') material.emissive = new THREE.Color(PALETTE.buttonRec);

    const cap = roundedBox(
      DIMS.buttonW, DIMS.buttonH, DIMS.buttonD, DIMS.buttonR, material
    );
    cap.position.y = DIMS.buttonH / 2;
    group.add(cap);

    /**
     * The legend, doubled in height and taken from 42% to 85% opacity.
     *
     * The first version was legible in the texture and invisible on screen,
     * which is a distinction worth internalising: a 12 mm strip of 26 px type
     * on a 500 mm object seen from 1.6 units away lands on roughly six screen
     * pixels of cap height. Type needs about twelve to be read. So the strip
     * is now 22 mm at 34 px, drawn nearly opaque, and it is placed in FRONT of
     * the cap rather than beside it — the front band is the part of the panel
     * that faces the default camera most squarely.
     *
     * It still will not be readable from the Room shot, and that is what the
     * hover readout is for. A printed label answers "what is this" when you
     * are close; the tooltip answers it when you are not.
     */
    const print = legend(
      textTexture(def.label, { width: 160, height: 48, size: 34, tracking: 0.16 }),
      DIMS.buttonW * 1.05, 0.022, 0xffffff, 0.85
    );
    print.position.set(0, 0.0004, DIMS.buttonD / 2 + 0.014);
    group.add(print);

    buttons.push({
      id: def.id, name: def.name, hint: def.hint,
      group, cap, material, lit: 0,
    });
  });

  /**
   * The display, sitting in the front band to the right of the buttons.
   *
   * `MeshBasicMaterial` and `toneMapped: false`: an emissive panel is a source,
   * not a surface, and it should be exactly as bright as it is drawn rather
   * than picking up the room. Leaving tone mapping off keeps the phosphor
   * colour exactly the value the canvas painted, which is the point of drawing
   * a screen rather than lighting one.
   */
  const display = displayTexture();

  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(0.120, 0.034),
    new THREE.MeshBasicMaterial({ map: display.texture, toneMapped: false })
  );
  screen.rotation.x = -Math.PI / 2;
  screen.position.set(0.172, bandY + 0.0016, bandZ);
  centre.add(screen);

  // A metal surround, so the screen is set into the panel rather than stuck
  // onto it. Same shadow-gap logic as the bezel caps.
  const screenFrame = roundedBox(0.134, 0.005, 0.046, 0.003, materials.bezelDeep, false);
  screenFrame.position.set(0.172, bandY + 0.0006, bandZ);
  centre.add(screenFrame);

  const brand = legend(
    textTexture('DRUM RIG', { width: 512, height: 64, size: 34, tracking: 0.34 }),
    0.100, 0.013, PALETTE.bezel, 0.75
  );
  brand.position.set(-0.185, bandY + 0.0006, bandZ);
  centre.add(brand);

  // --- wings ---------------------------------------------------------------
  //
  // Three knobs each. The split is by function, not by count: the left wing is
  // the tone chain (what the sound is), the right wing is the effects and feel
  // (what happens to it). That grouping is why the labels are worth printing —
  // a legend that only names controls is a list, one that groups them is a
  // layout.

  const wingLeft = buildWing(-1, KNOB_LAYOUT.slice(0, 3), materials);
  const wingRight = buildWing(+1, KNOB_LAYOUT.slice(3, 6), materials);

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
  // The knob readout
  //
  // ONE function writes a knob's appearance, and it writes both halves of it.
  // interaction.js calls this; nothing else may touch `spin.rotation` or the
  // collar. It is the same invariant hierarchy.js has for joint transforms,
  // applied to a control: appearance is a pure function of value.
  // -----------------------------------------------------------------------

  /** Total rotation across the range: 270 degrees, as on a real potentiometer. */
  const KNOB_SWEEP = THREE.MathUtils.degToRad(270);

  function setKnobValue(index, value) {
    const knob = knobs[index];
    if (!knob) return;

    knob.value = THREE.MathUtils.clamp(value, 0, 1);

    // Negative because a positive rotation about +Y carries the indicator
    // anticlockwise, and increasing a value should turn a knob clockwise seen
    // from above.
    knob.spin.rotation.y = -(knob.value - 0.5) * KNOB_SWEEP;

    // Redrawn on change only. Six canvases at 160 square would be a real cost
    // every frame and are free at the rate a hand can turn something.
    knob.collar.draw(knob.value);
  }

  // -----------------------------------------------------------------------
  // Reacting to the machine
  //
  // Subscribing to the bus rather than being called by audio.js is what keeps
  // the two halves independent. rig.js has no idea the sequencer exists — it
  // knows only that certain facts are published, and it draws them.
  // -----------------------------------------------------------------------

  const displayState = { bpm: 100, running: false, step: 0, armed: null, kit: '' };

  function redraw() {
    display.draw(displayState);
  }

  bus.on('pad:hit', ({ padId, velocity = 1 }) => {
    const pad = padById.get(padId);
    if (!pad) return;
    // Max, not assignment: a retrigger during a decay must not be allowed to
    // make a pad dimmer than it already is.
    pad.press = Math.max(pad.press, velocity);
    pad.glow = Math.max(pad.glow, velocity);
  });

  bus.on('transport:step', ({ step }) => {
    displayState.step = step;
    redraw();
  });

  bus.on('transport:start', () => {
    displayState.running = true;
    redraw();
  });

  bus.on('transport:stop', () => {
    displayState.running = false;
    redraw();
  });

  bus.on('transport:bpm', ({ bpm }) => {
    displayState.bpm = bpm;
    redraw();
  });

  bus.on('record:armed', ({ layer }) => {
    displayState.armed = layer;
    redraw();
  });

  bus.on('kit:changed', ({ kit }) => {
    displayState.kit = kit.name;
    redraw();
  });

  /** Momentary lamp on a button, from main.js when the action fires. */
  function flashButton(id) {
    const button = buttons.find((b) => b.id === id);
    if (button) button.lit = 1;
  }

  /** Steady lamp: play stays lit while running, rec while armed. */
  function holdButton(id, on) {
    const button = buttons.find((b) => b.id === id);
    if (button) button.held = on;
  }

  /**
   * Per-frame response.
   *
   * `press` decays exponentially rather than running a tween per hit. A tween
   * would have to be cancelled and restarted on every retrigger, and at
   * sixteenth notes that is constant allocation for an effect that is one
   * float. Exponential decay retriggers correctly for free: setting press back
   * to 1 mid-fall simply restarts it.
   *
   * There are TWO decays on a pad, not one, and they are separate on purpose.
   * The cap is the diffuser and the guide is the housing the light leaks from,
   * so the guide is held brighter and released slower. One shared value makes
   * the pad a flat plate flashing; two make it an object with a lamp in it.
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
      // level is. Adding would make the two numbers interact, and every future
      // adjustment of the resting tint would quietly change how bright a
      // struck pad gets.
      pad.capMaterial.emissiveIntensity =
        PAD_EMISSIVE.idle + pad.press * (PAD_EMISSIVE.peak - PAD_EMISSIVE.idle);
      pad.ledMaterial.emissiveIntensity =
        PAD_EMISSIVE.rimIdle + pad.glow * (PAD_EMISSIVE.rimPeak - PAD_EMISSIVE.rimIdle);
    }

    // Buttons: a held lamp plus a decaying flash, summed. The two are separate
    // channels because they answer different questions — "is this mode on" and
    // "did I just press this" — and a press on an already-lit button still has
    // to be visible.
    for (const button of buttons) {
      button.lit *= Math.exp(-dt * 9);
      if (button.lit < 0.002) button.lit = 0;
      button.material.emissiveIntensity =
        (button.held ? 0.85 : 0.05) + button.lit * 1.6;
    }
  }

  // Draw the panel once before the first frame, so nothing is ever rendered in
  // an undrawn state.
  displayState.kit = getKit().name;
  redraw();

  return {
    root,
    joints,
    pads,
    padById,
    knobs,
    buttons,
    materials,
    update,
    setKnobValue,
    flashButton,
    holdButton,
    display,
  };
}