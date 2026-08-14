/**
 * textures.js — procedurally generated texture maps.
 *
 * Nothing here is downloaded or imported. Every map is computed at load time
 * from noise and a few filters, which means: no licensing questions for the
 * report, no binary assets in the repo, and every parameter is explainable.
 *
 * The requirement asks for textures "of different kinds". Each material family
 * gets a full set, and the art direction adds two more kinds on top:
 *
 *   map           base colour        sRGB      what colour the surface is
 *   normalMap     surface direction  linear    how light bends off it
 *   roughnessMap  microsurface       linear    how sharp the reflection is
 *   emissive      self-illumination  sRGB      the pad rims
 *   gradientMap   shading ramp       linear    how toon shading bands the light
 *   glyph         drawn label        sRGB      the key letter on each pad
 *
 * COLOUR SPACE IS NOT OPTIONAL. Base colour maps hold perceptual sRGB values
 * and must be tagged SRGBColorSpace so the renderer linearises them before
 * lighting. Normal, roughness and gradient maps hold raw numbers — a normal
 * map's RGB is a direction vector, not a colour — and must stay linear.
 * Tagging a normal map as sRGB silently bends every surface normal the wrong
 * way, and the result looks merely "a bit off" rather than obviously broken,
 * which is why it is such a common and long-lived bug.
 */

import * as THREE from 'three';
import { cssHex } from './palette.js';

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
//
// THE COLOUR MAPS ARE MODULATION, NOT COLOUR.
//
// Three multiplies `material.map` by `material.color`. When the map ran from
// near-black to mid-grey — which is what a photographic brushed-aluminium map
// looks like — that product could only ever be dark, and every saturated
// colour asked for came back muddy. The maps here span a narrow band just
// below white, so the map supplies the *grain* and material.color supplies the
// hue. The same field still drives all three maps, so a pit is simultaneously
// darker, tilted and duller and still reads as one physical surface.
// ---------------------------------------------------------------------------

/**
 * Soft moulded plastic — the case shell, lid, wings and panel.
 *
 * A wide blur leaves only very low-frequency variation, which is what an
 * injection-moulded surface actually looks like: not smooth, but not detailed
 * either. The normal strength is a third of what the old brushed-metal family
 * used, because visible micro-relief is precisely the thing that stops a
 * surface reading as a toy.
 */
export function mouldedMaps(size = 256) {
  const height = normalise(boxBlur(whiteNoise(size), size, 3, 3));

  return {
    map: tintedTexture(height, size, 0xe8e8e8, 0xffffff),
    normalMap: normalMapFromHeight(height, size, 0.5),
    roughnessMap: grayscaleTexture(height, size, 0.62, 0.78),
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
    map: tintedTexture(height, size, 0xdcdcdc, 0xffffff),
    normalMap: normalMapFromHeight(height, size, 1.1),
    roughnessMap: grayscaleTexture(height, size, 0.70, 0.90),
  };
}

/**
 * Brushed aluminium, kept for the scissor mechanism.
 *
 * The whole character comes from anisotropy: blur white noise hard along one
 * axis and barely at all across it, and the streaks that survive read as
 * directional brush grooves. One machined family among the moulded ones is
 * what stops the rig looking like it was carved from a single block, and the
 * mechanism is the honest place for it — that is the part that would really be
 * metal.
 */
export function brushedMetalMaps(size = 512) {
  const height = normalise(boxBlur(whiteNoise(size), size, 14, 1));

  return {
    map: tintedTexture(height, size, 0xc8ccd4, 0xffffff),
    normalMap: normalMapFromHeight(height, size, 0.9),
    roughnessMap: grayscaleTexture(height, size, 0.30, 0.55),
  };
}

/**
 * Polished concrete — the floor.
 *
 * Two frequencies summed rather than one blurred field, which is the first
 * time this file has needed it. Concrete is genuinely two things at once: a
 * fine aggregate speckle a few millimetres across, and a slow blotchiness from
 * the pour and the sealer that runs over tens of centimetres. Blur white noise
 * once and you get one or the other; add a lightly blurred field to a heavily
 * blurred one and you get both, which is why a single-scale floor always reads
 * as sandpaper or as fog and never as concrete.
 *
 * The fine field is weighted lower than the coarse one. At the tiling density
 * this is used at, the fine detail is close to a texel per screen pixel and
 * would alias into shimmer if it carried the contrast.
 *
 * The roughness range is the important number here and it is wide: 0.34 to
 * 0.68. Sealed concrete is semi-gloss, so a spotlight raking across it leaves
 * a long specular streak — which is most of what makes stage lighting read as
 * stage lighting. Holding roughness constant would make that streak a clean
 * airbrushed shape; letting it vary breaks the streak into the mottled sheen a
 * real floor has. This is the one surface in the project where the roughness
 * map matters more than the normal map.
 */
export function concreteMaps(size = 512) {
  const fine = normalise(boxBlur(whiteNoise(size), size, 1, 1));
  const coarse = normalise(boxBlur(whiteNoise(size), size, 12, 12));

  const height = new Float32Array(size * size);
  for (let i = 0; i < height.length; i++) {
    height[i] = coarse[i] * 0.72 + fine[i] * 0.28;
  }

  const field = normalise(height);

  return {
    map: tintedTexture(field, size, 0xbcbcc4, 0xffffff),
    // Low strength on purpose. A floor seen at a grazing angle exaggerates
    // every normal it has, so a value that looks correct from overhead looks
    // like gravel from the camera height this scene uses.
    normalMap: normalMapFromHeight(field, size, 0.55),
    roughnessMap: grayscaleTexture(field, size, 0.34, 0.68),
  };
}

/**
 * Matte painted wall — the cyclorama.
 *
 * Almost nothing, and that is the specification rather than laziness. A cyc is
 * sprayed and rolled precisely so it has no readable detail: its whole job is
 * to be a surface with no landmarks, so that light landing on it is the only
 * thing the eye can see. Give it visible texture and it stops being a backdrop
 * and starts being a wall.
 *
 * So: one very wide blur, a colour map spanning barely two percent, a normal
 * map at a tenth of the strength any other family uses, and a narrow roughness
 * band up at the matte end. What survives is a faint roller mottle that keeps
 * the surface from banding into flat gradients — which is the actual failure
 * mode of a perfectly smooth wall under a coloured spot, and one that no
 * amount of tone mapping fixes.
 */
export function paintedWallMaps(size = 256) {
  const field = normalise(boxBlur(whiteNoise(size), size, 18, 18));

  return {
    map: tintedTexture(field, size, 0xf6f6f6, 0xffffff),
    normalMap: normalMapFromHeight(field, size, 0.10),
    roughnessMap: grayscaleTexture(field, size, 0.86, 0.94),
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

// ---------------------------------------------------------------------------
// Toon shading ramp
// ---------------------------------------------------------------------------

/**
 * The gradient map that turns smooth shading into cartoon bands.
 *
 * MeshToonMaterial does not shade by `dot(N, L)` directly. It uses that value,
 * remapped to 0..1, as the *texture coordinate* of this one-dimensional ramp,
 * and whatever the ramp holds at that coordinate becomes the light's
 * contribution. So the ramp is not a decoration on the lighting model — it is
 * the lighting model's transfer function, expressed as a texture. A smooth
 * ramp reproduces ordinary diffuse shading; a stepped one gives cel shading,
 * and the step positions are the entire look.
 *
 * NearestFilter is what makes the steps steps. With LinearFilter the hardware
 * interpolates between texels on the way out and the bands dissolve back into
 * the gradient they were built from.
 *
 * The steps here are deliberately uneven — 0.45, 0.62, 0.80, 1.0. Evenly
 * spaced bands put the biggest jump in the middle of the lit side of a
 * surface, where the eye is looking; loading the range towards the light keeps
 * the terminator soft and the shadow side open rather than crushed.
 */
export function toonRamp(levels = [0.45, 0.62, 0.80, 1.0]) {
  // Width is a multiple of 4, so the default unpack alignment of 4 bytes
  // matches the row length exactly and no padding is needed.
  const width = Math.ceil(levels.length / 4) * 4;
  const data = new Uint8Array(width);

  for (let i = 0; i < width; i++) {
    const level = levels[Math.min(i, levels.length - 1)];
    data[i] = Math.round(THREE.MathUtils.clamp(level, 0, 1) * 255);
  }

  const texture = new THREE.DataTexture(data, width, 1, THREE.RedFormat);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

// ---------------------------------------------------------------------------
// Environment and labels
// ---------------------------------------------------------------------------

/**
 * A vertical two-stop gradient, used as the scene background.
 *
 * Two texels wide because the gradient does not vary horizontally and a 2x256
 * image is all the information there is; the sampler stretches it across the
 * viewport at no cost. Assigned to `scene.background` it is drawn as a
 * screen-space quad, so it does not move when the camera orbits — which is
 * what a photographic backdrop does, and part of why the result reads as a
 * product shot rather than as a skybox.
 */
export function verticalGradientTexture(topHex, bottomHex, height = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = height;

  const g = canvas.getContext('2d');
  const gradient = g.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, cssHex(topHex));
  gradient.addColorStop(1, cssHex(bottomHex));
  g.fillStyle = gradient;
  g.fillRect(0, 0, 2, height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * An equirectangular studio environment, drawn rather than photographed.
 *
 * This is the map that makes metal look like metal. A metallic surface has no
 * diffuse response whatsoever — all it can do is reflect — so with no
 * environment it reflects an empty scene and renders black. The usual fix is
 * to load an HDRI, which means a binary asset and a licence; this is three
 * radial gradients on a canvas.
 *
 * The layout is a softbox rig: a large bright source high on one side, a
 * weaker cooler one opposite for fill, a narrow bright band along the horizon
 * to give edges something to catch, and a darker floor. Equirectangular means
 * x maps to azimuth over 2*pi and y to elevation over pi, so a circle drawn
 * near the top of the canvas becomes a broad soft source overhead — which is
 * exactly where a softbox goes.
 *
 * Handed to PMREMGenerator it becomes a prefiltered radiance map, so rough
 * materials read blurred mip levels and glossy ones read sharp ones, which is
 * what gives the roughness maps something to actually vary.
 */
export function studioEnvironmentTexture(width = 512) {
  const height = width / 2;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d');

  const sky = g.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0.00, '#f2f5ff');
  sky.addColorStop(0.45, '#b9c4de');
  sky.addColorStop(0.52, '#8e99b4');
  sky.addColorStop(1.00, '#3f465c');
  g.fillStyle = sky;
  g.fillRect(0, 0, width, height);

  function softbox(cx, cy, radius, colour, strength) {
    const glow = g.createRadialGradient(cx, cy, 0, cx, cy, radius);
    glow.addColorStop(0, `rgba(${colour}, ${strength})`);
    glow.addColorStop(1, `rgba(${colour}, 0)`);
    g.fillStyle = glow;
    g.fillRect(0, 0, width, height);
  }

  softbox(width * 0.28, height * 0.20, width * 0.22, '255, 250, 238', 1.0);
  softbox(width * 0.74, height * 0.30, width * 0.18, '214, 231, 255', 0.55);
  softbox(width * 0.52, height * 0.48, width * 0.30, '255, 255, 255', 0.16);

  const texture = new THREE.CanvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * A single character drawn white on transparent, for the key letter printed on
 * each pad.
 *
 * Drawn rather than modelled: sixteen extruded glyphs would be sixteen
 * geometries and a font dependency, where this is one canvas each and no
 * dependency at all. Premultiplied alpha is off (the three default), so the
 * transparent margin must still be white rather than black — a black
 * transparent margin bleeds dark fringes into the glyph edge when the mipmap
 * chain averages colour and alpha independently.
 */
export function glyphTexture(text, size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;

  const g = canvas.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,0)';
  g.fillRect(0, 0, size, size);

  g.fillStyle = '#ffffff';
  g.font = `600 ${Math.round(size * 0.6)}px ui-sans-serif, system-ui, "Helvetica Neue", Arial, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, size / 2, size * 0.54);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}