
/**
  rig.js — the slab: geometry, materials, and the joint skeleton.
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

// ----------
// Dimensions
// ----------


/** 
  The chain of dependencies
  gridSpan   = 3 * padPitch + padSize        = 0.384
  wellW      = gridSpan + 2 * wellMargin     = 0.404
  wellFloorY = slabT - wellDepth             = 0.034
  padTopY    = wellFloorY + ledH + padH      = 0.062  (2 mm proud of bezel)
  hingeClear = padTopY - slabT + tolerance   = 0.014
*/

const SLAB_W = 0.50;

const PAD_PITCH = 0.098;
const PAD_SIZE = 0.090;
const GRID_SPAN = 3 * PAD_PITCH + PAD_SIZE;

export const DIMS = {
  // centre section
  slabW: SLAB_W,
  slabD: 0.48,
  slabT: 0.060,
  slabR: 0.010,
  wellMargin: 0.010,   // clearance between the outermost pads and the well wall
  wellDepth: 0.014,
  wellZ: -0.028,       // the grid sits back, opening the front band
  bezelR: 0.004,
  chamfer: 0.005,      // the metal frame's visible thickness above the plastic

  // wings
  wingW: SLAB_W / 2,
  wingT: 0.034,
  wingR: 0.010,
  hingeClear: 0.014,
  hingeBarrelR: 0.008,
  hingeBarrelL: 0.052,

  // pads
  padPitch: PAD_PITCH,
  padSize: PAD_SIZE,
  padH: 0.014,
  padR: 0.004,
  ledSize: 0.096,
  ledH: 0.008,
  ledR: 0.002,
  padTravel: 0.006,

  // knobs
  knobR: 0.024,
  knobH: 0.022,
  knobCorner: 0.006,
  knobPitch: 0.132,
  collarSize: 0.086,

  // front band
  buttonW: 0.040,
  buttonD: 0.020,
  buttonH: 0.007,
  buttonR: 0.004,
};

DIMS.wellW = GRID_SPAN + DIMS.wellMargin * 2;
DIMS.wellD = DIMS.wellW;

/** Where the pad floor sits. Used here and by hierarchy.js's solver. */
export const WELL_FLOOR_Y = DIMS.slabT - DIMS.wellDepth;

export const PAD_EMISSIVE = {
  idle: 0.07,
  peak: 2.40,
  rimIdle: 0.22,
  rimPeak: 4.20,
  capDecay: 11,
  rimDecay: 7,
};

/**
  The six knobs, in the order interaction.js indexes them.
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
  The four soft buttons on the front band, left to right.
*/
export const BUTTONS = [
  { id: 'play', label: 'PLAY', name: 'Play / Stop', hint: 'Start and stop the sequencer · Space' },
  { id: 'rec', label: 'REC', name: 'Record arm', hint: 'Arm the next layer, then play pads to record' },
  { id: 'fold', label: 'FOLD', name: 'Fold', hint: 'Fold the wings over the pads · O' },
  { id: 'preset', label: 'KIT', name: 'Next pattern', hint: 'Load the next preset pattern' },
];

// ---------
// Materials
// ---------

function buildMaterials(anisotropy) {
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

  /** Wing undersides */
  const slabDeep = new THREE.MeshStandardMaterial({
    ...mouldedSet,
    color: PALETTE.slabDeep,
    metalness: 0.0,
    roughness: 0.58,
    normalScale: new THREE.Vector2(0.12, 0.12),
  });

  /**
    The recessed floor
  */
  const well = new THREE.MeshStandardMaterial({
    color: PALETTE.well,
    metalness: 0.0,
    roughness: 0.92,
  });

  /**
    The bezel frame: brushed anodised aluminium
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
    The cap material template cloned once per pad
  */
  const padCap = new THREE.MeshStandardMaterial({
    ...padSet,
    color: PALETTE.padCap,
    metalness: 0.0,
    roughness: 0.68,
    normalScale: new THREE.Vector2(0.4, 0.4),
  });

  /**
    Hinge barrels and knob skirts
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

// -------------
// Part builders
// -------------

function roundedBox(w, h, d, radius, material, castShadow = true) {
  const mesh = new THREE.Mesh(roundedBoxGeometry(w, h, d, radius), material);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  return mesh;
}

function hinge(position) {
  const group = new THREE.Group();
  group.position.copy(position);
  return group;
}

/**
  A silkscreen legend: white text on transparent, laid flat on a panel.
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
    The cap: a translucent diffuser with the LED behind it.
  */
  const capMaterial = materials.padCap.clone();
  capMaterial.emissive = glow;
  capMaterial.emissiveIntensity = PAD_EMISSIVE.idle;

  /**
    The light guide
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

  // The key letter, screen-printed on the cap
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
  One knob: a metal skirt, a rubber cap, an indicator, and a printed collar.
*/
function buildKnob(label, materials) {
  const group = new THREE.Group();

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
  One wing
*/
function buildWing(side, knobDefs, materials) {
  const pivot = hinge(new THREE.Vector3(side * DIMS.slabW / 2, DIMS.slabT, 0));

  const panel = roundedBox(DIMS.wingW, DIMS.wingT, DIMS.slabD, DIMS.wingR, materials.slab);
  panel.position.set(side * DIMS.wingW / 2, -DIMS.wingT / 2, 0);
  pivot.add(panel);

  const rail = roundedBox(
    0.014, DIMS.wingT * 0.86, DIMS.slabD * 0.97, 0.005, materials.bezel
  );
  rail.position.set(side * (DIMS.wingW - 0.007), -DIMS.wingT / 2, 0);
  pivot.add(rail);

  const skin = roundedBox(
    DIMS.wingW * 0.90, 0.003, DIMS.slabD * 0.92, 0.0015, materials.slabDeep, false
  );
  skin.position.set(side * DIMS.wingW / 2, -DIMS.wingT - 0.0005, 0);
  pivot.add(skin);

  const barrel = new THREE.Mesh(
    roundedCylinderGeometry(DIMS.hingeBarrelR, DIMS.hingeBarrelL, 0.003, 20, 3),
    materials.mech
  );
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, -DIMS.wingT / 2, -DIMS.hingeBarrelL / 2);
  barrel.castShadow = true;
  pivot.add(barrel);

  const knobs = knobDefs.map((def, i) => {
    const knob = buildKnob(def.label, materials);
    const span = (knobDefs.length - 1) * DIMS.knobPitch;
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

// --------
// Assembly
// --------

/**
  Build the whole rig.
  @param {{ anisotropy?: number, labelFor?: (padId: string) => string }} options
*/
export function buildRig({ anisotropy = 1, labelFor = null } = {}) {
  const materials = buildMaterials(anisotropy);

  const root = new THREE.Group();

  const slabRoot = new THREE.Group();
  root.add(slabRoot);

  const centre = new THREE.Group();
  slabRoot.add(centre);

  // body 
  const basePlate = roundedBox(
    DIMS.slabW, WELL_FLOOR_Y, DIMS.slabD, DIMS.slabR, materials.slab
  );
  basePlate.position.y = WELL_FLOOR_Y / 2;
  centre.add(basePlate);

  const wellFloor = roundedBox(
    DIMS.wellW, 0.002, DIMS.wellD, 0.001, materials.well, false
  );
  wellFloor.position.set(0, WELL_FLOOR_Y + 0.001, DIMS.wellZ);
  centre.add(wellFloor);

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

    const cap = roundedBox(
      Math.max(0.004, w - 0.006), DIMS.chamfer, Math.max(0.004, d - 0.006),
      DIMS.chamfer * 0.4, materials.bezel
    );
    cap.position.set(x, capY, z);
    centre.add(cap);
  }

  // the pad grid

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

  // the front band: soft buttons, display and brand

  const bandZ = wellZ1 + frontBand / 2;
  const bandY = DIMS.slabT;
  const buttons = [];
  const BUTTON_PITCH = 0.056;
  const BUTTON_X0 = -0.100;

  BUTTONS.forEach((def, i) => {
    const group = new THREE.Group();
    group.position.set(BUTTON_X0 + i * BUTTON_PITCH, bandY, bandZ - 0.011);
    centre.add(group);

    const material = materials.button.clone();
    if (def.id === 'rec') material.emissive = new THREE.Color(PALETTE.buttonRec);

    const cap = roundedBox(
      DIMS.buttonW, DIMS.buttonH, DIMS.buttonD, DIMS.buttonR, material
    );
    cap.position.y = DIMS.buttonH / 2;
    group.add(cap);

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

  const display = displayTexture();

  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(0.120, 0.034),
    new THREE.MeshBasicMaterial({ map: display.texture, toneMapped: false })
  );
  screen.rotation.x = -Math.PI / 2;
  screen.position.set(0.172, bandY + 0.0016, bandZ);
  centre.add(screen);

  const screenFrame = roundedBox(0.134, 0.005, 0.046, 0.003, materials.bezelDeep, false);
  screenFrame.position.set(0.172, bandY + 0.0006, bandZ);
  centre.add(screenFrame);

  const brand = legend(
    textTexture('DRUM RIG', { width: 512, height: 64, size: 34, tracking: 0.34 }),
    0.100, 0.013, PALETTE.bezel, 0.75
  );
  brand.position.set(-0.185, bandY + 0.0006, bandZ);
  centre.add(brand);

  // wings

  const wingLeft = buildWing(-1, KNOB_LAYOUT.slice(0, 3), materials);
  const wingRight = buildWing(+1, KNOB_LAYOUT.slice(3, 6), materials);

  slabRoot.add(wingLeft.pivot, wingRight.pivot);

  const knobs = [...wingLeft.knobs, ...wingRight.knobs];

  // ---------------------------------------------------
  // Joints: everything hierarchy.js is allowed to touch
  // ---------------------------------------------------
  const joints = {
    slabRoot,
    centre,
    padGrid,
    wingLeftPivot: wingLeft.pivot,
    wingRightPivot: wingRight.pivot,
  };

  // -----------------
  // The knob readout
  // -----------------

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
    knob.collar.draw(knob.value);
  }

  // -----------------------
  // Reacting to the machine
  // -----------------------

  const displayState = { bpm: 100, running: false, step: 0, armed: null, kit: '' };

  function redraw() {
    display.draw(displayState);
  }

  bus.on('pad:hit', ({ padId, velocity = 1 }) => {
    const pad = padById.get(padId);
    if (!pad) return;.
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
    Per-frame response.
  */
  function update(dt) {
    const capDecay = Math.exp(-dt * PAD_EMISSIVE.capDecay);
    const rimDecay = Math.exp(-dt * PAD_EMISSIVE.rimDecay);

    for (const pad of pads) {
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
      pad.capMaterial.emissiveIntensity =
        PAD_EMISSIVE.idle + pad.press * (PAD_EMISSIVE.peak - PAD_EMISSIVE.idle);
      pad.ledMaterial.emissiveIntensity =
        PAD_EMISSIVE.rimIdle + pad.glow * (PAD_EMISSIVE.rimPeak - PAD_EMISSIVE.rimIdle);
    }

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