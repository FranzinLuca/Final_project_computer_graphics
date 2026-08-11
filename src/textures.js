/**
 * textures.js — procedurally generated texture maps.
 *
 * Nothing here is downloaded or imported. Every map is computed at load time
 * from noise and a few filters, which means: no licensing questions for the
 * report, no binary assets in the repo, and every parameter is explainable.
 *
 * The requirement asks for textures "of different kinds". Each material family
 * gets a full set:
 *
 *   map           base colour        sRGB      what colour the surface is
 *   normalMap     surface direction  linear    how light bends off it
 *   roughnessMap  microsurface       linear    how sharp the reflection is
 *   emissive      self-illumination  sRGB      the pad LEDs
 *
 * COLOUR SPACE IS NOT OPTIONAL. Base colour maps hold perceptual sRGB values
 * and must be tagged SRGBColorSpace so the renderer linearises them before
 * lighting. Normal and roughness maps hold raw numbers — a normal map's RGB is
 * a direction vector, not a colour — and must stay linear. Tagging a normal
 * map as sRGB silently bends every surface normal the wrong way, and the
 * result looks merely "a bit off" rather than obviously broken, which is why
 * it is such a common and long-lived bug.
 */

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Small signal-processing helpers
// ---------------------------------------------------------------------------

/** White noise height field in [0,1]. */
function whiteNoise(size) {
  const out = new Float32Array(size * size);
  for (let i = 0; i < out.length; i++) out[i] = Math.random();
  return out;
}

/**
 * Separable box blur with wrap-around addressing.
 *
 * Wrapping rather than clamping at the edges is what makes the result tile
 * seamlessly — a clamped blur leaves a visible seam where the texture repeats.
 * Separable means two 1D passes instead of one 2D kernel: O(n) per pixel
 * instead of O(n²).
 */
function boxBlur(src, size, radiusX, radiusY) {
  const tmp = new Float32Array(size * size);
  const out = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let k = -radiusX; k <= radiusX; k++) {
        sum += src[y * size + ((x + k + size) % size)];
      }
      tmp[y * size + x] = sum / (radiusX * 2 + 1);
    }
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let k = -radiusY; k <= radiusY; k++) {
        sum += tmp[((y + k + size) % size) * size + x];
      }
      out[y * size + x] = sum / (radiusY * 2 + 1);
    }
  }

  return out;
}

/** Rescale a field so its extremes land on 0 and 1. */
function normalise(field) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of field) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  const out = new Float32Array(field.length);
  for (let i = 0; i < field.length; i++) out[i] = (field[i] - min) / span;
  return out;
}

// ---------------------------------------------------------------------------
// Height field -> normal map
// ---------------------------------------------------------------------------

/**
 * Convert a height field into a tangent-space normal map.
 *
 * At each texel, estimate the surface slope from its neighbours (a central
 * difference), then build the normal of the plane with that slope:
 *
 *   dx = h(x-1) - h(x+1)          slope across
 *   dy = h(y-1) - h(y+1)          slope down
 *   n  = normalise(dx*s, dy*s, 1) s = strength
 *
 * The +1 in Z is what keeps the normal pointing out of the surface: a flat
 * region gives (0,0,1), which is why unperturbed normal maps are that
 * characteristic lavender blue. Vectors run from -1..1 but texture channels
 * hold 0..1, so each component is packed as v*0.5 + 0.5 — and the shader
 * unpacks it with the inverse. That packing is the only reason a normal map
 * looks like a colour at all.
 *
 * Neighbour lookups wrap, for the same tiling reason as the blur.
 */
export function normalMapFromHeight(height, size, strength = 2.0) {
  const data = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const left  = height[y * size + ((x - 1 + size) % size)];
      const right = height[y * size + ((x + 1) % size)];
      const up    = height[((y - 1 + size) % size) * size + x];
      const down  = height[((y + 1) % size) * size + x];

      let nx = (left - right) * strength;
      let ny = (up - down) * strength;
      let nz = 1.0;

      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;

      const i = (y * size + x) * 4;
      data[i]     = (nx * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = (nz * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  // colorSpace left at the default NoColorSpace — this is a vector field.
  return texture;
}

/** Grayscale field -> single-channel-looking texture, kept linear. */
function grayscaleTexture(field, size, low = 0, high = 1) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  const image = g.createImageData(size, size);

  for (let i = 0; i < field.length; i++) {
    const v = Math.round((low + field[i] * (high - low)) * 255);
    image.data[i * 4] = v;
    image.data[i * 4 + 1] = v;
    image.data[i * 4 + 2] = v;
    image.data[i * 4 + 3] = 255;
  }

  g.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** Height field tinted between two colours -> base colour map, tagged sRGB. */
function tintedTexture(field, size, darkHex, lightHex) {
  const dark = new THREE.Color(darkHex);
  const light = new THREE.Color(lightHex);

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  const image = g.createImageData(size, size);
  const mix = new THREE.Color();

  for (let i = 0; i < field.length; i++) {
    mix.copy(dark).lerp(light, field[i]);
    image.data[i * 4] = mix.r * 255;
    image.data[i * 4 + 1] = mix.g * 255;
    image.data[i * 4 + 2] = mix.b * 255;
    image.data[i * 4 + 3] = 255;
  }

  g.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace; // this one IS a colour
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

// ---------------------------------------------------------------------------
// Material families
// ---------------------------------------------------------------------------

/**
 * Brushed aluminium.
 *
 * The whole character comes from anisotropy: blur white noise hard along one
 * axis and barely at all across it, and the streaks that survive read as
 * directional brush grooves. Same field drives colour, normal and roughness,
 * so a groove is simultaneously darker, tilted and duller — which is what
 * makes it look like one physical surface rather than three overlaid effects.
 */
export function brushedMetalMaps(size = 512) {
  const height = normalise(boxBlur(whiteNoise(size), size, 14, 1));

  return {
    map: tintedTexture(height, size, 0x4a4e54, 0x9aa0a8),
    normalMap: normalMapFromHeight(height, size, 1.6),
    roughnessMap: grayscaleTexture(height, size, 0.22, 0.52),
  };
}

/**
 * Moulded rubber, as on a drum pad: a fine isotropic stipple. Blur radius 1
 * in both directions keeps the grain tight — anything wider starts to read as
 * leather.
 */
export function rubberMaps(size = 256) {
  const height = normalise(boxBlur(whiteNoise(size), size, 1, 1));

  return {
    map: tintedTexture(height, size, 0x1c1e21, 0x33373c),
    normalMap: normalMapFromHeight(height, size, 2.4),
    roughnessMap: grayscaleTexture(height, size, 0.72, 0.94),
  };
}

/**
 * Textured plastic for the control panel and knobs — a slightly coarser,
 * flatter grain than the rubber, tinted darker than the chassis so the two
 * metal-vs-plastic families are visually distinct under the same light.
 */
export function plasticMaps(size = 256) {
  const height = normalise(boxBlur(whiteNoise(size), size, 2, 2));

  return {
    map: tintedTexture(height, size, 0x17191c, 0x2b2f34),
    normalMap: normalMapFromHeight(height, size, 1.1),
    roughnessMap: grayscaleTexture(height, size, 0.5, 0.72),
  };
}

/** Apply repeat + anisotropy to every map in a set, in place. */
export function configureMaps(maps, repeatX, repeatY, anisotropy = 1) {
  for (const texture of Object.values(maps)) {
    texture.repeat.set(repeatX, repeatY);
    texture.anisotropy = anisotropy;
    texture.needsUpdate = true;
  }
  return maps;
}