
/**
  textures.js — procedurally generated texture maps.
  
    map           base colour        sRGB      what colour the surface is
    normalMap     surface direction  linear    how light bends off it
    roughnessMap  microsurface       linear    how sharp the reflection is
    emissive      self-illumination  sRGB      the pad rims
    gradientMap   shading ramp       linear    how toon shading bands the light
    glyph         drawn label        sRGB      the key letter on each pad
*/

import * as THREE from 'three';
import { cssHex } from './palette.js';

// -------------------------------
// Small signal-processing helpers
// -------------------------------

/** White noise height field in [0,1]. */
function whiteNoise(size) {
  const out = new Float32Array(size * size);
  for (let i = 0; i < out.length; i++) out[i] = Math.random();
  return out;
}

/**
  Separable box blur with wrap-around addressing
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

// --------------------------
// Height field -> normal map
// --------------------------

/**
  Convert a height field into a tangent-space normal map.
 
  At each texel, estimate the surface slope from its neighbours (a central
  difference), then build the normal of the plane with that slope:
 
    dx = h(x-1) - h(x+1)          slope across
    dy = h(y-1) - h(y+1)          slope down
    n  = normalise(dx*s, dy*s, 1) s = strength
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

// -----------------
// Material families
// -----------------

/**
  Soft moulded plastic — the case shell, lid, wings and panel.
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
  Moulded rubber, as on a drum pad
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
  Brushed aluminium
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
  Polished concrete
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
    normalMap: normalMapFromHeight(field, size, 0.55),
    roughnessMap: grayscaleTexture(field, size, 0.34, 0.68),
  };
}

/**
  Matte painted wall
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

// -----------------
// Toon shading ramp
// -----------------

export function toonRamp(levels = [0.45, 0.62, 0.80, 1.0]) {
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

// ----------------------
// Environment and labels
// ----------------------

export function radialFalloffTexture(size = 64, exponent = 2.0) {
  const data = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - centre) / centre;
      const dy = (y - centre) / centre;
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
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

// ----------------------
// Environment and labels
// ----------------------

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

// ---------------------------------------------------------
// Panel graphics: silkscreen, knob collars, and the display
// ---------------------------------------------------------

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
  A knob collar: a 270-degree arc track, a fill showing the current value, and
  the parameter name printed underneath.
*/
export function knobCollarTexture(label, { size = 160, tint = '#ffb257' } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');

  const cx = size / 2;
  const cy = size * 0.46;
  const radius = size * 0.375;
  const width = size * 0.055;

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
  The panel display.
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

    if (kit) {
      g.fillStyle = 'rgba(111,240,216,0.62)';
      g.font = '600 16px ui-sans-serif, system-ui, Arial, sans-serif';
      g.fillText(kit.toUpperCase(), 14, 88);
    }

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
  A single character drawn white on transparent, for the key letter printed on
  each pad.
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