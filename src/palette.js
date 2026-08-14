/**
 * palette.js — the colour scheme, in one place.
 *
 * The art direction changed at phase 5. It was a soft-toy version of studio
 * hardware: warm off-white shell, coloured plastic pads, cool backdrop. It is
 * now a grid controller — a dark slab with neutral caps that are lit from
 * underneath — and the palette had to move with it.
 *
 * The single most consequential change: pad colour is no longer a property of
 * the plastic. Every cap is the same neutral material, and hue arrives purely
 * as emission from the rim beneath it. Sixteen cap materials collapse to one,
 * and "what colour is this pad" stops being a question about the model and
 * becomes a question about the sequencer's state. That is the behaviour the
 * reference hardware actually has, and it is also the cheaper thing to draw.
 *
 * The slab is deliberately not black. True black gives the tone mapper nothing
 * to work with — every shading cue lands in the bottom two percent of the
 * range and the form disappears — and it sits badly against a toon-shaded
 * character. A dark desaturated blue keeps the shading readable and stays in
 * the same family as the backdrop.
 *
 * This module imports only three, exactly like pads.js imports nothing — leaf
 * modules, no cycles.
 */

import * as THREE from 'three';

export const PALETTE = {
  // --- environment ---------------------------------------------------------
  skyTop: 0xa2aed0,
  skyBottom: 0x59648a,
  ground: 0x6c7799,
  groundRim: 0x7f8aab,

  // --- the slab ------------------------------------------------------------
  slab: 0x2b3145,       // the body and the bezel rails
  slabDeep: 0x232839,   // wing undersides: the exterior when the slab is shut
  well: 0x151928,       // the recessed floor the pads stand on
  mech: 0x98a2b8,       // hinge barrels: the only metal left in the rig
  ink: 0x1a1d2b,        // pad glyphs and anything that reads as printed
  accent: 0xffb257,     // knob indicators and small warm highlights

  // --- pads ----------------------------------------------------------------
  /**
   * One neutral cap colour for all sixteen. Slightly warm and slightly off
   * white, so an unlit pad reads as frosted plastic rather than as a hole in
   * the image, and so the emissive underneath has somewhere to go.
   */
  padCap: 0xe9e6dd,

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
 * The hue a pad emits when it is lit.
 *
 * Pushed bright and saturated on purpose: this is a light source, not a
 * surface, and the desaturation that kept the old cap colours from clipping
 * would only make the glow look grey here.
 */
export function padGlow(hue) {
  return new THREE.Color().setHSL(hue, 0.82, 0.58);
}

/**
 * Retained for anything still asking for a pad's diffuse colour — the label
 * plane, a future legend in the GUI. Nothing in rig.js calls it any more.
 */
export function padColour(hue, saturation = 0.60, lightness = 0.58) {
  return new THREE.Color().setHSL(hue, saturation, lightness);
}

/** `0xrrggbb` as the `#rrggbb` string the 2D canvas API wants. */
export function cssHex(hex) {
  return `#${hex.toString(16).padStart(6, '0')}`;
}