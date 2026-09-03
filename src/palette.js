/**
  palette.js — the colour scheme, in one place.
*/

import * as THREE from 'three';

export const PALETTE = {
  // environment 
  skyTop: 0x2e3450,
  skyBottom: 0x0f1220,

  // The floor. Near-black and semi-gloss
  ground: 0x14161f,
  groundRim: 0x1c2030,

  // the slab 
  slab: 0x2b3145,       // the body and the bezel rails
  slabDeep: 0x232839,   // wing undersides: the exterior when the slab is shut
  well: 0x0c0f1a,       // the recessed floor the pads stand on, deepened
  mech: 0x8a94ab,       // hinge barrels: the only metal left in the rig
  ink: 0x1a1d2b,        // pad glyphs and anything that reads as printed
  accent: 0xffb257,     // knob indicators and small warm highlights

  /**
    Anodised aluminium for the bezel frame and the wing edge rails.
  */
  bezel: 0x6d7893,
  bezelDeep: 0x3d4459,  // the chamfer under it, in shadow

  // Soft buttons on the front band.
  button: 0x1b1f2c,
  buttonLit: 0x9fe8ff,
  buttonRec: 0xff5f52,

  // The display: near-black glass, phosphor green-cyan ink.
  screen: 0x07131a,
  screenInk: 0x6ff0d8,

  // the speaker stacks
  cab: 0x1b1f2c,        // the painted box
  cabFace: 0x252b3c,    // the baffle the grille is set into, a step lighter
  grille: 0x0b0d14,     // the cloth: the darkest thing in the scene
  standby: 0x5fe6a8,    // the power LED on each cabinet, always on

  // pads 
  padCap: 0xe9e6dd,

  // mascot
  mascotBody: 0xf0a63c,
  mascotShade: 0xcf8628,
  mascotMetal: 0xaab3ca,
  mascotDark: 0x3f4459,
  mascotLens: 0x171b28,
  mascotIris: 0x8fe3ff,   // resting eye glow; a hit repaints it to the pad hue
  stick: 0xecc9a0,
};

/**
  The hue a pad emits when it is lit, at constant perceived brightness.
*/

const PAD_SATURATION = 0.82;

/**
  Target relative luminance for every lit pad.
*/
const PAD_TARGET_LUMA = 0.60;

function relativeLuminance(colour) {
  return 0.2126 * colour.r + 0.7152 * colour.g + 0.0722 * colour.b;
}

const lightnessCache = new Map();

function solveLightness(hue) {
  if (lightnessCache.has(hue)) return lightnessCache.get(hue);

  const probe = new THREE.Color();
  let low = 0.15;
  let high = 0.97;

  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2;
    probe.setHSL(hue, PAD_SATURATION, mid);
    if (relativeLuminance(probe) < PAD_TARGET_LUMA) low = mid;
    else high = mid;
  }

  const solved = (low + high) / 2;
  lightnessCache.set(hue, solved);
  return solved;
}

export function padGlow(hue) {
  return new THREE.Color().setHSL(hue, PAD_SATURATION, solveLightness(hue));
}

export function padColour(hue, saturation = 0.60, lightness = 0.58) {
  return new THREE.Color().setHSL(hue, saturation, lightness);
}

/** `0xrrggbb` as the `#rrggbb` string the 2D canvas API wants. */
export function cssHex(hex) {
  return `#${hex.toString(16).padStart(6, '0')}`;
}