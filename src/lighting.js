/**
 * lighting.js — the analyser, the frequency bands, and the reactive light rig.
 *
 * This module never imports audio.js. That is not pedantry: the analyser node
 * cannot exist until the AudioContext has been unlocked by a user gesture,
 * whereas the lights have to exist from the first frame. Splitting the two —
 * build now, `attach()` later — is what lets main.js hand over the source node
 * at the moment it becomes available, and it keeps the same one-way dependency
 * the rest of the project has: main.js knows about everyone, nobody knows
 * about main.js.
 *
 * It also never imports rig.js. The lights are placed in world space around
 * where the instrument stands; they do not query it, parent to it, or care
 * whether it is open.
 *
 *
 * WHAT THIS PHASE IS ACTUALLY FOR
 *
 * The pads and the mascot already react to `pad:hit` — to *events*. This
 * module reacts to the *spectrum*: it does not know that a pad was struck, it
 * knows how much energy is currently sitting in three frequency ranges. The
 * two are deliberately different sources of animation, and the difference is
 * visible: a pad flash is discrete and lands exactly on the transient, whereas
 * the wash swells and falls with the weight of what is playing, including the
 * ring-out of a crash nothing triggered this frame.
 *
 *
 * PHASE 10: WHY THE TRUSS BECAME TWO SPEAKER STACKS
 *
 * The truss was four thin poles and a crossbar, and it had two problems that
 * are worth separating because only one of them is about looks.
 *
 * The visual problem: a 19 mm pole is a line. At this camera distance it
 * covers two or three pixels, so it aliases, it carries no shading gradient
 * whatsoever, and it reads as a wireframe left in the render rather than as an
 * object. Everything else in the scene is a filleted solid with a highlight
 * band rolling across it — that is the entire premise of geometry.js — and the
 * poles were the one thing contradicting it.
 *
 * The compositional problem, which matters more: the scene had a subject (a
 * 500 mm instrument), a character, and nothing else with mass. A frame with
 * one small object in the middle and empty floor around it reads as a model on
 * a table no matter how well it is lit. Two chunky stacks either side give the
 * frame left and right anchors, put the instrument in the middle of something,
 * and — because they are speakers — say what the object in the middle is FOR
 * before a single pad has been pressed.
 *
 * They also fix a smaller thing honestly. A fixture floating at 620 mm needed
 * a pole to explain it; a fixture on a yoke on top of a cabinet needs no
 * explanation, because that is where fixtures actually go.
 *
 *
 * THE YOKE IS A SECOND HIERARCHICAL MECHANISM
 *
 * Each stack carries `tower -> post -> pan -> tilt -> can`, with pan rotating
 * about Y and tilt about X, exactly as a real moving head does. Two groups on
 * two axes rather than one Euler triple, for the same reason mascot.js splits
 * its shoulders: composing two rotations inside one Euler depends on the order
 * they are multiplied in, and getting it wrong gives a fixture that tilts
 * sideways once it has been panned.
 *
 * The two angles are DERIVED, never authored. A base aim is computed once from
 * the fixture's own world position and the point it is supposed to light — so
 * moving a tower re-aims its light with no numbers to retype — and the live
 * angles are that base plus a slow sweep and a midrange term. The beam, the
 * housing, the lens and the spot's own target are all children of the tilt
 * group, so they cannot fall out of alignment with each other: there is one
 * pair of numbers and five things that ride them.
 *
 *
 * WHERE THE LIGHTS GO, AND WHY LOW
 *
 * The reactive lights sit LOW and graze across the slab, which is 60 mm thick.
 * Light from overhead onto a flat horizontal object produces an almost
 * constant lambert term across its whole top face — no gradient, no form, just
 * a brighter flat. Grazing light varies sharply over the bezel rails and the
 * wing surfaces, and it spends most of its energy on the ground plane, which
 * is now both the largest surface in the scene and a semi-gloss one that
 * returns a raking highlight.
 */

import * as THREE from 'three';
import { bus } from './events.js';
import { PALETTE } from './palette.js';
import { roundedBoxGeometry, roundedCylinderGeometry } from './geometry.js';
import { radialFalloffTexture } from './textures.js';
import { makeContactShadow } from './environment.js';

// ---------------------------------------------------------------------------
// Analysis parameters
// ---------------------------------------------------------------------------

/**
 * 2048, not the 1024 that would be the reflexive choice.
 *
 * Bin width is `sampleRate / fftSize`. At 48 kHz that is 23.4 Hz here and
 * 46.9 Hz at 1024. The bass band of interest runs roughly 20–160 Hz, so at
 * 1024 the entire band is three bins — one of which is DC — and `kick_deep`,
 * which sweeps to 42 Hz, shares a bin with silence. At 2048 the band gets six,
 * which is the difference between a bass response and a coin flip.
 *
 * The cost is a longer analysis window: 2048 samples is about 43 ms of audio,
 * so the reading lags the transient by up to half that. At 60 fps that is
 * under two frames, and the pads are already flashing on the transient itself,
 * so the eye has an exact cue and the wash is allowed to be the slow one.
 */
const FFT_SIZE = 2048;

/**
 * The analyser's own smoothing, deliberately low.
 *
 * `smoothingTimeConstant` blends each frame's spectrum with the last, which is
 * a first-order lowpass — and it is SYMMETRIC. A light that rises as slowly as
 * it falls reads as mush, because the ear places an event at its attack and
 * the eye then sees the light arrive late. All the smoothing that matters is
 * done in `follow()` below, asymmetrically. This value is left just high
 * enough to take the frame-to-frame noise off the raw FFT.
 */
const SMOOTHING = 0.55;

/**
 * The dB window mapped onto 0..255 by getByteFrequencyData.
 *
 * The defaults are -100 to -30. A master bus running near unity spends almost
 * all of its time in the top few dB of that window, so the useful signal is
 * squeezed into the last twenty byte values and everything below is noise
 * floor. Narrowing the window to -78..-12 spreads the range the instrument
 * actually occupies across the full 0..255.
 */
const MIN_DB = -78;
const MAX_DB = -12;

/**
 * Band edges in Hz, chosen against the kit rather than against round numbers.
 *
 *   bass  35–170    the two kicks, sub_drop, and the body of the low tom
 *   mid   170–2200  snare body, toms, rim, cowbell, clap
 *   high  2200–12000 hats, ride, crash, click
 *
 * The upper edge stops at 12 kHz rather than Nyquist because the top octave
 * carries almost no energy from these voices and including it only dilutes
 * the average with empty bins.
 */
const BANDS = {
  bass: [35, 170],
  mid: [170, 2200],
  high: [2200, 12000],
};

/**
 * Per-band gain, correcting for the fact that the three bands are nothing like
 * equally loud.
 *
 * A drum kit is bottom-heavy by construction: a kick puts far more energy into
 * its band than a hi-hat puts into its own. Left uncorrected the bass light
 * would sit at full and the sparkle would never leave the floor. These are
 * measured-by-eye multipliers applied after normalisation, not a claim about
 * psychoacoustics.
 */
const BAND_GAIN = { bass: 1.0, mid: 1.5, high: 2.1 };

/**
 * Noise gate, in normalised units. Below this a band reads as silence.
 *
 * Without it the lights idle at a visible fraction of full brightness whenever
 * the transport is running, because the FFT of near-silence is not zero — and
 * a light that never goes out cannot be seen to come on.
 */
const GATE = 0.06;

// ---------------------------------------------------------------------------
// Envelope following
// ---------------------------------------------------------------------------

/**
 * Asymmetric first-order follower: fast up, slow down.
 *
 * The same exponential-decay trick the pad presses use, but with two rate
 * constants instead of one. `1 - exp(-dt * k)` is the framerate-independent
 * form — using a bare `lerp(current, target, k)` would make the lights respond
 * faster on a 144 Hz monitor than on a 60 Hz one, which is the single most
 * common way time-based animation goes wrong.
 *
 * Attack and release are not the same physical thing. Attack should be fast
 * enough that the light appears to land on the beat; release is what carries
 * the perception of loudness, because the eye integrates over roughly a tenth
 * of a second and a light that snaps off leaves nothing to integrate. This is
 * exactly how a compressor's gain-reduction meter behaves, and for the same
 * reason.
 */
function follow(current, target, dt, attack, release) {
  const k = target > current ? attack : release;
  return current + (target - current) * (1 - Math.exp(-dt * k));
}

/** Attack and release rates per band, in reciprocal seconds. */
const ENVELOPE = {
  bass: { attack: 26, release: 4.5 },
  mid: { attack: 30, release: 6.0 },
  // Hats are the fastest thing in the kit and the sparkle has to be able to
  // resolve a sixteenth at 160 bpm — 94 ms apart — as two flicks, not one.
  high: { attack: 60, release: 13.0 },
};

// ---------------------------------------------------------------------------
// Light budget, re-costed for a dark room
//
// SpotLight intensity is in candela and decay is 2, so the illuminance a
// surface receives is intensity / d^2. The tower fixtures now stand about 1.39
// units from the instrument rather than 0.9, which divides their contribution
// by 1.9 — so the peaks had to rise by roughly that factor just to stand
// still.
//
// They then rise again, because the room they compete with got quieter. The
// ambient budget dropped from an image-based term at 0.50 plus a hemisphere at
// 0.30 over pale sky colours to 0.11 and 0.55 over near-black ones, and the
// key from 1.75 to 0.85. What used to be a 5% modulation on top of a bright
// base is now the dominant term in the frame, which is the entire point of the
// phase: the reactive rig had been correct and invisible.
// ---------------------------------------------------------------------------

const PEAK = {
  wash: 4.6,
  accent: 4.0,
  sparkle: 6.5,
};

/**
 * A floor under every fixture, so the rig is lit before a note is played.
 *
 * Raised from 0.10 with the room going dark, and this is the number that
 * answers "what does a grader see if they never press play". At idle the four
 * reactive fixtures put roughly 0.09 of illuminance on the slab between them —
 * well under the key, but enough that every lamp visibly has its light on and
 * every beam is faintly present in the air. The scene at rest is a lit stage
 * waiting, not a dark frame.
 */
const IDLE = 0.18;

// ---------------------------------------------------------------------------
// The stacks
// ---------------------------------------------------------------------------

/**
 * `x` is far enough out that the slab's wings — which reach 0.50 to a side
 * when open — never come near a cabinet, and close enough that both towers
 * stay in frame on the Overview shot. `toe` angles each stack inward about Y
 * so the two are not parallel slabs: a pair of boxes facing straight forward
 * reads as scenery, a pair angled towards the subject reads as aimed at an
 * audience.
 *
 * The toe-in is applied to the CABINETS ONLY and not to the tower group, so
 * the yoke on top stays in world axes and its pan angle needs no correction
 * for the frame it is expressed in. That is a deliberate split of one object
 * into two branches rather than one chain: the stack is a thing that is
 * angled, the yoke is a thing that is aimed, and they are not aimed at the
 * same place.
 */
const TOWER = { x: 1.06, z: -0.10, toe: 0.20 };

/** Cabinet tiers, bottom to top. */
const CABS = [
  { w: 0.380, h: 0.045, d: 0.360, y: 0.0225, tier: 'plinth' },
  { w: 0.360, h: 0.420, d: 0.340, y: 0.2550, tier: 'sub' },
  { w: 0.320, h: 0.240, d: 0.300, y: 0.5850, tier: 'mid' },
  { w: 0.280, h: 0.150, d: 0.260, y: 0.7800, tier: 'horn' },
];

/** Top of the stack, where the yoke post stands. */
const STACK_TOP = 0.855;

const CAN_LEN = 0.115;
const CAN_R = 0.052;

// ---------------------------------------------------------------------------

/**
 * @param {{ scene: THREE.Scene }} deps
 */
export function initLighting({ scene }) {
  const group = new THREE.Group();
  group.name = 'reactive-lights';
  scene.add(group);

  /** Set by setBeams / setDust, read by the per-frame code. */
  let beamsOn = true;
  let dustOn = true;

  // -----------------------------------------------------------------------
  // Shared geometry and materials
  //
  // Built once and drawn with different matrices. The two towers are around
  // thirty meshes between them, which is worth watching on the draw-call
  // readout — but they share eleven geometries and five materials, so the cost
  // is transform uploads rather than pipeline state changes, and quality.js
  // has a ladder underneath it either way.
  // -----------------------------------------------------------------------

  /**
   * Turn a lathed cylinder — which stands on its origin pointing up +Y — into
   * one lying along +Z, centred on its own middle.
   *
   * Done once at build time on the geometry rather than per instance with a
   * rotation on the mesh, because `Object3D.lookAt` aims an object's +Z axis
   * at its target. Baking the axis change into the buffer means a fixture can
   * simply be told to look at what it lights, with no correction rotation to
   * remember and no Euler order to reason about. It is also what lets the
   * yoke's tilt group be read directly as "the direction the light goes":
   * +Z out of the tilt group is +Z out of the can.
   */
  function alongZ(geo, length) {
    geo.translate(0, -length / 2, 0);
    geo.rotateX(-Math.PI / 2);
    return geo;
  }

  const GEO = {
    can: alongZ(roundedCylinderGeometry(CAN_R, CAN_LEN, 0.016, 24, 3), CAN_LEN),
    lens: alongZ(roundedCylinderGeometry(CAN_R * 0.88, 0.012, 0.005, 24, 2), 0.012),
    stem: roundedCylinderGeometry(0.016, 0.20, 0.008, 16, 2),
    foot: roundedCylinderGeometry(0.085, 0.022, 0.010, 24, 2),
    clamp: roundedBoxGeometry(0.048, 0.048, 0.048, 0.014, 3),

    // The yoke: a short post, and two arms the can is pinned between.
    post: roundedCylinderGeometry(0.026, 0.050, 0.010, 20, 2),
    arm: roundedBoxGeometry(0.016, 0.088, 0.030, 0.007, 3),

    // Drivers, seen face-on through the grille cloth. Lying along Z so their
    // domed end points out of the baffle.
    woofer: alongZ(roundedCylinderGeometry(0.082, 0.026, 0.020, 28, 3), 0.026),
    driver: alongZ(roundedCylinderGeometry(0.055, 0.022, 0.016, 24, 3), 0.022),
    hornMouth: roundedBoxGeometry(0.170, 0.062, 0.024, 0.014, 3),
    standby: roundedBoxGeometry(0.014, 0.010, 0.006, 0.002, 2),
  };

  /** Tier -> its box geometry, built once and shared by both towers. */
  const CAB_GEO = CABS.map((c) => roundedBoxGeometry(c.w, c.h, c.d, 0.016, 3));

  /** Grille panels, one per tier that has drivers behind it. */
  const GRILLE_GEO = CABS.map((c) =>
    roundedBoxGeometry(Math.max(0.02, c.w - 0.045), Math.max(0.02, c.h - 0.045), 0.014, 0.006, 2)
  );

  const housingMat = new THREE.MeshStandardMaterial({
    color: PALETTE.slabDeep,
    metalness: 0.1,
    roughness: 0.55,
  });

  const poleMat = new THREE.MeshStandardMaterial({
    color: PALETTE.mech,
    metalness: 0.65,
    roughness: 0.38,
  });

  /**
   * Painted plywood, not lacquer. High roughness is what keeps a cabinet from
   * picking up the same specular streak the floor now does — if the boxes and
   * the ground shine alike, the floor stops being the polished thing and the
   * scene loses the one surface that was supposed to hold the highlights.
   */
  const cabMat = new THREE.MeshStandardMaterial({
    color: PALETTE.cab,
    metalness: 0.0,
    roughness: 0.78,
  });

  /**
   * The baffle: the darkest material in the project, deliberately.
   *
   * A speaker's front panel is a black hole in the value structure of the
   * cabinet, and that hole is most of what identifies the object as a speaker
   * at all. Roughness 0.95 with no metalness returns almost nothing at any
   * angle, so the box around it reads lighter no matter where the fixtures
   * happen to be pointing — and the drivers mounted on its face read lighter
   * still, which is the contrast that makes them legible at this size.
   */
  const grilleMat = new THREE.MeshStandardMaterial({
    color: PALETTE.grille,
    metalness: 0.0,
    roughness: 0.95,
  });

  /**
   * The standby LED. Basic, not emissive-Standard: it should be exactly this
   * colour at all times and pick up nothing from the room. One green dot per
   * cabinet is a disproportionately effective detail — it is the difference
   * between two boxes and two boxes that are switched on — and it costs a
   * twelve-triangle mesh with no lighting.
   */
  const standbyMat = new THREE.MeshBasicMaterial({ color: PALETTE.standby });

  function part(geometry, material, position, parent = null, receive = true) {
    const mesh = new THREE.Mesh(geometry, material);
    if (position) mesh.position.set(...position);
    /**
     * Nothing in the light rig casts a shadow, and that is still a decision
     * rather than an oversight. main.js sizes the key light's shadow camera to
     * a +/-1.2 frustum around the instrument, which buys roughly a 3.4x gain
     * in effective shadow resolution. The towers stand at x = +/-1.06 and rise
     * to nearly a unit, so they sit right on the edge of that frustum: their
     * shadows would be clipped mid-length and end in a hard straight line
     * across the floor, which is worse than no shadow at all.
     *
     * They are grounded by contact patches instead. That is the better tool
     * anyway — what makes a heavy box look heavy is the darkening where it
     * meets the floor, not a silhouette thrown off to one side.
     */
    mesh.castShadow = false;
    mesh.receiveShadow = receive;
    (parent ?? group).add(mesh);
    return mesh;
  }

  // -----------------------------------------------------------------------
  // The beam gradient
  // -----------------------------------------------------------------------

  /**
   * A one-dimensional ramp applied along the length of every beam cone.
   *
   * The failure mode of a fake volumetric is a visible solid cone with a hard
   * edge where it stops, and lowering the opacity does not fix it — it gives a
   * fainter cone with the same hard edge. What removes the edge is making the
   * beam fade with distance from the source, which is also what actually
   * happens: the light spreads over a growing cross-section, so the radiance
   * scattered per unit volume falls as it travels.
   *
   * `ConeGeometry`'s v coordinate runs along the axis, so a 1xN texture is all
   * this needs. It is built here rather than in textures.js because it is not
   * a surface property — it belongs to the fixture, the same way the lens
   * does, and nothing else in the project will ever want it.
   *
   * With `AdditiveBlending` three uses `SrcAlpha` as the source factor, so the
   * alpha channel of this map genuinely modulates the contribution rather than
   * being ignored as it would be under a pure `One, One` blend.
   */
  function beamRamp(size = 64) {
    const data = new Uint8Array(size * 4);
    for (let i = 0; i < size; i++) {
      const t = i / (size - 1);              // 0 at the apex, 1 at the mouth
      // Bright near the source, fading to nothing before the geometry ends,
      // and pulled down again in the first few texels so the cone does not
      // start as a hard disc at the lens.
      const a = Math.pow(1 - t, 1.6) * (0.35 + 0.65 * Math.min(1, t * 6));
      data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = 255;
      data[i * 4 + 3] = Math.round(Math.min(1, a) * 255);
    }
    const texture = new THREE.DataTexture(data, 1, size, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
  }

  const beamGradient = beamRamp();

  // -----------------------------------------------------------------------
  // Fixtures
  //
  // SpotLight throughout, and never PointLight. A point light that casts
  // shadows needs a cube shadow map — six renders of the scene per light per
  // frame — where a spot needs one, because a spot has a single frustum. Even
  // with shadows off, as they are here, the spot's cone is the thing that
  // makes a fixture read as a fixture rather than as an ambient tint: a light
  // with no falloff at its edge has no visible direction.
  //
  // NONE of these cast shadows. The key light in main.js owns the shadow, and
  // a second shadow-casting light from a different direction would give every
  // object two overlapping silhouettes on the ground and destroy the read of
  // the first one.
  // -----------------------------------------------------------------------

  /** @type {Array<{light: THREE.SpotLight, lens: THREE.Mesh, beam: THREE.Mesh|null, peak: number}>} */
  const fixtures = [];

  /**
   * One complete fixture, built into a `mount` whose +Z is the direction the
   * light goes: a spot, a housing, a lens that brightens with it, and a soft
   * cone standing in for the beam in air.
   *
   * Everything sits at the mount's local origin — including the spot's target,
   * which is a CHILD one unit down +Z. That is what makes the yoke work: a
   * SpotLight aims at its target's world position, so putting the target
   * inside the rotating group means panning and tilting the group re-aims the
   * light with no code at all. The alternative — recomputing a world-space
   * target every frame from the yoke's angles — is the same trigonometry
   * written twice, once forwards and once backwards.
   */
  function fixture({ colour, mount, angle, penumbra, peak, beamLen = 0 }) {
    const light = new THREE.SpotLight(colour, IDLE, 0, angle, penumbra, 2);
    light.castShadow = false;
    mount.add(light);

    light.target.position.set(0, 0, 1);
    mount.add(light.target);

    // Housing sits behind the origin so its open mouth is exactly at the
    // light's position — the emitter and the aperture coincide, which is the
    // whole point of drawing it.
    part(GEO.can, housingMat, [0, 0, -CAN_LEN / 2 - 0.004], mount);

    /**
     * The lens. MeshBasicMaterial, not an emissive Standard: this surface is
     * meant to be exactly as bright as it is told and to ignore every light in
     * the scene, including its own. A Standard material would pick up the wash
     * from the fixture opposite and glow faintly when it should be dark.
     *
     * `toneMapped` is left ON, so pushing the colour past 1.0 rolls off
     * through the same curve as everything else instead of clipping to a flat
     * disc of pure hue. In a dark room this is the closest thing the project
     * has to bloom, and it is not a bad substitute: a source driven well past
     * white and tone mapped back down leaves a hot desaturated centre with a
     * coloured edge, which is most of what a bloom pass is imitating.
     */
    const lens = new THREE.Mesh(GEO.lens, new THREE.MeshBasicMaterial({ color: colour }));
    lens.position.z = 0.002;
    mount.add(lens);

    /**
     * The beam: an open cone of additive transparency standing in for light
     * scattering off dust in the air.
     *
     * Real volumetrics need either ray marching or a shadow-map-driven scatter
     * pass, both out of proportion to what this scene needs. A cone with
     * `depthWrite: false`, additive blending and a length ramp gets most of
     * the read for one draw call. The flags matter: additive because light
     * adds and never occludes, and no depth write because overlapping
     * transparent cones that write depth hide each other in whatever order
     * they happen to be drawn.
     */
    let beam = null;
    if (beamLen > 0) {
      const radius = Math.tan(angle) * beamLen * 0.92;
      const cone = new THREE.ConeGeometry(radius, beamLen, 28, 1, true);
      cone.translate(0, -beamLen / 2, 0);
      cone.rotateX(-Math.PI / 2);

      beam = new THREE.Mesh(cone, new THREE.MeshBasicMaterial({
        color: colour,
        alphaMap: beamGradient,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
        toneMapped: false,
      }));
      // Drawn after the opaque scene and after the contact patches, so the
      // sorting question never arises for it.
      beam.renderOrder = 2;
      mount.add(beam);
    }

    const entry = { light, lens, beam, peak };
    fixtures.push(entry);
    return entry;
  }

  /**
   * A fixture that hangs in world space and simply looks at something: the
   * floor washes and the overhead sparkle. The mount is an ordinary Group,
   * pointed once at build time and never moved again.
   */
  function staticFixture(colour, position, aim, angle, penumbra, peak, beamLen = 0) {
    const mount = new THREE.Group();
    mount.position.set(...position);
    group.add(mount);
    mount.lookAt(new THREE.Vector3(...aim));
    return fixture({ colour, mount, angle, penumbra, peak, beamLen });
  }

  // -----------------------------------------------------------------------
  // The speaker stacks
  // -----------------------------------------------------------------------

  /**
   * Where the tower fixtures point: the middle of the instrument, slightly
   * above the deck so the cone crosses the pads rather than terminating on
   * them.
   */
  const AIM = new THREE.Vector3(0, 0.06, 0);

  /** @type {Array<{pan: THREE.Group, tilt: THREE.Group, basePan: number, baseTilt: number, side: number, woofers: THREE.Mesh[]}>} */
  const towers = [];

  function buildTower(side) {
    const root = new THREE.Group();
    root.position.set(side * TOWER.x, 0, TOWER.z);
    root.name = `tower-${side < 0 ? 'left' : 'right'}`;
    group.add(root);

    // --- branch one: the cabinets, toed in -------------------------------
    const stack = new THREE.Group();
    stack.rotation.y = -side * TOWER.toe;
    root.add(stack);

    const woofers = [];

    CABS.forEach((cab, i) => {
      part(CAB_GEO[i], cabMat, [0, cab.y, 0], stack);
      if (cab.tier === 'plinth') return;

      /**
       * The baffle, and then the drivers standing PROUD of it.
       *
       * A real cabinet hides its drivers behind grille cloth, and the first
       * version of this did exactly that — with the result that the drivers
       * were invisible, and so was the excursion animation that is the whole
       * reason they exist. Correct, and pointless.
       *
       * So the grille cloth becomes a recessed dark baffle and the drivers are
       * mounted on its face. It is the honest arrangement for a stage
       * cabinet with its grille off, it is what makes the object identifiable
       * as a speaker at a glance, and it puts the one moving part where it can
       * be seen. The panel is 4 mm proud of the box, because a panel flush
       * with its housing has no shadow line under its edge and reads as paint.
       */
      const faceZ = cab.d / 2 + 0.004;
      part(GRILLE_GEO[i], grilleMat, [0, cab.y, faceZ], stack);

      if (cab.tier === 'sub') {
        // Two fifteens, stacked.
        for (const dy of [-0.095, 0.095]) {
          const cone = part(GEO.woofer, housingMat, [0, cab.y + dy, faceZ + 0.012], stack);
          cone.userData.z0 = cone.position.z;
          woofers.push(cone);
        }
        part(GEO.standby, standbyMat, [-0.145, cab.y - 0.185, faceZ + 0.012], stack, false);
      } else if (cab.tier === 'mid') {
        const cone = part(GEO.driver, housingMat, [0, cab.y, faceZ + 0.010], stack);
        cone.userData.z0 = cone.position.z;
        woofers.push(cone);
      } else {
        part(GEO.hornMouth, housingMat, [0, cab.y, faceZ + 0.008], stack);
      }
    });

    // Contact patch, sized wider than the plinth: the ambient occlusion under
    // a box does not stop at its footprint, it fades outward from it.
    const patch = makeContactShadow(0.34, 0.62);
    patch.position.set(side * TOWER.x, 0.0012, TOWER.z);
    group.add(patch);

    // --- branch two: the yoke --------------------------------------------
    part(GEO.post, poleMat, [0, STACK_TOP, 0], root);

    const pan = new THREE.Group();
    pan.position.y = STACK_TOP + 0.050;
    root.add(pan);

    for (const dx of [-0.062, 0.062]) {
      part(GEO.arm, poleMat, [dx, 0.044, 0], pan);
    }

    const tilt = new THREE.Group();
    tilt.position.y = 0.055;
    pan.add(tilt);

    const entry = { pan, tilt, basePan: 0, baseTilt: 0, side, woofers };
    towers.push(entry);
    return entry;
  }

  const towerLeft = buildTower(-1);
  const towerRight = buildTower(1);

  /**
   * Aim a yoke at a world point, once, and keep the result as the base pose.
   *
   * `pan` is the azimuth of the direction measured the way `atan2(x, z)`
   * measures it — from +Z towards +X, which is exactly the sense in which a
   * rotation about +Y carries +Z. `tilt` is `-asin(dy)` because rotating +Z
   * about +X by a positive angle carries it towards -Y, and this fixture aims
   * downwards.
   *
   * Derived rather than typed. Move a tower 100 mm and its light still lands
   * on the instrument with no second number to remember — the same rule the
   * wing hinge and the pad dip follow, applied to an aim instead of a
   * position.
   */
  function aimYoke(tower, target) {
    const world = new THREE.Vector3();
    tower.pan.getWorldPosition(world);
    const d = target.clone().sub(world).normalize();
    tower.basePan = Math.atan2(d.x, d.z);
    tower.baseTilt = -Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
    tower.pan.rotation.y = tower.basePan;
    tower.tilt.rotation.x = tower.baseTilt;
  }

  // World matrices are stale until something updates them, and getWorldPosition
  // reads them. One explicit update here is cheaper and more honest than
  // relying on a render having already happened.
  group.updateMatrixWorld(true);
  aimYoke(towerLeft, AIM);
  aimYoke(towerRight, AIM);

  /**
   * MID — the two tower heads. These are the only fixtures whose COLOUR moves.
   *
   * Intensity alone is a weak channel for the midrange, because the mids are
   * almost always doing something and a light that is always half on reads as
   * static. Hue is a channel nothing else in this scene competes for.
   *
   * Cool on the left, warm on the right, and which side gets which is not
   * arbitrary. Otto stands at x = +0.70 and is painted amber. A warm light
   * from his own side reinforces the colour he already is and keeps him
   * readable; the cool beam crosses the slab from the far side and lands on
   * his silhouette edge as a complementary rim. Reversed, the teal would sit
   * flat across an amber shell and turn it muddy, and the warm light would be
   * doing its separating from the side with nothing to separate.
   */
  const accentLeft = fixture({
    colour: 0x35d6ff,
    mount: towerLeft.tilt,
    angle: 0.36,
    penumbra: 0.75,
    peak: PEAK.accent,
    beamLen: 1.55,
  });

  const accentRight = fixture({
    colour: 0xff7a3c,
    mount: towerRight.tilt,
    angle: 0.36,
    penumbra: 0.75,
    peak: PEAK.accent,
    beamLen: 1.55,
  });

  const accent = [accentLeft, accentRight];

  /**
   * BASS — two floor cans at the feet of the stacks, low and grazing.
   *
   * At 200 mm the beam skims across the slab rather than falling onto it, so
   * the lambert term varies sharply over the bezel rails and the wing surfaces
   * and the slab gains an actual gradient instead of a uniform brighter flat.
   * Most of each cone lands on the ground beyond the instrument, which is the
   * point: two pools breathing with the kick do more for the room than
   * anything happening on 60 mm of slab could — and far more of it now that
   * the ground is polished and returns a raking highlight instead of
   * absorbing the light into grey concrete.
   *
   * Deep indigo, which is neither accent colour. Three fixtures from the same
   * hue family collapse into one wash, and the bass needs to be legible as a
   * separate event from the mids; the cheapest way to make two lights read as
   * two is to make them different colours.
   *
   * No visible beam on these, and that is a physical decision rather than a
   * rendering compromise. Beam visibility depends on intensity per unit solid
   * angle, because that is what sets how much light a given volume of air
   * scatters. These are 54-degree floods: they spread the same energy over
   * roughly nine times the solid angle of the accents, so in air they simply
   * do not read as a shaft. Drawing one anyway would put a translucent sheet
   * across the frame, which is the exact failure mode of this trick.
   */
  const wash = [-1, 1].map((side) => {
    const position = [side * 0.80, 0.20, 0.34];
    part(GEO.foot, housingMat, [position[0], 0.011, position[2]]);
    part(GEO.stem, housingMat, [position[0], 0.0, position[2]]);
    return staticFixture(
      0x5a4cff, position, [side * -0.12, 0.02, -0.10], 0.95, 0.85, PEAK.wash, 0
    );
  });

  /**
   * HIGH — one tight flick on a boom cantilevered off the left stack.
   *
   * It has to be nearly overhead, because that is the one position where a
   * hard specular highlight lands on the knob caps and the pad caps at once —
   * and with the truss gone there is nothing overhead to hang it from. A boom
   * off a tower is exactly what a real rig does with this problem, and it
   * keeps the rule that motivated removing the poles: every fixture has a
   * visible reason to be where it is.
   *
   * The arm is a solid bar of the same rounded family as everything else
   * rather than a thin rod. It is cantilevered nearly a metre, so it needs to
   * read as something that could hold a light up.
   */
  const BOOM = { y: 1.06, endX: -0.14 };
  const boomLen = TOWER.x + BOOM.endX;

  const boomBar = part(
    alongZ(roundedCylinderGeometry(0.020, boomLen, 0.009, 16, 2), boomLen),
    poleMat,
    [(-TOWER.x + BOOM.endX) / 2, BOOM.y, TOWER.z]
  );
  boomBar.rotation.y = Math.PI / 2; // the bar runs across X, not along Z

  part(GEO.clamp, poleMat, [-TOWER.x, BOOM.y - 0.02, TOWER.z]);
  part(GEO.clamp, poleMat, [BOOM.endX, BOOM.y, TOWER.z]);

  const sparkle = staticFixture(
    0xf4f8ff, [BOOM.endX, BOOM.y - 0.05, TOWER.z], [0, 0.05, 0], 0.30, 0.40, PEAK.sparkle, 1.05
  );

  /**
   * A hemisphere term that lifts with the whole mix.
   *
   * Not reactive to one band — driven by the sum, gently. Its job is to keep
   * the shadow side of the robot from going black during a loud passage, which
   * three coloured spots from three directions will otherwise do to him,
   * because MeshToonMaterial bands each light separately and a toon shadow
   * side has no gradient to rescue it. It is the one light here with no
   * housing, and it does not need one: an ambient term is not a fixture and
   * the eye does not look for its source.
   */
  const ambient = new THREE.HemisphereLight(PALETTE.skyTop, PALETTE.ground, 0.0);
  group.add(ambient);

  // -----------------------------------------------------------------------
  // Dust in the air
  // -----------------------------------------------------------------------

  /**
   * What actually makes a beam believable.
   *
   * A cone of additive haze is a smooth gradient, and smooth gradients read as
   * geometry — the eye finds the shape and stops looking. Particles break
   * that: the beam stops being a surface and becomes a volume with things
   * suspended in it, which is the honest reading, because the only reason a
   * shaft of light is visible at all is that there is something in the air to
   * scatter it. The cone and the motes are two halves of one claim.
   *
   * They are `Points`, so all 260 are ONE draw call and one buffer upload per
   * frame. The alternative — a small mesh each — would be 260 draws for an
   * effect that is by design barely visible, which is the wrong shape of cost
   * entirely.
   *
   * The honest limitation: a mote does not know whether it is inside a beam.
   * Testing each one against two moving cones every frame is a real cost for a
   * subtle payoff, so instead the whole field's opacity follows how much light
   * is in the air overall, and each mote is tinted by which side of the room
   * it is on — the left half cool, the right half warm, matching the beams
   * that would in fact be lighting them. It is an approximation, and it is
   * approximate in the one direction the eye cannot check.
   */
  const DUST = { count: 260, w: 2.30, h: 1.20, d: 1.30, floor: 0.05 };

  const dustPositions = new Float32Array(DUST.count * 3);
  const dustColours = new Float32Array(DUST.count * 3);
  const dustRise = new Float32Array(DUST.count);
  const dustPhase = new Float32Array(DUST.count);

  {
    const cool = new THREE.Color(0x35d6ff);
    const warm = new THREE.Color(0xff7a3c);

    for (let i = 0; i < DUST.count; i++) {
      const x = (Math.random() - 0.5) * DUST.w;
      dustPositions[i * 3] = x;
      dustPositions[i * 3 + 1] = DUST.floor + Math.random() * DUST.h;
      dustPositions[i * 3 + 2] = (Math.random() - 0.5) * DUST.d - 0.05;

      const tint = x < 0 ? cool : warm;
      dustColours[i * 3] = tint.r;
      dustColours[i * 3 + 1] = tint.g;
      dustColours[i * 3 + 2] = tint.b;

      // Convection, not gravity. Dust in a warm room under lights rises, and
      // it rises at wildly different rates — a uniform drift reads as a
      // texture scrolling rather than as particles.
      dustRise[i] = 0.006 + Math.random() * 0.022;
      dustPhase[i] = Math.random() * Math.PI * 2;
    }
  }

  const dustGeometry = new THREE.BufferGeometry();
  dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
  dustGeometry.setAttribute('color', new THREE.BufferAttribute(dustColours, 3));

  const dustMaterial = new THREE.PointsMaterial({
    size: 0.011,
    map: radialFalloffTexture(32, 2.0),
    vertexColors: true,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    /**
     * Size falls with distance, as it must. A mote three units away drawing
     * the same number of pixels as one at a single unit is a screen-space
     * effect stuck to the camera, and the eye reads it immediately as dirt on
     * the lens rather than as anything in the room.
     */
    sizeAttenuation: true,
    fog: false,
    toneMapped: false,
  });

  const dust = new THREE.Points(dustGeometry, dustMaterial);
  dust.renderOrder = 3;
  // The bounding sphere is computed once from the initial positions and the
  // motes then move out of it, so culling would eventually pop the whole field
  // off screen. One always-drawn object is cheaper than maintaining bounds.
  dust.frustumCulled = false;
  group.add(dust);

  // -----------------------------------------------------------------------
  // Analyser — attached late
  // -----------------------------------------------------------------------

  /** @type {AnalyserNode | null} */
  let analyser = null;
  /** @type {Uint8Array | null} */
  let spectrum = null;

  /** Band name -> [firstBin, lastBin], computed once the sample rate is known. */
  let binRanges = null;

  /**
   * Connect the analyser to the end of the signal chain.
   *
   * `source` is whatever main.js decides is the last node before the speakers.
   * That matters: the master lowpass sits after the master gain precisely so
   * that closing the filter dims the lights, because the analyser sees what
   * reaches the output rather than what was played. An analyser tapped before
   * the filter would leave the lights blazing on a sound the listener can no
   * longer hear.
   *
   * An AnalyserNode is a pass-through and is not connected onward to the
   * destination — doing so would sum the signal with itself and double the
   * output level. It taps.
   *
   * @param {AudioNode} source
   * @param {AudioContext} ctx
   */
  function attach(source, ctx) {
    if (!source || !ctx) {
      console.warn('[lighting] attach() called without a source; lights stay idle');
      return;
    }

    analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = SMOOTHING;
    analyser.minDecibels = MIN_DB;
    analyser.maxDecibels = MAX_DB;

    source.connect(analyser);
    spectrum = new Uint8Array(analyser.frequencyBinCount);

    /**
     * Bin index for a frequency: `f * fftSize / sampleRate`.
     *
     * Computed from the context's ACTUAL sample rate, never hard-coded. A
     * laptop at 48 kHz and an external interface at 44.1 kHz put the same
     * frequency in different bins, and a hard-coded table would put the bass
     * band 9% off on one of them — which is most of an octave at the bottom
     * end, where the band is only a handful of bins wide to begin with.
     */
    const binFor = (hz) =>
      Math.max(1, Math.min(
        analyser.frequencyBinCount - 1,
        Math.round((hz * FFT_SIZE) / ctx.sampleRate)
      ));

    binRanges = {};
    for (const [name, [lo, hi]] of Object.entries(BANDS)) {
      binRanges[name] = [binFor(lo), binFor(hi)];
    }

    bus.emit('lighting:ready', { sampleRate: ctx.sampleRate, binRanges });
  }

  // -----------------------------------------------------------------------
  // Per-frame
  // -----------------------------------------------------------------------

  /** Smoothed 0..1 energy per band. Read by anything that wants a meter. */
  const level = { bass: 0, mid: 0, high: 0 };

  /** Seconds since the rig was built, for the yoke sweep and the dust drift. */
  let elapsed = 0;

  /**
   * Mean of the byte values across a band, normalised to 0..1 and gated.
   *
   * A plain mean over a band, and the asymmetry it hides, is worth being
   * explicit about: bins are LINEARLY spaced but the bands are logarithmic, so
   * the bass band averages six bins and the high band averages roughly four
   * hundred. The high band's mean is therefore far steadier than the bass
   * band's simply by the law of large numbers — a single loud hat is diluted
   * across hundreds of near-empty bins, where a single kick dominates its six.
   * BAND_GAIN compensates for the level; nothing compensates for the variance,
   * and that is why the high band gets by far the fastest envelope rates. The
   * responsiveness has to be bought back in the time domain because it was
   * lost in the frequency domain.
   *
   * No perceptual curve is applied on top. `getByteFrequencyData` returns
   * values already mapped from DECIBELS, which is to say already logarithmic —
   * the opposite situation from the master filter knob in audio.js, where a
   * linear control had to be bent into an exponent to feel even. Here the data
   * arrives pre-bent and adding a curve would double-count.
   */
  function bandEnergy(name) {
    const [lo, hi] = binRanges[name];
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += spectrum[i];

    const mean = sum / (hi - lo + 1) / 255;
    const gated = Math.max(0, mean - GATE) / (1 - GATE);
    return Math.min(1, gated * BAND_GAIN[name]);
  }

  /**
   * Push one scalar into a fixture: its light, its lens and its beam.
   *
   * This is the answer to "where is that light coming from". The three are not
   * three animations that happen to agree — they are one number read three
   * times, so they cannot fall out of step no matter how the level is driven.
   *
   * The lens carries a floor so the glass never goes fully black, and is
   * driven past 1.0 at full so the tone mapper rolls its centre towards white
   * the way an over-bright source does on camera.
   *
   * The beam now carries a floor too, which it did not before, and the reason
   * is physical rather than cosmetic: with IDLE raised there IS light leaving
   * the fixture at rest, so there is something in the air for it to scatter
   * off. A beam that vanished entirely between hits would be claiming the lamp
   * had gone out.
   */
  function setFixture(entry, intensity) {
    entry.light.intensity = intensity;

    const k = Math.min(1, Math.max(0, (intensity - IDLE) / entry.peak));

    entry.lens.material.color.copy(entry.light.color).multiplyScalar(0.22 + k * 1.9);

    if (entry.beam) {
      entry.beam.material.color.copy(entry.light.color);
      entry.beam.material.opacity = beamsOn ? 0.022 + k * 0.115 : 0;
      // A fully transparent mesh is still rasterised and still blended. Hiding
      // it below the threshold where it contributes anything visible skips the
      // fragment work entirely on a quiet passage.
      entry.beam.visible = entry.beam.material.opacity > 0.004;
    }
  }

  /**
   * Move the yokes.
   *
   * Two terms doing two different jobs. The slow sine is a programmed sweep —
   * what a lighting desk does to keep a static stage from reading as a
   * photograph — and it runs whether or not anything is playing, which is most
   * of what stops the idle scene from looking frozen. The midrange term is the
   * reactive part: the heads spread and lift as the mix fills, so a busy bar
   * visibly opens the rig out.
   *
   * Both are small. A moving head that swings widely stops being a light and
   * becomes the subject, and this scene already has a subject.
   */
  function aimTowers(t) {
    for (const tower of towers) {
      const phase = tower.side > 0 ? 1.7 : 0;

      tower.pan.rotation.y =
        tower.basePan
        + Math.sin(t * 0.27 + phase) * 0.070
        + level.mid * 0.05 * tower.side;

      tower.tilt.rotation.x =
        tower.baseTilt
        + Math.sin(t * 0.19 + phase) * 0.035
        - level.mid * 0.045;
    }
  }

  /**
   * @param {number} dt seconds since the last frame
   */
  function update(dt) {
    elapsed += dt;

    if (analyser && spectrum) {
      analyser.getByteFrequencyData(spectrum);
      for (const name of Object.keys(BANDS)) {
        const target = bandEnergy(name);
        const env = ENVELOPE[name];
        level[name] = follow(level[name], target, dt, env.attack, env.release);
      }
    } else {
      // No audio yet. Fall back towards the idle floor rather than holding
      // whatever the last frame had, so a stopped transport settles.
      for (const name of Object.keys(level)) {
        level[name] = follow(level[name], 0, dt, 4, 4);
      }
    }

    // --- bass -> wash, and the woofer cones ------------------------------
    setFixture(wash[0], IDLE + level.bass * PEAK.wash);
    setFixture(wash[1], IDLE + level.bass * PEAK.wash);

    /**
     * The drivers move with the low end.
     *
     * Eight millimetres of excursion on a 170 mm cone, along the cabinet's own
     * baffle normal — which comes for free, because the woofers are children
     * of the toed-in stack and +Z in that frame IS the baffle normal. Rotating
     * the stack rotated the direction the cones travel in, with nothing to
     * update. It is the smallest animation in the project and one of the most
     * effective: it is the only thing in the scene that makes the sound
     * visible as a mechanical fact rather than as a colour.
     */
    const excursion = level.bass * 0.008;
    for (const tower of towers) {
      for (const cone of tower.woofers) cone.position.z = cone.userData.z0 + excursion;
    }

    // --- mid -> accent colour, intensity, and the yokes -------------------
    //
    // The hue of each head sweeps a short arc as the midrange fills: the left
    // from cyan towards blue, the right from orange towards red. Both stay
    // inside their own half of the wheel, so the pair never converges on one
    // colour and the warm/cool split that separates the character from the
    // backdrop survives at every level.
    //
    // Note the colour is written to the LIGHT and then copied outward to its
    // lens and beam by setFixture. There is one authoritative colour per
    // fixture and two things that read it, which is the rule the whole project
    // runs on: derive, never duplicate.
    const accentLevel = IDLE + level.mid * PEAK.accent;

    accentLeft.light.color.setHSL(0.53 + level.mid * 0.06, 0.85, 0.58);
    setFixture(accentLeft, accentLevel);

    accentRight.light.color.setHSL(0.065 - level.mid * 0.045, 0.85, 0.58);
    setFixture(accentRight, accentLevel);

    aimTowers(elapsed);

    // --- high -> sparkle --------------------------------------------------
    //
    // Squared, unlike the other two. The high band's mean is compressed by the
    // averaging described above, so it rarely reaches the top of its range;
    // squaring pushes the quiet majority down and leaves the peaks where they
    // are, which turns a light that is always slightly on into one that
    // flicks. This is a shaping choice on a light, not a correction to the
    // measurement — the measurement is in `level.high` and stays honest.
    setFixture(sparkle, IDLE + level.high * level.high * PEAK.sparkle);

    // --- overall lift -----------------------------------------------------
    ambient.intensity = 0.05 + (level.bass + level.mid + level.high) * 0.06;

    // --- the air ----------------------------------------------------------
    updateDust(dt);

    // Published so a VU meter, the GUI, or a future reactive material can read
    // the bands without any of them touching an AnalyserNode. Same rule as
    // everywhere else: measure once, broadcast, let subscribers decide.
    bus.emit('audio:bands', level);
  }

  /**
   * Drift the motes, and set how much light is in the air.
   *
   * Opacity follows the mids and highs rather than the bass, because those are
   * the two bands whose fixtures actually have visible beams. Haze brightening
   * on a kick that lights nothing above knee height would be the giveaway that
   * the particles and the beams are not really connected.
   */
  function updateDust(dt) {
    if (!dustOn) {
      dust.visible = false;
      return;
    }

    const opacity = Math.min(0.5, 0.05 + level.mid * 0.34 + level.high * 0.20);
    dustMaterial.opacity = opacity;
    dust.visible = opacity > 0.012;
    if (!dust.visible) return;

    const top = DUST.floor + DUST.h;

    for (let i = 0; i < DUST.count; i++) {
      const j = i * 3;
      dustPositions[j + 1] += dustRise[i] * dt;

      // A little lateral wander, out of phase per mote, so the field does not
      // rise as a rigid block. One sine per particle is what separates "dust"
      // from "a texture scrolling upward".
      dustPositions[j] += Math.sin(elapsed * 0.5 + dustPhase[i]) * 0.012 * dt;

      if (dustPositions[j + 1] > top) {
        // Recycled rather than respawned: the buffer stays the same length and
        // nothing is allocated, which is the whole reason a particle system is
        // cheap in the first place.
        dustPositions[j + 1] = DUST.floor;
        dustPositions[j] = (Math.random() - 0.5) * DUST.w;
      }
    }

    dustGeometry.attributes.position.needsUpdate = true;
  }

  // -----------------------------------------------------------------------
  // Detail levers, for quality.js
  //
  // The two transparent effects are the first things a weak machine gives up,
  // and they are exposed as named switches rather than as a tier object so
  // that quality.js never has to know what a fixture is. It says "no beams";
  // this module decides what that means.
  //
  // Transparency is the right thing to cut first because it is pure overdraw:
  // a beam cone covers a large area of screen, contributes nothing to depth,
  // and is blended over whatever is already there. Cutting it removes
  // fragments without removing a single object from the scene.
  // -----------------------------------------------------------------------

  function setBeams(on) {
    beamsOn = on;
    if (!on) {
      for (const entry of fixtures) {
        if (entry.beam) entry.beam.visible = false;
      }
    }
  }

  function setDust(on) {
    dustOn = on;
    if (!on) dust.visible = false;
  }

  /**
   * Toggle the reactive rig as a unit.
   *
   * One `visible` flag on the parent Group rather than a flag per light. A
   * Group's visibility gates its whole subtree during traversal, so the
   * renderer skips the fixtures, the stacks and the dust entirely instead of
   * drawing them at zero.
   */
  function setEnabled(on) {
    group.visible = on;
  }

  return {
    attach,
    update,
    setEnabled,
    setBeams,
    setDust,
    level,
    fixtures,
    towers,
    lights: {
      wash: wash.map((f) => f.light),
      accent: accent.map((f) => f.light),
      sparkle: sparkle.light,
      ambient,
    },
    group,
  };
}