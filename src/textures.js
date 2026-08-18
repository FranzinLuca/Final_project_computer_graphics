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
 * A radial falloff, written into the COLOUR channels and not the alpha.
 *
 * THE BUG THIS FIXES, because it is a good one and worth keeping in the log:
 * the contact shadows rendered as hard black SQUARES. The texture looked
 * correct — a soft disc fading to nothing — and the material was correct, and
 * the result was a rectangle.
 *
 * The cause is one line inside three's shader library. `alphaMap` is sampled
 * as:
 *
 *   diffuseColor.a *= texture2D( alphaMap, vAlphaMapUv ).g;
 *
 * It reads the GREEN channel. The first version of this function put the
 * falloff in the ALPHA channel and left RGB at a flat 255, which is the
 * obvious way to build a mask and is exactly wrong here: green was 1.0
 * everywhere, so the mask multiplied every fragment by one and the plane drew
 * as a full opaque quad.
 *
 * The failure mode is instructive. Nothing errors, nothing warns, and
 * inspecting the texture in isolation shows the shape you intended — the
 * information is present in the file and being read from the wrong place. This
 * is the same class of mistake as tagging a normal map sRGB (D42): a channel
 * convention silently disagreed with, producing output that is wrong in a way
 * that looks like a different bug entirely.
 *
 * So the falloff goes into R, G and B, alpha stays at 255, and the texture is
 * left at `NoColorSpace` — a mask is data, not a colour, and letting the
 * renderer gamma-decode it would bend the falloff curve into a different one.
 *
 * `exponent` shapes the ramp. 3.5 concentrates the darkening near the centre
 * and leaves a long thin tail, which is what contact occlusion does: dark
 * where the object nearly touches, vanishing well before its silhouette ends.
 */
export function radialFalloffTexture(size = 64, exponent = 2.0) {
  const data = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - centre) / centre;
      const dy = (y - centre) / centre;
      // Clamped so the disc reaches zero exactly at the texture edge; without
      // the clamp the corners carry mask value and a "soft" shadow renders as
      // a faintly visible square — a milder version of the same fault.
      const r = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      const value = Math.round(Math.pow(1 - r, exponent) * 255);

      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = value;
      data[i + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  // The disc must not tile. Without this the bilinear filter at the edge wraps
  // to the opposite side and the falloff never quite reaches zero, leaving a
  // faint seam along all four borders of the quad.
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
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

// ---------------------------------------------------------------------------
// Panel graphics: silkscreen, knob collars, and the display
//
// Three dynamic canvas textures, and a genuinely different KIND of texture
// from the noise-derived maps above. Those are surface properties, computed
// once and never touched again. These are drawn with the 2D canvas API, some
// are redrawn while the program runs, and what they carry is INFORMATION
// rather than material.
// ---------------------------------------------------------------------------

/**
 * Text drawn white on transparent, at whatever aspect the caller needs.
 *
 * The generalisation of glyphTexture. Premultiplied alpha is off (the three
 * default), so the transparent margin must still be WHITE rather than black —
 * a black transparent margin bleeds dark fringes into the glyph edges when the
 * mipmap chain averages colour and alpha independently.
 */
export function textTexture(text, {
  width = 256,
  height = 64,
  size = 34,
  weight = 600,
  tracking = 0.14,
  align = 'center',
} = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const g = canvas.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,0)';
  g.fillRect(0, 0, width, height);

  g.fillStyle = '#ffffff';
  g.font = `${weight} ${size}px ui-sans-serif, system-ui, "Helvetica Neue", Arial, sans-serif`;
  g.textAlign = align;
  g.textBaseline = 'middle';

  // Letter spacing by hand rather than via the `letterSpacing` canvas property,
  // which is recent and unevenly supported. Tracked-out capitals are what
  // makes a legend read as screen printing rather than as a caption.
  const spacing = size * tracking;
  const glyphs = [...text];
  const total = glyphs.reduce((sum, ch) => sum + g.measureText(ch).width + spacing, -spacing);

  let x = align === 'center' ? (width - total) / 2 : width * 0.04;
  for (const ch of glyphs) {
    g.fillText(ch, x + g.measureText(ch).width / 2, height / 2);
    x += g.measureText(ch).width + spacing;
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * A knob collar: a 270-degree arc track, a fill showing the current value, and
 * the parameter name printed underneath.
 *
 * Returns a `draw` function rather than a finished texture, because the fill
 * changes whenever the knob is turned. It is redrawn ON CHANGE and not per
 * frame — six canvases at 128 square would be a real cost at 60 Hz and are
 * free at the rate a hand can turn a knob.
 *
 * 270 degrees because that is the travel of a real potentiometer and it is
 * already the sweep interaction.js applies to the knob mesh. The arc and the
 * cap turn through exactly the same angle, from the same value, so the printed
 * scale cannot disagree with the thing it is a scale for.
 */
export function knobCollarTexture(label, { size = 160, tint = '#ffb257' } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');

  const cx = size / 2;
  const cy = size * 0.46;
  const radius = size * 0.375;
  const width = size * 0.055;

  // Canvas angles run clockwise from +X. The sweep is centred on straight
  // down-screen and opens 135 degrees each way, so the dead zone sits at the
  // bottom where a real pot's stop is.
  const START = Math.PI * 0.75;
  const SWEEP = Math.PI * 1.5;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;

  function draw(value) {
    g.clearRect(0, 0, size, size);

    g.lineCap = 'round';

    // Unlit track.
    g.strokeStyle = 'rgba(255,255,255,0.16)';
    g.lineWidth = width;
    g.beginPath();
    g.arc(cx, cy, radius, START, START + SWEEP);
    g.stroke();

    // Lit fill. Drawn even at zero as a short stub, so the collar never looks
    // like a broken control — a scale with nothing on it reads as unpowered.
    const t = Math.min(1, Math.max(0, value));
    g.strokeStyle = tint;
    g.lineWidth = width;
    g.beginPath();
    g.arc(cx, cy, radius, START, START + Math.max(0.04, SWEEP * t));
    g.stroke();

    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.font = `600 ${Math.round(size * 0.115)}px ui-sans-serif, system-ui, Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label.toUpperCase(), cx, size * 0.93);

    texture.needsUpdate = true;
  }

  draw(0.5);
  return { texture, draw, canvas };
}

/**
 * The panel display.
 *
 * Redrawn on transport events and on the step, which at 200 bpm is thirteen
 * times a second — well under a frame's budget for a 256x128 canvas, and
 * nowhere near the per-frame redraw that would make a canvas texture a bad
 * idea. `needsUpdate` triggers a GPU upload each time, which is the actual
 * cost being managed here.
 *
 * It earns its place at the oral more than it does in the render: it makes the
 * sequencer's internal state — the tempo, whether it is running, which
 * sixteenth is sounding — visible ON THE INSTRUMENT rather than only in a
 * debug panel, which is the difference between a model of a drum machine and
 * a drum machine.
 */
export function displayTexture({ width = 256, height = 128 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d');

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;

  function draw({ bpm = 100, running = false, step = 0, armed = null, kit = '' } = {}) {
    g.fillStyle = '#07131a';
    g.fillRect(0, 0, width, height);

    // Scanline tint, one pass. A perfectly flat panel reads as a sticker; a
    // faint horizontal structure reads as a screen.
    g.fillStyle = 'rgba(255,255,255,0.025)';
    for (let y = 0; y < height; y += 4) g.fillRect(0, y, width, 1);

    g.fillStyle = '#6ff0d8';
    g.font = '700 54px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.fillText(String(Math.round(bpm)).padStart(3, ' '), 14, 62);

    g.font = '600 18px ui-sans-serif, system-ui, Arial, sans-serif';
    g.fillText('BPM', 128, 62);

    g.fillStyle = running ? '#6ff0d8' : 'rgba(111,240,216,0.30)';
    g.fillText(running ? 'RUN' : 'STOP', 128, 36);

    if (armed !== null) {
      g.fillStyle = '#ff6b5e';
      g.fillText(`REC ${armed + 1}`, 190, 36);
    }

    // The loaded kit, on the instrument itself. Four kits share one grid, one
    // set of hues and one keyboard map, so without this the only thing that
    // tells you which is loaded is the sound — which is fine while you are
    // listening and useless in a screenshot.
    if (kit) {
      g.fillStyle = 'rgba(111,240,216,0.62)';
      g.font = '600 16px ui-sans-serif, system-ui, Arial, sans-serif';
      g.fillText(kit.toUpperCase(), 14, 88);
    }

    // Sixteen step lamps, the current one filled. The row is the pattern, so
    // the display is showing the same data the pad grid is flashing — one
    // state, two views.
    const pitch = (width - 28) / 16;
    for (let i = 0; i < 16; i++) {
      const on = running && i === step;
      g.fillStyle = on ? '#6ff0d8' : (i % 4 === 0 ? 'rgba(111,240,216,0.34)' : 'rgba(111,240,216,0.14)');
      g.fillRect(14 + i * pitch, height - 34, pitch - 4, on ? 18 : 12);
    }

    texture.needsUpdate = true;
  }

  draw({});
  return { texture, draw };
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