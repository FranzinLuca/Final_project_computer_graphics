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
   * that is depends on the sign of a. When a < 0 the interior is between the
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

    /**
     * NOTHING IN FRONT MEANS THE FAR PLANE, AND BOTH WAYS OF SAYING "NOTHING"
     * HAVE TO BE READ AS THE SAME THING.
     *
     * This is the bug that cut every shaft off along the horizon, and it only
     * appeared when the cyclorama was deleted. In a closed room every view ray
     * ended on a wall, so the depth buffer was full and this branch never ran;
     * with an open floor under an empty sky, every ray above the horizon hits
     * nothing at all and reads back whatever the target was CLEARED to.
     *
     * The clear is now explicitly white — see renderDepth — which unpacks to
     * 1.0, the far plane. The old test for that was 'packed >= 1.0', which is
     * one floating-point ulp away from being false: the packing round-trips to
     * 0.99999994 rather than to exactly one. And a black clear, which is what
     * the renderer's default gave before, unpacks to 0.0 and converts to a
     * view depth of -near — so the march ended a few centimetres in front of
     * the lens and the beam vanished. Both ends of the range now mean the same
     * thing: there is no surface along this ray, so march the whole beam.
     */
    float sceneT = uFar;
    if (packed > 0.0 && packed < 0.9999) {
      float viewZ = perspectiveDepthToViewZ(packed, uNear, uFar);
      // viewDir.z is negative (the camera looks down -Z), as is viewZ, so the
      // quotient is a positive distance along the normalised ray.
      sceneT = viewZ / viewDir.z;
    }

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

      /**
       * CLIP THE INTERVAL TO THE SPHERE THE LIGHT ACTUALLY REACHES.
       *
       * A cone is infinite and the throw is not: every sample past uRange
       * is multiplied by a range fade that has already reached zero, so it
       * contributes nothing and costs a full step. That was harmless while
       * the room was closed, because a wall stopped the interval a few units
       * out. With an open sky the far bound is the FAR PLANE — a hundred
       * units — so a fixed step count spread twenty-four samples across a
       * hundred-unit span and landed one or two of them inside the six units
       * that are lit. The shaft did not merely dim; it broke into moving
       * blotches wherever the dither happened to place a sample.
       *
       * The lit region is exactly the ball of radius uRange about the apex,
       * so intersecting the ray with that sphere is the same clip the wall
       * used to provide for free — and it is one quadratic. Steps then land
       * where the light is, which is worth more than any increase in their
       * number.
       */
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
        //
        // The birth fade is nearly twice as long as it was, and the reason is
        // the deleted ceiling. A dome capped every shaft, so the apex was
        // never seen and 0.35 of softening was enough to hide a join nobody
        // could look at. Under an open sky the apex is a point hanging in
        // empty air whenever the camera tilts up, and a cone that starts at a
        // point announces its own geometry. Over 0.6 units the beam is already
        // wide by the time it is bright, so it reads as light arriving from
        // somewhere above the frame — which is what the emitters were moved
        // out of shot to say in the first place.
        float range = 1.0 - smoothstep(uRange[i] * 0.55, uRange[i], dist);
        float birth = smoothstep(0.0, 0.60, dist);

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
 * The composite: a half-resolution buffer added over the finished frame.
 *
 * Trivial by design. All it does is read a texture and add it, and the reason
 * it exists at all is resolution — see `initVolumetrics` below.
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
     * Cut from 1.9 to 1.1 with the palette, and this is the honest cost of the
     * pastel direction.
     *
     * A shaft is additive, and additive light on a nearly-white background has
     * almost nowhere to go: the same density that read as a solid beam against
     * a dark stage now mostly greys the frame, because the accumulation along
     * the part of the ray IN FRONT of the subject washes the subject out
     * without making the beam any more visible behind it.
     *
     * So the shafts become an accent rather than the subject. What carries
     * them now is HUE rather than brightness — four saturated colours against
     * a desaturated ground — which is why the white sparkle beam had to become
     * yellow and why they are worth keeping at all rather than cutting.
     */
    /**
     * Haze density. Back to 1.9 with the dark backdrop.
     *
     * This is the single number that decides whether the room reads as having
     * air in it, and it is entirely a function of what is behind the shafts.
     * Against a pale ground it had to be halved twice or the near half of the
     * frame greyed over; against a dark one the same value is barely visible.
     * Below about 1.2 the shafts are a suggestion; much above 2.2 the
     * instrument starts losing contrast to the haze in front of it.
     */
    /**
     * Raised again, to 2.4, once the march stopped wasting its samples.
     *
     * Not a taste adjustment on top of the previous one: the sphere clip added
     * to the loop above put every step inside the lit ball instead of spreading
     * them across a hundred units of empty sky, so the SAME density now
     * integrates a shaft that is actually sampled. The old 1.9 was chosen
     * against a march that was throwing most of its budget away above the
     * horizon, and it is the reason the beams read as faint even at full level.
     */
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
    /**
     * NORMAL blending, not additive — because this no longer draws onto the
     * frame. It draws into a cleared buffer of its own, and the ADDING happens
     * in the composite. Leaving it additive here would accumulate against
     * whatever the target held, which after the first frame is the previous
     * frame's shafts, and the image would ramp to white over a few seconds.
     *
     * Depth is neither tested nor written in either pass: occlusion is
     * resolved analytically inside the shader against the depth texture, not
     * by the depth unit.
     */
    blending: THREE.NormalBlending,
    depthTest: false,
    depthWrite: false,
  });

  const quadScene = new THREE.Scene();
  const quadCamera = new THREE.Camera();
  quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material));

  /**
   * THE SHAFTS ARE MARCHED AT HALF RESOLUTION AND UPSCALED.
   *
   * This is the fix for the shafts vanishing after a minute or two, and the
   * cause is worth writing down because the symptom pointed at the wrong file
   * entirely.
   *
   * Nothing was wrong with the shader. `quality.js` was doing its job: the
   * raymarch at full resolution is six beams times up to twenty-eight steps
   * per PIXEL, on top of a full-scene depth prepass, and on a machine that
   * cannot hold 50 fps the controller stepped down the ladder until it reached
   * the tier that switches the pass off. Then the retry backoff — which exists
   * precisely so a failing tier is not retried at the same rate — doubled the
   * delay each time, so the shafts went away and stayed away. Every part of
   * that is the controller working correctly on a frame budget that was too
   * expensive to keep.
   *
   * So the cost comes down by a factor of four instead. Marching at half
   * resolution and upsampling is the standard treatment for exactly this
   * effect, and it is unusually well-suited here: a light shaft is a smooth,
   * low-frequency field with no edges of its own, so bilinear interpolation
   * reconstructs it almost exactly. The one place it does not is where a beam
   * is cut off by geometry — those edges are half-resolution now. They were
   * already half-resolution, because the depth buffer they are tested against
   * has been half-size since the pass was written.
   *
   * With the pass this cheap, no tier turns it off any more. A quality ladder
   * that removes a feature is admitting the feature costs too much; making it
   * cost less is the better answer, and it is the same reasoning that deleted
   * the beam cones rather than making them optional.
   */
  const volumeTarget = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    // No depth attachment: the pass tests depth analytically against the
    // texture from the prepass, so there is nothing for a depth buffer here to
    // do except cost memory and bandwidth.
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
    // The volume buffer matches the depth buffer exactly. Marching at a
    // resolution the depth is not available at would mean sampling one depth
    // texel across several march pixels, which puts a visible stair-step on
    // every occlusion edge for no gain.
    volumeTarget.setSize(dw, dh);
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

  /** Scratch for saving the renderer's clear colour around the depth pass. */
  const previousClear = new THREE.Color();

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

    /**
     * CLEARED TO WHITE, WHICH IS THE FAR PLANE.
     *
     * The renderer's default clear is transparent black, and packed depth
     * reads that back as ZERO — the NEAR plane. Every pixel the geometry did
     * not cover therefore claimed there was a surface five centimetres in
     * front of the lens, and the march was clipped to nothing against it.
     *
     * This never showed while the scene was a closed room, because a wall or
     * a dome covered every pixel and the cleared value was never sampled. The
     * moment the enclosure came out, the sky stopped writing depth and every
     * shaft was sliced off along the exact line where the floor ends — the
     * horizon. A clear value is not a detail of a buffer nobody reads; here it
     * is the depth of "nothing", and nothing has to be far away.
     */
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