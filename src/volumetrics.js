/**
 * volumetrics.js — raymarched light shafts.
 *
 * This replaces the cone meshes that were removed in phase 11, and it is worth
 * being precise about why the same feature is being built twice with different
 * technology rather than the first version being tuned.
 *
 *
 * WHY A CONE MESH CANNOT FUSE, AND WHY A RAYMARCH CAN
 *
 * A cone of additive transparency is a SURFACE standing in for a VOLUME. Every
 * fragment of it contributes the same amount regardless of how much air the
 * viewer is actually looking through, and — the fatal part — two overlapping
 * cones are two pieces of geometry composited one after the other. Where they
 * cross you get the silhouette of one drawn over the silhouette of the other:
 * a lens-shaped region with a hard outline. That outline is the edge of a
 * triangle mesh, and no blending mode or alpha ramp removes it.
 *
 * What actually happens in a hazy room is an integral. Light scattered towards
 * the eye from a single pixel's line of sight is
 *
 *     L = ∫ σ · Σᵢ Iᵢ(x) dt
 *
 * along the view ray, where σ is how much haze is in the air and Iᵢ(x) is how
 * much light source i delivers to the point x. The sum over sources is INSIDE
 * the integral. That is the whole thing: two beams crossing are not two images
 * added, they are one integral of a sum, and the result is smooth everywhere
 * because there is no geometry involved to have an edge.
 *
 * So this module evaluates that integral. For each pixel it reconstructs the
 * world-space view ray, intersects it analytically with each light's cone,
 * marches the overlapping interval, and accumulates every source's
 * contribution into one running total. Colours fuse because they are summed
 * per sample before anything is written — teal and amber crossing produce a
 * genuinely warmer, brighter core, not two translucent shapes overlapping.
 *
 *
 * OCCLUSION, AND THE DEPTH PASS
 *
 * A beam has to stop when it hits something, or it draws straight through the
 * instrument and the illusion collapses instantly. The shader therefore needs
 * to know how far away the nearest surface is along each view ray, which is
 * exactly what a depth buffer holds — and which is not readable from inside a
 * normal forward pass.
 *
 * So main.js renders the scene once more, first, with `overrideMaterial` set to
 * a depth material, into a half-resolution render target. That is a real cost
 * and it is the smallest version of it: no lighting, no textures, no
 * transparency sorting, one attribute per vertex, at a quarter of the pixels.
 * Half resolution is sufficient because the depth is used only to decide where
 * a soft glow stops, so an error of one texel is invisible; it would not be
 * sufficient for anything with a hard edge.
 *
 * This is a post-processing pass in everything but name, and the earlier
 * decision not to have one stands for what it covered — bloom needs a bright
 * pass, a separable blur and a composite, three passes and two targets, to
 * produce an effect that lens-flare-adjacent tone mapping approximates. This
 * is one extra depth render to produce something with no cheap approximation
 * at all.
 *
 *
 * WHAT IS APPROXIMATED, HONESTLY
 *
 *   - SINGLE SCATTERING only. Light reaching the eye is assumed to have
 *     bounced off haze exactly once. Multiple scattering would brighten and
 *     soften the shafts further and needs a fundamentally different method.
 *   - NO SHADOWING WITHIN THE VOLUME. A real shaft is broken where an object
 *     blocks it, throwing a dark slot through the haze. Doing that means
 *     sampling each light's shadow map at every march step, which means the
 *     spots must cast shadows — and the project renders one shadow map, for
 *     the key, deliberately (a second caster gives every object two
 *     silhouettes). The beams here are geometrically correct and unshadowed.
 *   - COMPOSITED AFTER TONE MAPPING. The shafts are added over an already
 *     encoded frame rather than into linear HDR, because there is no float
 *     buffer to accumulate into. The shader tone maps its own contribution
 *     through the same curve so the two agree, but a mathematically exact
 *     result would need the whole frame in float.
 */

import * as THREE from 'three';

/**
 * How many light shafts the shader is compiled for.
 *
 * Raised from four to six. The cost is linear in this number and it is paid
 * per pixel per step, so it is not free — but the early-out on a dark beam
 * means the marginal shafts cost nothing whenever they are not lit, and the
 * scene's whole reason for having a raymarch instead of cone meshes is that
 * shafts CROSS. Two beams overlap in a line, four in a few points, six in a
 * volume, and the fusion only becomes obvious somewhere around the fourth.
 */
export const MAX_BEAMS = 6;

/**
 * Marching steps. A compile-time ceiling with a runtime early exit, because
 * GLSL ES 1.00 requires loop bounds to be constant — the bound is fixed and
 * the `break` is what actually varies with quality.
 */
const MAX_STEPS = 32;

const vertexShader = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    // The quad is written straight to clip space. Its geometry is a unit plane
    // centred on the origin, so doubling covers -1..1 exactly, and z = 0 puts
    // it inside the depth range without being tested against anything (depth
    // testing is off for this pass).
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

  /**
   * Value noise over a 3D position, used to break the haze up.
   *
   * A perfectly uniform medium gives a shaft with a mathematically smooth
   * gradient, which reads as a computer-generated cone even when the geometry
   * is right — real air has structure, because dust and smoke are not evenly
   * mixed. Two octaves at different scales drifting at different speeds is
   * enough to suggest that without ever resolving into a recognisable pattern.
   */
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  float valueNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    // Smoothstep weights: without them the interpolation is linear and the
    // lattice of the noise grid is visible as diamond-shaped facets.
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
    // Biased upward so the medium is never fully absent — a shaft that
    // disappears in patches reads as a rendering fault, not as thin air.
    return 0.55 + 0.30 * a + 0.15 * b;
  }

  /**
   * Ray/infinite-cone intersection, solved analytically.
   *
   * A cone from apex A about unit axis D whose half-angle has cosine k is the
   * set of points X with dot(normalize(X - A), D) = k. Substituting X = O + tR
   * and squaring to clear the normalisation gives a quadratic in t:
   *
   *   a = (R·D)² - k²
   *   b = 2((R·D)(CO·D) - k²(CO·R))
   *   c = (CO·D)² - k²(CO·CO)          where CO = O - A
   *
   * TWO THINGS THAT THE OBVIOUS IMPLEMENTATION GETS WRONG, both caught by
   * sampling the solver numerically rather than by looking at the render.
   *
   * FIRST, the inside of the cone is q(t) >= 0, and WHICH side of the roots
   * that is depends on the sign of 'a'. When a < 0 the interior is between the
   * roots, which is the intuitive case and the only one a naive version
   * handles. When a > 0 — the ray more closely aligned with the axis than the
   * cone's own half-angle, which is exactly what happens when the camera looks
   * up along a shaft — the interior is OUTSIDE the roots, two semi-infinite
   * arms. Treating that case as "between the roots" marches the empty region
   * and skips the lit one, so the beam hollows out precisely when the viewer
   * looks into it.
   *
   * SECOND, squaring introduced the mirror cone behind the apex. That is
   * removed not by testing sample points but by intersecting with the half-line
   * where dot(X - A, D) > 0, which is linear in t and therefore exact: the
   * forward nappe is t > -cd/dd, or t < -cd/dd when the ray runs against the
   * axis. Without it a beam pointing at the floor also paints an inverted
   * shaft into the sky.
   *
   * Returns the nearest non-empty interval, already clipped to [tMin, tMax].
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
    // --- reconstruct the world-space view ray ----------------------------
    vec4 clip = vec4(vUv * 2.0 - 1.0, -1.0, 1.0);
    vec4 view = uProjectionInverse * clip;
    view /= view.w;

    vec3 viewDir = normalize(view.xyz);
    vec3 rayDir = normalize(mat3(uCameraWorld) * viewDir);
    vec3 rayOrigin = uCameraPosition;

    // --- how far the nearest surface is, along this ray -------------------
    //
    // Clamping the march to this is what makes the instrument, the cabinets
    // and the floor block the shafts. Reading it once per pixel rather than
    // per step is exact for opaque occluders and costs one texture fetch
    // instead of thirty-two.
    float packed = unpackRGBAToDepth(texture2D(tDepth, vUv));
    float viewZ = perspectiveDepthToViewZ(packed, uNear, uFar);
    // viewDir.z is negative (the camera looks down -Z), as is viewZ, so the
    // quotient is a positive distance along the normalised ray.
    float sceneT = viewZ / viewDir.z;
    if (packed >= 1.0) sceneT = uFar;

    /**
     * Per-pixel dither on the starting offset.
     *
     * Marching from the same t on every pixel makes the sample planes visible
     * as concentric bands through the shaft — the classic slice artefact. An
     * ordered offset turns the banding into high-frequency noise, which the
     * eye integrates away, and costs one hash. This is why a 20-step march
     * looks better than an undithered 60-step one.
     */
    float dither = hash(vec3(gl_FragCoord.xy, uTime * 60.0));

    vec3 accum = vec3(0.0);

    for (int i = 0; i < MAX_BEAMS; i++) {
      if (i >= uCount) break;

      // A dark shaft costs exactly as much to march as a bright one, and
      // contributes nothing. Skipping it is most of the frame budget back
      // whenever the music is quiet, which is also when the frame rate matters
      // least — but it is free, and it guarantees a silent scene has no
      // visible cones at all rather than four very faint ones.
      if (uIntensity[i] <= 0.002) continue;

      float t0, t1;
      if (!intersectCone(rayOrigin, rayDir, uApex[i], uAxis[i], uCosOuter[i],
                         uNear, sceneT, t0, t1)) continue;

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

        // Angular falloff between the inner and outer cone, which is the same
        // penumbra a SpotLight applies to the surfaces it lights — so the soft
        // edge of the shaft in the air agrees with the soft edge of the pool
        // on the floor. Squared, because a linear penumbra still leaves a
        // visible boundary where the gradient's derivative jumps.
        float ang = smoothstep(uCosOuter[i], uCosInner[i], ca);
        ang *= ang;
        if (ang <= 0.0) continue;

        // Inverse square, with a softening constant so the apex does not blow
        // up to infinity. Real emitters have area; a point source does not,
        // and the constant is standing in for that area.
        float falloff = 1.0 / (0.25 + dist * dist);

        // Fade out towards the end of the throw, and in again near the apex,
        // so the shaft has no hard start even if the emitter is on screen.
        float range = 1.0 - smoothstep(uRange[i] * 0.55, uRange[i], dist);
        float birth = smoothstep(0.0, 0.35, dist);

        sum += uColor[i] * (ang * falloff * range * birth * haze(p));
      }

      // The sum over sources happens HERE, before anything is written: this is
      // the line that makes two beams fuse instead of overlap.
      accum += sum * uIntensity[i] * stepLen * uDensity;
    }

    if (accum == vec3(0.0)) discard;

    gl_FragColor = vec4(accum, 1.0);

    // Through the same tone curve as the rest of the frame, so a shaft that
    // climbs past white rolls off the way every other bright thing in the
    // scene does rather than clipping to flat colour.
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * Build the volumetric pass.
 *
 * Owns its own scene and camera. A fullscreen quad living in the main scene
 * would have to be excluded from the depth prepass, kept in front of every
 * transparent object by render order, and would inherit the scene's fog — three
 * problems that all disappear when the pass is simply a second, one-object
 * scene rendered afterwards.
 *
 * @param {{ renderer: THREE.WebGLRenderer, scale?: number }} deps
 */
export function initVolumetrics({ renderer, scale = 0.5 }) {
  const depthMaterial = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    /**
     * DoubleSide, and this is a real trap. `overrideMaterial` replaces every
     * material in the scene, including the cyclorama's — which is drawn
     * BackSide, because the room is seen from inside. A front-facing depth
     * material culls every triangle of it, the walls and floor sweep vanish
     * from the depth buffer, and the shafts pour straight through the room as
     * though it were not there.
     */
    side: THREE.DoubleSide,
  });

  const depthTarget = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    // Packed depth is four bytes of a single number. Any filtering blends
    // across byte boundaries and unpacks to garbage, which is why this is the
    // one texture in the project that must be Nearest.
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
    /**
     * Haze density. 1.9, up from 1.0.
     *
     * This is the single number that decides whether the room reads as having
     * air in it. Below about 1.2 the shafts are a suggestion and the enclosure
     * looks empty; much above 2.2 the near half of the frame greys over and
     * the instrument loses contrast, because scattered light accumulates along
     * the whole ray including the part in front of the subject.
     */
    uDensity: { value: 1.9 },
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
    // Light adds and never occludes, so the composite is additive and neither
    // tests nor writes depth — occlusion is handled analytically inside the
    // shader against the depth texture, not by the depth unit.
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });

  const quadScene = new THREE.Scene();
  const quadCamera = new THREE.Camera();
  quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material));

  let width = 1;
  let height = 1;
  let enabled = true;

  function setSize(w, h) {
    width = w;
    height = h;
    depthTarget.setSize(Math.max(1, Math.floor(w * scale)), Math.max(1, Math.floor(h * scale)));
  }

  /**
   * Push the current beam set into the uniforms.
   *
   * Takes plain descriptors rather than lights, so lighting.js decides what a
   * beam is and this module only draws it. `angle` is the outer half-angle in
   * radians and `penumbra` matches the SpotLight parameter of the same name,
   * which is what keeps the shaft in the air and the pool on the floor
   * agreeing about where the soft edge is.
   *
   * @param {Array<{position: THREE.Vector3, direction: THREE.Vector3,
   *                color: THREE.Color, intensity: number, angle: number,
   *                penumbra: number, range: number}>} beams
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
      // The inner cone is where the falloff begins. penumbra = 0 gives a hard
      // edge, 1 fades from the axis outward — the same convention three uses,
      // so a fixture's two representations cannot disagree.
      const inner = Math.cos(beam.angle * (1 - (beam.penumbra ?? 0.5)));
      uniforms.uCosOuter.value[i] = outer;
      uniforms.uCosInner.value[i] = Math.max(inner, outer + 1e-4);
    }
  }

  /**
   * Render the depth prepass. Must run BEFORE the main scene render, because
   * it swaps the scene's materials out and back.
   */
  function renderDepth(scene, camera) {
    if (!enabled) return;

    const previousOverride = scene.overrideMaterial;
    const previousBackground = scene.background;

    // The background is a texture, drawn as a screen-space quad; leaving it on
    // during the depth pass writes the far plane over everything before the
    // geometry is drawn on some drivers, and costs a pointless fullscreen
    // blit on the rest.
    scene.background = null;
    scene.overrideMaterial = depthMaterial;

    renderer.setRenderTarget(depthTarget);
    renderer.clear();
    renderer.render(scene, camera);
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

    // autoClear off, or the composite wipes the frame it is meant to add to.
    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(quadScene, quadCamera);
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
      depthMaterial.dispose();
      material.dispose();
    },
  };
}