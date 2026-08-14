/**
 * palette.js — the colour scheme, in one place.
 *
 * The art direction is a soft-toy version of studio hardware: a warm off-white
 * shell, saturated but slightly desaturated pad colours, and a cool blue-grey
 * backdrop for them to sit against. Warm object on a cool ground is the oldest
 * trick there is for making a thing look like it was photographed rather than
 * rendered, and it costs nothing.
 *
 * This module exists so that the backdrop, the ground, the lights and the
 * hardware cannot drift apart. Anything that picks a colour imports it from
 * here; nothing hard-codes a hex value at the point of use. It imports only
 * three, exactly like pads.js imports nothing — leaf modules, no cycles.
 */

import * as THREE from 'three';

export const PALETTE = {
  // --- environment ---------------------------------------------------------
  skyTop: 0xa2aed0,
  skyBottom: 0x59648a,
  ground: 0x6c7799,
  groundRim: 0x7f8aab,

  // --- hardware ------------------------------------------------------------
  shell: 0xf6f1e7,      // the case: warm off-white, never pure white
  shellDeep: 0xe4ddcd,  // lid and wings, a shade down so panels separate
  deck: 0xeee8dc,
  panel: 0xf2ece0,
  mech: 0x98a2b8,       // scissor arms and linkage: cool grey-blue
  ink: 0x2f3348,        // pad glyphs, pupils, anything that reads as printed
  accent: 0xffb257,     // knob indicators and small warm highlights

  // --- mascot --------------------------------------------------------------
  //
  // Warm amber against the cool backdrop, and dark hardware to break it up.
  // A robot painted one colour reads as a toy; the eye needs the panel line
  // between the painted shell and the machinery to believe it was assembled.
  mascotBody: 0xf0a63c,
  mascotShade: 0xcf8628,
  mascotMetal: 0xaab3ca,
  mascotDark: 0x3f4459,
  mascotLens: 0x171b28,
  mascotIris: 0x8fe3ff,   // resting eye glow; a hit repaints it to the pad hue
  stick: 0xecc9a0,
};

/**
 * A pad's cap colour, from the hue already carried by its entry in pads.js.
 *
 * Saturation is held below 0.7 on purpose. Fully saturated hues under a bright
 * key light clip to a flat area of one colour, which is what makes cheerful
 * palettes read as garish; backing off leaves room for the shading to show.
 */
export function padColour(hue, saturation = 0.60, lightness = 0.58) {
  return new THREE.Color().setHSL(hue, saturation, lightness);
}

/** The same hue pushed bright, for the emissive rim under the cap. */
export function padGlow(hue) {
  return new THREE.Color().setHSL(hue, 0.85, 0.56);
}

/** `0xrrggbb` as the `#rrggbb` string the 2D canvas API wants. */
export function cssHex(hex) {
  return `#${hex.toString(16).padStart(6, '0')}`;
}
