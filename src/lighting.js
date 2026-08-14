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
 * WHERE THE LIGHTS GO, AND WHY LOW
 *
 * The phase 5 plan was written for the folding case: a tall object with three
 * vertical panels, which a wash from above would land on. The slab replaced
 * it and is 60 mm thick. Light from overhead on a flat horizontal object
 * produces an almost constant lambert term across the whole top face — no
 * gradient, no form, just a brighter flat. The reactive lights therefore sit
 * LOW and graze across the surface, which is what makes a flat object read at
 * all, and they spend most of their energy on the ground plane, which is now
 * the largest surface in the scene by a wide margin.
 */

import * as THREE from 'three';
import { bus } from './events.js';
import { PALETTE } from './palette.js';
import { roundedBoxGeometry, roundedCylinderGeometry } from './geometry.js';

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
// Light budget
//
// SpotLight intensity is in candela and decay is 2, so the illuminance a
// surface receives is intensity / d^2. Every fixture here sits between 0.9 and
// 1.3 units from the instrument, so these numbers land within about 40% of
// themselves as irradiance — which is why they look small next to the key
// light's 1.75, and why they are not.
//
// They are budgeted against the key rather than turned up until they looked
// bright. Two things make the budget affordable that were not true a phase
// ago: the slab's albedo is roughly 0.17 where the old cream shell was 0.93,
// and the ground is 0.42. There is far more room before the Neutral tone
// mapper starts compressing than the old palette allowed.
// ---------------------------------------------------------------------------

const PEAK = {
  wash: 3.2,
  accent: 2.4,
  sparkle: 4.5,
};

/** A floor under every fixture, so the rig is lit before a note is played. */
const IDLE = 0.10;

// ---------------------------------------------------------------------------

/**
 * @param {{ scene: THREE.Scene }} deps
 */
export function initLighting({ scene }) {
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
  // NONE of these cast shadows, deliberately. The key light in main.js owns
  // the shadow, and a second shadow-casting light from a different direction
  // would give every object two overlapping silhouettes on the ground and
  // destroy the read of the first one. Three more 2048 maps per frame would
  // also cost more than the whole rest of the frame does.
  // -----------------------------------------------------------------------

  const group = new THREE.Group();
  group.name = 'reactive-lights';
  scene.add(group);

  // -----------------------------------------------------------------------
  // Shared geometry and materials for the physical fixtures
  //
  // Built once and drawn with different matrices. Five fixtures plus the truss
  // is around twenty extra meshes, which is worth watching on the draw-call
  // readout — but they share five geometries and four materials between them,
  // so the cost is transform uploads rather than state changes.
  // -----------------------------------------------------------------------

  /**
   * Turn a lathed cylinder — which stands on its origin pointing up +Y — into
   * one lying along +Z, centred on its own middle.
   *
   * Done once at build time on the geometry rather than per instance with a
   * rotation on the mesh, because `Object3D.lookAt` aims an object's +Z axis
   * at its target. Baking the axis change into the buffer means a fixture can
   * simply be told to look at what it lights, with no correction rotation to
   * remember and no Euler order to reason about.
   */
  function alongZ(geo, length) {
    geo.translate(0, -length / 2, 0);
    geo.rotateX(-Math.PI / 2);
    return geo;
  }

  const CAN_LEN = 0.115;
  const CAN_R = 0.052;

  const GEO = {
    can: alongZ(roundedCylinderGeometry(CAN_R, CAN_LEN, 0.016, 24, 3), CAN_LEN),
    lens: alongZ(roundedCylinderGeometry(CAN_R * 0.88, 0.012, 0.005, 24, 2), 0.012),
    stem: roundedCylinderGeometry(0.016, 0.20, 0.008, 16, 2),
    foot: roundedCylinderGeometry(0.085, 0.022, 0.010, 24, 2),
    pole: roundedCylinderGeometry(0.019, 1.22, 0.010, 16, 2),
    clamp: roundedBoxGeometry(0.048, 0.048, 0.048, 0.014, 3),
  };

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

  function part(geometry, material, position, receive = true) {
    const mesh = new THREE.Mesh(geometry, material);
    if (position) mesh.position.set(...position);
    /**
     * Nothing in the light rig casts a shadow, and that is a decision rather
     * than an oversight. main.js sized the key light's shadow camera to a
     * +/-1.2 frustum around the instrument, which bought roughly a 3.4x gain
     * in effective shadow resolution. The truss stands 1.22 units tall at
     * x = +/-0.85; its shadow would fall outside that frustum and be clipped
     * to a visible hard edge across the floor. Widening the frustum to contain
     * it would hand back the entire resolution gain to shadow a scaffold
     * nobody is looking at.
     */
    mesh.castShadow = false;
    mesh.receiveShadow = receive;
    return mesh;
  }

  // -----------------------------------------------------------------------
  // Fixtures
  //
  // SpotLight throughout, and never PointLight. A point light that casts
  // shadows needs a cube shadow map — six renders of the scene per light per
  // frame — where a spot needs one, because a spot has a single frustum. Even
  // with shadows off, the spot's cone is also what makes a fixture read as a
  // fixture: a light with no falloff at its edge has no visible direction, and
  // a housing aimed somewhere its light is not going fools nobody.
  // -----------------------------------------------------------------------

  /** @type {Array<{ light: THREE.SpotLight, lens: THREE.Mesh, beam: THREE.Mesh, peak: number }>} */
  const fixtures = [];

  /**
   * One complete fixture: a spot, a housing aimed along it, a lens that
   * brightens with it, and a soft cone standing in for the beam in air.
   *
   * @param {number} colour
   * @param {[number,number,number]} position
   * @param {[number,number,number]} target
   * @param {number} angle    cone half-angle, radians
   * @param {number} penumbra 0..1 softness of the cone edge
   * @param {number} peak     the fixture's budgeted maximum intensity
   * @param {number} beamLen  0 to omit the visible beam
   */
  function fixture(colour, position, target, angle, penumbra, peak, beamLen = 0) {
    const light = new THREE.SpotLight(colour, IDLE, 0, angle, penumbra, 2);
    light.position.set(...position);
    light.target.position.set(...target);
    light.castShadow = false;
    group.add(light);
    // A SpotLight aims at its target's WORLD position, so the target must be
    // in the graph. Left out, it stays at the origin of nothing and the cone
    // points at the scene origin by accident rather than by design.
    group.add(light.target);

    // The head carries everything that has to point where the light points.
    const head = new THREE.Group();
    head.position.set(...position);
    group.add(head);
    head.lookAt(new THREE.Vector3(...target));

    // Housing sits behind the origin so its open mouth is exactly at the
    // light's position — the emitter and the aperture coincide, which is the
    // whole point of drawing it.
    head.add(part(GEO.can, housingMat, [0, 0, -CAN_LEN / 2 - 0.004]));

    /**
     * The lens. MeshBasicMaterial, not an emissive Standard: this surface is
     * meant to be exactly as bright as it is told and to ignore every light in
     * the scene, including its own. A Standard material would pick up the
     * wash from the fixture opposite and glow faintly when it should be dark.
     *
     * `toneMapped` is left on, so pushing the colour past 1.0 rolls off
     * through the same Neutral curve as everything else instead of clipping to
     * a flat disc of pure hue.
     */
    const lens = new THREE.Mesh(
      GEO.lens,
      new THREE.MeshBasicMaterial({ color: colour })
    );
    lens.position.z = 0.002;
    head.add(lens);

    /**
     * The beam: an open cone of additive transparency standing in for light
     * scattering off dust in the air.
     *
     * Real volumetrics need either ray marching or a shadow-map-driven scatter
     * pass, both of which are out of proportion to what this scene needs. A
     * cone with `depthWrite: false` and additive blending gets most of the
     * read for one draw call. The two flags matter: additive because light
     * adds and never occludes, and no depth write because five overlapping
     * transparent cones that write depth will hide each other in whatever
     * order they happen to be drawn.
     *
     * Kept faint on purpose. The failure mode of this trick is a visible solid
     * cone with a hard edge, which looks far worse than no beam at all.
     */
    let beam = null;
    if (beamLen > 0) {
      const radius = Math.tan(angle) * beamLen * 0.9;
      const cone = new THREE.ConeGeometry(radius, beamLen, 24, 1, true);
      cone.translate(0, -beamLen / 2, 0);
      cone.rotateX(-Math.PI / 2);

      beam = new THREE.Mesh(cone, new THREE.MeshBasicMaterial({
        color: colour,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }));
      head.add(beam);
    }

    const entry = { light, lens, beam, peak };
    fixtures.push(entry);
    return entry;
  }

  // --- the truss ----------------------------------------------------------
  //
  // A goalpost straddling the instrument: two poles behind it and a crossbar
  // over it. It exists so the overhead and rear fixtures have something to
  // hang from — an accent light floating at 620 mm with no visible support is
  // the same problem as an accent light with no visible housing.
  //
  // It also starts phase 6. The booth needs structure in the frame, and a
  // lighting truss is structure that is already justified by function.

  const TRUSS = { x: 0.85, z: -0.18, h: 1.22 };

  for (const side of [-1, 1]) {
    group.add(part(GEO.foot, poleMat, [side * TRUSS.x, 0.011, TRUSS.z]));
    group.add(part(GEO.pole, poleMat, [side * TRUSS.x, 0, TRUSS.z]));
  }

  const crossbar = part(
    alongZ(roundedCylinderGeometry(0.017, TRUSS.x * 2, 0.008, 16, 2), TRUSS.x * 2),
    poleMat,
    [0, TRUSS.h, TRUSS.z]
  );
  crossbar.rotation.y = Math.PI / 2; // the bar runs across X, not along Z
  group.add(crossbar);

  /**
   * BASS — two floor cans, low and grazing.
   *
   * At 200 mm the beam skims across the slab rather than falling onto it, so
   * the lambert term varies sharply over the bezel rails and the wing surfaces
   * and the slab gains an actual gradient instead of a uniform brighter flat.
   * Most of each cone lands on the ground beyond the instrument, which is the
   * point: two pools breathing with the kick do more for the room than
   * anything happening on 60 mm of slab could.
   *
   * Deep indigo because the robot is amber. Complementary light on the ground
   * behind a warm subject is the cheapest separation there is.
   */
  const washPos = [
    [-1.02, 0.20, 0.40],
    [1.02, 0.20, 0.40],
  ];

  const wash = washPos.map((position, i) => {
    const side = i === 0 ? -1 : 1;
    // Stand: a foot on the ground and a stem up to the head. Drawn as separate
    // unrotated meshes rather than as children of the head, so aiming the
    // fixture never tilts the thing holding it up.
    group.add(part(GEO.foot, housingMat, [position[0], 0.011, position[2]]));
    group.add(part(GEO.stem, housingMat, [position[0], 0.0, position[2]]));
    /**
     * No visible beam on these two, unlike the accents and the sparkle.
     *
     * Not a rendering compromise — a physical one. Beam visibility depends on
     * intensity per unit solid angle, because that is what sets how much light
     * any given volume of air is scattering. These are 54-degree floods: they
     * spread the same energy over roughly nine times the solid angle of the
     * accents, so in air they simply do not read as a shaft. Drawing one
     * anyway would put a 1.9-unit translucent sheet across the frame, which is
     * the exact failure mode this trick has.
     *
     * Wide floods do not show beams. Narrow spots do. The fixtures follow.
     */
    return fixture(
      0x5a4cff, position, [side * -0.1, 0.02, -0.1], 0.95, 0.85, PEAK.wash, 0
    );
  });

  /**
   * MID — two accents clamped to the truss poles, aimed at the slab.
   *
   * These are the only fixtures whose COLOUR moves. Intensity alone is a weak
   * channel for the midrange, because the mids are almost always doing
   * something and a light that is always half on reads as static. Hue is a
   * channel nothing else in this scene is competing for.
   *
   * Behind and above, so they rim the far edge of the slab and the back of the
   * robot's chassis rather than flooding the face the camera sees. A reactive
   * light aimed at the camera-facing surface fights the key; one aimed at the
   * silhouette edge cannot.
   */
  const accent = [-1, 1].map((side) => {
    const position = [side * TRUSS.x, 0.62, TRUSS.z];
    group.add(part(GEO.clamp, poleMat, position));
    return fixture(
      side < 0 ? 0xff4fa3 : 0x35d6ff,
      [position[0] - side * 0.05, position[1], position[2] + 0.05],
      [0, 0.04, 0], 0.55, 0.7, PEAK.accent, 1.1
    );
  });

  const [accentLeft, accentRight] = accent;

  /**
   * HIGH — one tight flick hanging from the crossbar.
   *
   * Nearly white and nearly directly above the grid, which is the one position
   * where a hard specular highlight lands on the knob caps and the pad caps at
   * once. Hats are transients; this fixture exists to be seen switching, so it
   * is the only one with a genuinely fast release.
   */
  group.add(part(GEO.clamp, poleMat, [0.05, TRUSS.h, TRUSS.z]));
  const sparkle = fixture(
    0xf4f8ff, [0.05, TRUSS.h - 0.05, TRUSS.z], [0, 0.05, 0], 0.42, 0.35, PEAK.sparkle, 1.0
  );

  /**
   * A hemisphere term that lifts with the whole mix.
   *
   * Not reactive to one band — driven by the sum, gently. Its job is to keep
   * the shadow side of the robot from going black during a loud passage, which
   * three coloured spots from three directions will otherwise do to him
   * because MeshToonMaterial bands each light separately and a toon shadow
   * side has no gradient to rescue it. It is the one light here with no
   * housing, and it does not need one: an ambient term is not a fixture and
   * the eye does not look for its source.
   */
  const ambient = new THREE.HemisphereLight(PALETTE.skyTop, PALETTE.ground, 0.0);
  group.add(ambient);

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
   * The lens is deliberately not linear in the level. It carries a floor of
   * 0.18 so the glass never goes fully black — a real lamp's optic still
   * catches the room when it is idle — and it is driven past 1.0 at full, so
   * the tone mapper rolls the centre of the lens off towards white the way an
   * over-bright source actually does on camera.
   *
   * The beam is the opposite: it starts at zero, because air with no light in
   * it scatters nothing, and it is scaled hard down because the failure mode
   * of a fake volumetric is a visible solid cone.
   */
  function setFixture(entry, intensity) {
    entry.light.intensity = intensity;

    const k = Math.min(1, Math.max(0, (intensity - IDLE) / entry.peak));

    entry.lens.material.color.copy(entry.light.color).multiplyScalar(0.18 + k * 1.5);

    if (entry.beam) {
      entry.beam.material.color.copy(entry.light.color);
      entry.beam.material.opacity = k * 0.075;
      // A fully transparent mesh is still rasterised and still blended. Hiding
      // it below the threshold where it contributes anything visible skips the
      // fragment work entirely on a quiet passage.
      entry.beam.visible = entry.beam.material.opacity > 0.004;
    }
  }


  /**
   * @param {number} dt seconds since the last frame
   */
  function update(dt) {
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

    // --- bass -> wash --------------------------------------------------
    setFixture(wash[0], IDLE + level.bass * PEAK.wash);
    setFixture(wash[1], IDLE + level.bass * PEAK.wash);

    // --- mid -> accent colour, and a little intensity -------------------
    //
    // The hue sweeps across a 100-degree arc of the wheel as the midrange
    // fills, which keeps both accents inside the cool-to-magenta range the
    // palette already uses. A full 360-degree sweep would send them through
    // green and yellow, where they would read as a bug rather than a mood.
    //
    // The two sides are offset from each other so they never match: two lights
    // of the same colour from opposite sides cancel into a single flat wash
    // and lose the thing that makes a pair of accents worth having.
    //
    // Note the colour is written to the LIGHT and then copied outward to its
    // lens and beam by setFixture. There is one authoritative colour per
    // fixture and two things that read it, which is the same rule the whole
    // project runs on: derive, never duplicate.
    const accentLevel = IDLE + level.mid * PEAK.accent;

    accentLeft.light.color.setHSL(0.90 - level.mid * 0.28, 0.85, 0.58);
    setFixture(accentLeft, accentLevel);

    accentRight.light.color.setHSL(0.52 + level.mid * 0.16, 0.85, 0.58);
    setFixture(accentRight, accentLevel);

    // --- high -> sparkle ------------------------------------------------
    //
    // Squared, unlike the other two. The high band's mean is compressed by the
    // averaging described above, so it rarely reaches the top of its range;
    // squaring pushes the quiet majority down and leaves the peaks where they
    // are, which turns a light that is always slightly on into one that
    // flicks. This is a shaping choice on a light, not a correction to the
    // measurement — the measurement is in `level.high` and stays honest.
    setFixture(sparkle, IDLE + level.high * level.high * PEAK.sparkle);

    // --- overall lift ---------------------------------------------------
    ambient.intensity = 0.04 + (level.bass + level.mid + level.high) * 0.055;

    // Published so a VU meter, the GUI, or a future reactive material can read
    // the bands without any of them touching an AnalyserNode. Same rule as
    // everywhere else: measure once, broadcast, let subscribers decide.
    bus.emit('audio:bands', level);
  }

  /**
   * Toggle the reactive rig as a unit.
   *
   * One `visible` flag on the parent Group rather than three flags on three
   * lights. A Group's visibility gates its whole subtree during traversal, so
   * the renderer skips the fixtures entirely instead of drawing them at zero.
   */
  function setEnabled(on) {
    group.visible = on;
  }

  return {
    attach,
    update,
    setEnabled,
    level,
    fixtures,
    lights: {
      wash: wash.map((f) => f.light),
      accent: accent.map((f) => f.light),
      sparkle: sparkle.light,
      ambient,
    },
    group,
  };
}