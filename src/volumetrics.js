
/**
  volumetrics.js — raymarched light shafts.
*/

import * as THREE from 'three';

/**
  How many light shafts the shader is compiled for.
*/
export const MAX_BEAMS = 6;

/**
  Marching steps
*/
const MAX_STEPS = 32;

const vertexShader = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy * 2.0, 0.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  #include <common>
  #include <packing>

  #define MAX_BEAMS ${MAX_BEAMS}
  #define MAX_STEPS ${MAX_STEPS}

  varying vec2 vUv;

  uniform sampler2D tDepth;
  uniform mat4 uProjectionInverse;
  uniform mat4 uCameraWorld;
  uniform vec3 uCameraPosition;
  uniform float uNear;
  uniform float uFar;
  uniform float uTime;
  uniform float uDensity;
  uniform int uSteps;
  uniform int uCount;

  uniform vec3 uApex[MAX_BEAMS];
  uniform vec3 uAxis[MAX_BEAMS];
  uniform vec3 uColor[MAX_BEAMS];
  uniform float uCosOuter[MAX_BEAMS];
  uniform float uCosInner[MAX_BEAMS];
  uniform float uIntensity[MAX_BEAMS];
  uniform float uRange[MAX_BEAMS];

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  float valueNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    return mix(
      mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
          mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
          mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y),
      f.z
    );
  }

  float haze(vec3 p) {
    float drift = uTime * 0.035;
    float a = valueNoise(p * 2.4 + vec3(0.0, -drift, drift * 0.6));
    float b = valueNoise(p * 6.1 + vec3(drift * 1.4, drift * 0.5, 0.0));
    return 0.55 + 0.30 * a + 0.15 * b;
  }

  /**
    Ray/infinite-cone intersection
   
      a = (R·D)² - k²
      b = 2((R·D)(CO·D) - k²(CO·R))
      c = (CO·D)² - k²(CO·CO)          where CO = O - A
   */
  bool intersectCone(vec3 origin, vec3 dir, vec3 apex, vec3 axis, float cosOuter,
                     float tMin, float tMax, out float t0, out float t1) {
    vec3 co = origin - apex;

    float dd = dot(dir, axis);
    float cd = dot(co, axis);
    float k2 = cosOuter * cosOuter;

    float a = dd * dd - k2;
    float b = 2.0 * (dd * cd - k2 * dot(co, dir));
    float c = cd * cd - k2 * dot(co, co);

    // The forward-nappe half-line.
    float fLo = -1e5;
    float fHi = 1e5;
    if (dd > 1e-6) fLo = -cd / dd;
    else if (dd < -1e-6) fHi = -cd / dd;
    else if (cd <= 0.0) return false;

    if (abs(a) < 1e-7) return false;

    float disc = b * b - 4.0 * a * c;
    if (disc < 0.0) return false;

    float sq = sqrt(disc);
    float r0 = (-b - sq) / (2.0 * a);
    float r1 = (-b + sq) / (2.0 * a);
    if (r0 > r1) { float tmp = r0; r0 = r1; r1 = tmp; }

    float lo = 1e6;
    float hi = -1e6;

    if (a < 0.0) {
      lo = max(max(r0, fLo), tMin);
      hi = min(min(r1, fHi), tMax);
    } else {
      // Two arms. Take whichever survives clipping; if both do, the nearer.
      float loA = max(fLo, tMin);
      float hiA = min(min(r0, fHi), tMax);
      float loB = max(max(r1, fLo), tMin);
      float hiB = min(fHi, tMax);

      if (hiA > loA) { lo = loA; hi = hiA; }
      if (hiB > loB && (hi <= lo || loB < lo)) { lo = loB; hi = hiB; }
    }

    if (hi <= lo) return false;

    t0 = lo;
    t1 = hi;
    return true;
  }

  void main() {
    // reconstruct the world-space view ray
    vec4 clip = vec4(vUv * 2.0 - 1.0, -1.0, 1.0);
    vec4 view = uProjectionInverse * clip;
    view /= view.w;

    vec3 viewDir = normalize(view.xyz);
    vec3 rayDir = normalize(mat3(uCameraWorld) * viewDir);
    vec3 rayOrigin = uCameraPosition;

    // how far the nearest surface is, along this ray
    float packed = unpackRGBAToDepth(texture2D(tDepth, vUv));

    float sceneT = uFar;
    if (packed > 0.0 && packed < 0.9999) {
      float viewZ = perspectiveDepthToViewZ(packed, uNear, uFar);
      // viewDir.z is negative (the camera looks down -Z), as is viewZ, so the
      // quotient is a positive distance along the normalised ray.
      sceneT = viewZ / viewDir.z;
    }

    /**
      Per-pixel dither on the starting offset.
    */
    float dither = hash(vec3(gl_FragCoord.xy, uTime * 60.0));

    vec3 accum = vec3(0.0);

    for (int i = 0; i < MAX_BEAMS; i++) {
      if (i >= uCount) break;

      if (uIntensity[i] <= 0.002) continue;

      float t0, t1;
      if (!intersectCone(rayOrigin, rayDir, uApex[i], uAxis[i], uCosOuter[i],
                         uNear, sceneT, t0, t1)) continue;

      vec3 oc = rayOrigin - uApex[i];
      float sb = dot(oc, rayDir);
      float sc = dot(oc, oc) - uRange[i] * uRange[i];
      float sh = sb * sb - sc;
      if (sh < 0.0) continue;
      sh = sqrt(sh);
      t0 = max(t0, -sb - sh);
      t1 = min(t1, -sb + sh);
      if (t1 <= t0) continue;

      float span = t1 - t0;
      float stepLen = span / float(uSteps);

      vec3 sum = vec3(0.0);

      for (int s = 0; s < MAX_STEPS; s++) {
        if (s >= uSteps) break;

        float t = t0 + (float(s) + dither) * stepLen;
        vec3 p = rayOrigin + rayDir * t;

        vec3 toPoint = p - uApex[i];
        float dist = length(toPoint);
        if (dist < 1e-4) continue;

        vec3 unit = toPoint / dist;
        float ca = dot(unit, uAxis[i]);

        float ang = smoothstep(uCosOuter[i], uCosInner[i], ca);
        ang *= ang;
        if (ang <= 0.0) continue;

        float falloff = 1.0 / (0.25 + dist * dist);

        float range = 1.0 - smoothstep(uRange[i] * 0.55, uRange[i], dist);
        float birth = smoothstep(0.0, 0.60, dist);

        sum += uColor[i] * (ang * falloff * range * birth * haze(p));
      }

      accum += sum * uIntensity[i] * stepLen * uDensity;
    }

    if (accum == vec3(0.0)) discard;

    gl_FragColor = vec4(accum, 1.0);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
  The composite: a half-resolution buffer added over the finished frame.
*/
const compositeFragment = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tVolume;

  void main() {
    gl_FragColor = vec4(texture2D(tVolume, vUv).rgb, 1.0);
  }
`;

/**
  Build the volumetric pass.

  @param {{ renderer: THREE.WebGLRenderer, scale?: number }} deps
*/
export function initVolumetrics({ renderer, scale = 0.5 }) {
  const depthMaterial = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    side: THREE.DoubleSide,
  });

  const depthTarget = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
    generateMipmaps: false,
  });

  const uniforms = {
    tDepth: { value: depthTarget.texture },
    uProjectionInverse: { value: new THREE.Matrix4() },
    uCameraWorld: { value: new THREE.Matrix4() },
    uCameraPosition: { value: new THREE.Vector3() },
    uNear: { value: 0.1 },
    uFar: { value: 100 },
    uTime: { value: 0 },
    uDensity: { value: 2.4 },
    uSteps: { value: 24 },
    uCount: { value: 0 },
    uApex: { value: Array.from({ length: MAX_BEAMS }, () => new THREE.Vector3()) },
    uAxis: { value: Array.from({ length: MAX_BEAMS }, () => new THREE.Vector3(0, -1, 0)) },
    uColor: { value: Array.from({ length: MAX_BEAMS }, () => new THREE.Color(0, 0, 0)) },
    uCosOuter: { value: new Array(MAX_BEAMS).fill(0.99) },
    uCosInner: { value: new Array(MAX_BEAMS).fill(0.999) },
    uIntensity: { value: new Array(MAX_BEAMS).fill(0) },
    uRange: { value: new Array(MAX_BEAMS).fill(6) },
  };

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms,
    transparent: true,
    blending: THREE.NormalBlending,
    depthTest: false,
    depthWrite: false,
  });

  const quadScene = new THREE.Scene();
  const quadCamera = new THREE.Camera();
  quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material));

  const volumeTarget = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });

  const compositeMaterial = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader: compositeFragment,
    uniforms: { tVolume: { value: volumeTarget.texture } },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });

  const compositeScene = new THREE.Scene();
  compositeScene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), compositeMaterial));

  let width = 1;
  let height = 1;
  let enabled = true;

  function setSize(w, h) {
    width = w;
    height = h;
    const dw = Math.max(1, Math.floor(w * scale));
    const dh = Math.max(1, Math.floor(h * scale));
    depthTarget.setSize(dw, dh);
    volumeTarget.setSize(dw, dh);
  }

  /**
    Push the current beam set into the uniforms.
   
    @param {Array<{position: THREE.Vector3, direction: THREE.Vector3,
                   color: THREE.Color, intensity: number, angle: number,
                   penumbra: number, range: number}>} beams
  */
  function setBeams(beams) {
    const count = Math.min(beams.length, MAX_BEAMS);
    uniforms.uCount.value = count;

    for (let i = 0; i < count; i++) {
      const beam = beams[i];
      uniforms.uApex.value[i].copy(beam.position);
      uniforms.uAxis.value[i].copy(beam.direction).normalize();
      uniforms.uColor.value[i].copy(beam.color);
      uniforms.uIntensity.value[i] = beam.intensity;
      uniforms.uRange.value[i] = beam.range ?? 6;

      const outer = Math.cos(beam.angle);
      const inner = Math.cos(beam.angle * (1 - (beam.penumbra ?? 0.5)));
      uniforms.uCosOuter.value[i] = outer;
      uniforms.uCosInner.value[i] = Math.max(inner, outer + 1e-4);
    }
  }

  /** Scratch for saving the renderer's clear colour around the depth pass. */
  const previousClear = new THREE.Color();

  /**
    Render the depth prepass. Must run before the main scene render, because
    it swaps the scene's materials out and back.
  */
  function renderDepth(scene, camera) {
    if (!enabled) return;

    const previousOverride = scene.overrideMaterial;
    const previousBackground = scene.background;
    scene.background = null;
    scene.overrideMaterial = depthMaterial;

    renderer.setRenderTarget(depthTarget);

    renderer.getClearColor(previousClear);
    const previousClearAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setClearColor(previousClear, previousClearAlpha);
    renderer.setRenderTarget(null);

    scene.overrideMaterial = previousOverride;
    scene.background = previousBackground;
  }

  /** Composite the shafts. Must run AFTER the main scene render. */
  function render(camera, elapsed) {
    if (!enabled || uniforms.uCount.value === 0) return;

    uniforms.uProjectionInverse.value.copy(camera.projectionMatrixInverse);
    uniforms.uCameraWorld.value.copy(camera.matrixWorld);
    uniforms.uCameraPosition.value.setFromMatrixPosition(camera.matrixWorld);
    uniforms.uNear.value = camera.near;
    uniforms.uFar.value = camera.far;
    uniforms.uTime.value = elapsed;

    const previousAutoClear = renderer.autoClear;

    // Pass one: march into the half-resolution buffer, cleared to black so
    // every pixel the shader discards contributes exactly nothing later.
    renderer.autoClear = true;
    renderer.setRenderTarget(volumeTarget);
    renderer.render(quadScene, quadCamera);
    renderer.setRenderTarget(null);

    // Pass two: add it over the finished frame. autoClear off, or the
    // composite wipes the very frame it is meant to add to.
    renderer.autoClear = false;
    renderer.render(compositeScene, quadCamera);

    renderer.autoClear = previousAutoClear;
  }

  return {
    setSize,
    setBeams,
    renderDepth,
    render,
    setSteps: (n) => { uniforms.uSteps.value = Math.max(4, Math.min(MAX_STEPS, n)); },
    setDensity: (d) => { uniforms.uDensity.value = d; },
    setEnabled: (on) => { enabled = on; },
    isEnabled: () => enabled,
    dispose: () => {
      depthTarget.dispose();
      volumeTarget.dispose();
      depthMaterial.dispose();
      material.dispose();
      compositeMaterial.dispose();
    },
  };
}