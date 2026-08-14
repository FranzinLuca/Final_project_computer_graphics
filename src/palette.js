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
 * The hue a pad emits when it is lit, at constant perceived brightness.
 *
 * The naive version of this function was `setHSL(hue, 0.82, 0.58)` — one fixed
 * lightness for every pad. It is wrong, and the phase 9 audit is what caught
 * it, because the failure is invisible in a still and obvious in motion.
 *
 * HSL lightness is not brightness. It is a coordinate in a colour model that
 * knows nothing about the eye, and the eye is roughly three times more
 * sensitive to green than to blue and seven times more than to the deep red
 * end. Measured on the kit's own hues at L = 0.58, relative luminance ran from
 * 0.385 for the magenta percussion row to 0.758 for the toms — a factor of
 * two. Every pad was being driven with the same `emissiveIntensity`, so the
 * rows were nominally equal and visibly not: the toms glared and the
 * percussion row looked half-lit, and no amount of adjusting the intensity
 * curve could fix it because the imbalance was in the colour, not the level.
 *
 * So lightness is SOLVED rather than chosen. For each hue, a binary search
 * finds the lightness whose Rec. 709 luminance hits a common target. Twelve
 * iterations of bisection on a monotonic function is exact to well past what
 * eight-bit output can represent, and it runs five times total — once per
 * distinct hue in the bank — because the results are memoised.
 *
 * This is the same principle as the exponential filter mapping in audio.js and
 * the uneven toon ramp steps in textures.js: the parameter that gets spaced
 * evenly is the perceptual one, never the mathematical one.
 */

const PAD_SATURATION = 0.82;

/**
 * Target relative luminance for every lit pad. Chosen just under the point
 * where the brightest achievable hue would need to desaturate to reach it —
 * push this above about 0.68 and the deep reds run out of lightness headroom
 * and start returning white.
 */
const PAD_TARGET_LUMA = 0.60;

/** Rec. 709 luminance of a THREE.Color, in linear terms. */
function relativeLuminance(colour) {
  return 0.2126 * colour.r + 0.7152 * colour.g + 0.0722 * colour.b;
}

/** hue -> solved lightness. Five entries in practice. */
const lightnessCache = new Map();

function solveLightness(hue) {
  if (lightnessCache.has(hue)) return lightnessCache.get(hue);

  const probe = new THREE.Color();
  let low = 0.15;
  let high = 0.97;

  // Luminance is monotonically increasing in lightness at fixed hue and
  // saturation, which is the only property bisection needs. No derivative, no
  // starting guess, no failure mode.
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