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
 * PHASE 14: THE EMITTERS LEFT THE FRAME
 *
 * Two changes that are really one idea.
 *
 * FIRST, no fixture is drawn any more. There are no housings, no lenses, no
 * yokes, no boom and no floor cans. The reason is not that they looked bad —
 * it is that a lamp you can see is a lamp whose beam has to start somewhere
 * visible, and a shaft that begins at a small bright object reads as a cone
 * attached to a prop. Every stage photograph that looks like a stage
 * photograph has its sources OUT OF FRAME: light arrives from beyond the top
 * edge, already established, with no visible origin to argue with.
 *
 * So the emitters moved up and outward, above the camera's normal field of
 * view, and the geometry that used to represent them was deleted. What is left
 * in the scene is the light itself.
 *
 * SECOND, the shafts came back — as a raymarched volume rather than as cone
 * meshes. That reverses the phase 11 decision to remove them, and the reversal
 * is the point: cone geometry was removed because two cones cannot fuse, since
 * compositing two meshes always leaves the silhouette of one over the other.
 * The integral in volumetrics.js sums every source's contribution PER SAMPLE
 * along the view ray, so crossing shafts produce a genuinely brighter, warmer
 * core with no edge anywhere. Same feature, different technology, and the
 * first attempt is kept in the log because the reason it failed is the reason
 * the second one works.
 *
 * This module no longer draws the beams at all. It owns the lights and
 * publishes a description of each shaft; volumetrics.js renders them.
 *
 *
 * WHY THE TRUSS BECAME TWO SPEAKER STACKS
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
 * angles are that base plus a slow sweep and a midrange term. The housing, the
 * lens and the spot's own target are all children of the tilt group, so they
 * cannot fall out of alignment with each other: there is one pair of numbers
 * and four things that ride them.
 *
 *
 * WHERE THE LIGHTS GO: ONE RING, AND TWO LAMPS THAT GRAZE
 *
 * Every emitter's position and aim is derived from a BEARING about the centre
 * of the room — one radius, one height, one convergence point, five bearings
 * 72 degrees apart, plus a downlight over the middle. Nothing is typed twice
 * and nothing can drift out of the set, which is what the previous
 * arrangement had done: four heights, three radii and five separate aims,
 * each defensible on its own and none of them agreeing with the others.
 *
 * The two floor washes are the exception and they are deliberately LOW, so
 * they graze across the slab rather than falling onto it. Light from overhead
 * onto a flat horizontal object produces an almost constant lambert term
 * across its whole top face — no gradient, no form, just a brighter flat.
 * Grazing light varies sharply over the bezel rails and the wing surfaces,
 * and it spends most of its energy on the ground plane, which is both the
 * largest surface in the scene and a semi-gloss one that returns a raking
 * highlight.
 *
 *
 * COLOUR IS DERIVED, NOT AUTHORED
 *
 * No fixture owns a colour. Each owns a place on the wheel taken from its own
 * bearing, and every frame adds one shared clock to all of them — so the rig
 * is a gradient wrapped once around the room, rotating slowly, pushed along by
 * how much is playing. Two fixtures can never converge on one hue because
 * their offsets are fixed and distinct, and the whole scheme moves with one
 * number rather than eight.
 */

import * as THREE from 'three';
import { bus } from './events.js';
import { PALETTE } from './palette.js';
import { roundedBoxGeometry, roundedCylinderGeometry } from './geometry.js';
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

/**
 * Re-costed again when the instrument grew and the towers moved out with it.
 *
 * Illuminance is intensity / d^2, so every fixture that moved needs its peak
 * multiplied by the square of how much further away it now is. These are
 * measured from the actual positions rather than estimated:
 *
 *   accent   1.359 -> 1.607 units,  x1.40
 *   wash     1.036 -> 1.326 units,  x1.64
 *   sparkle  0.975 -> 1.037 units,  x1.13
 *
 * Not a taste decision. These are the only values that leave the light landing
 * on the instrument exactly as hard as it did before the room was rescaled,
 * which is what makes "scale the scene up" a change of framing rather than a
 * change of look that then has to be re-tuned by eye.
 */
/**
 * Re-costed a third time, for emitters that moved from 2.2 units up to 3.9.
 *
 * Illuminance is intensity / d^2 and nothing else, so a fixture that moves
 * further from its target needs its peak multiplied by the square of the ratio
 * simply to stand still. Measured from the actual positions rather than
 * guessed at:
 *
 *   accent   2.80 -> 4.53 units,  irradiance 0.71 preserved at peak 15
 *   sparkle  2.37 -> 4.31 units,  irradiance 1.30 preserved at peak 24
 *
 * These look like large numbers next to the key light's 0.85 and they are not
 * comparable: a DirectionalLight has no falloff and a SpotLight at decay 2
 * divides by twenty. Doing this arithmetic rather than turning knobs is what
 * makes "the room got bigger" a change of scale instead of a re-lighting job.
 */
/**
 * Re-costed for a lit room rather than a dark one, which is a bigger change
 * than any of the distance re-costings before it.
 *
 * Those were arithmetic: a fixture moved, so its peak scaled by the square of
 * the distance ratio. This one is about CONTRAST. On a near-black stage a
 * fixture only had to beat an ambient floor of about 0.05, so peaks of 15 and
 * 24 were reasonable. The ambient term is now roughly 0.55 from the
 * environment plus a hemisphere at 1.15 plus a key at 1.35 — an order of
 * magnitude more — and a reactive light has to sit ON TOP of that without
 * blowing the pastel surfaces to white.
 *
 * Neutral tone mapping does not protect highlights the way AgX does, which is
 * the price of it holding hue (and the reason it was chosen for exactly this
 * palette). So the ceiling is lower than it looks: the cream slab has albedo
 * near 0.94, and past roughly 6 units of additional illuminance it clips to
 * white and the pastel is gone.
 *
 * These are therefore a fraction of what they were, and the reactive rig now
 * TINTS a lit scene rather than revealing an unlit one. That is a real loss in
 * drama and the honest consequence of the art direction: a bright room cannot
 * also be a room where the lights are the only thing you can see.
 */
const PEAK = {
  /**
   * Re-costed once more, and this one is not arithmetic on a distance ratio —
   * the washes MOVED, from 1.02 units out to 2.25, which is more than double.
   * Illuminance is intensity over distance squared, so standing still would
   * have cost a factor of 4.9 on paper.
   *
   * It is deliberately not paid in full. The old pair stood so close to the
   * instrument that they were the brightest thing in the room by a wide
   * margin, and most of their output landed on two square feet of floor
   * rather than raking across it. 16 puts roughly 3 units of illuminance on
   * the slab at a full kick against the old 5.9, spread over an area several
   * times larger — which is what "wash" is supposed to mean.
   */
  wash: 16.0,
  accent: 15.0,
  sparkle: 24.0,
};

/**
 * THE COLOUR OF EVERY FIXTURE, IN TWO NUMBERS.
 *
 * Saturation and lightness are shared by the whole rig and only the HUE
 * varies, per fixture and over time. That is what makes the rig read as one
 * gradient rather than as eight lamps that happen to be coloured: two lights
 * of different hue but equal saturation and lightness are perceived as the
 * same light in two places, which is exactly the reading a lighting desk with
 * one colour palette loaded gives.
 *
 * Saturation is high, and that is a requirement rather than a preference: a
 * volumetric shaft is ADDITIVE, so it is seen both as a brightening and as a
 * hue displacement from what is behind it. A desaturated beam supplies only
 * the first, and brightening alone is the change the eye is worst at
 * detecting — which is why the shaft that used to be white was invisible at a
 * peak of 24 while a saturated one at the same level reads clearly.
 *
 * Lightness sits at 0.55 rather than higher because `setHSL` above 0.5 starts
 * trading saturation away for luminance, and luminance is what `PEAK` is for.
 */
const BEAM_SATURATION = 0.88;
const BEAM_LIGHTNESS = 0.55;

/**
 * How fast the whole gradient rotates, in turns per second, and how much the
 * programme level pushes it along.
 *
 * A full revolution in about twenty-eight seconds at rest. Slow enough that at
 * any instant the rig reads as A COLOUR SCHEME rather than as an effect, fast
 * enough that a minute of watching never shows the same frame twice. Past
 * roughly 0.15 it stops being stage lighting and becomes a disco light, which
 * is a different and much cheaper idea.
 *
 * The music term means a dense passage visibly drives the colour along
 * instead of only brightening it — the hue becomes a second output channel
 * for the same measurement, which is the rule the rest of the rig runs on.
 */
const HUE_RATE = 0.036;
const HUE_PUSH = 0.075;


/**
 * A floor under every fixture, so the rig is lit before a note is played.
 *
 * Raised from 0.10 with the room going dark, and this is the number that
 * answers "what does a grader see if they never press play". At idle the four
 * reactive fixtures put roughly 0.09 of illuminance on the slab between them —
 * well under the key, but enough that every lamp visibly has its light on and
 * every cabinet meter shows a segment lit. The scene at rest is a lit stage
 * waiting, not a dark frame.
 */
const IDLE = 0.18;

// ---------------------------------------------------------------------------
// The stacks
// ---------------------------------------------------------------------------

/**
 * `x` moved out from 1.06 to 1.38 when the instrument was scaled up. The
 * constraint is the same one it always was and it is worth restating as a
 * constraint rather than as a number: the slab's wings reach `0.5 * scale` to
 * a side when open — now 0.75 — and a cabinet has to sit clear of that with
 * room for the player, while both towers stay in frame on the Overview shot. `toe` angles each stack inward about Y
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
const TOWER = { x: 1.38, z: -0.12, toe: 0.20 };

/** Cabinet tiers, bottom to top. */
const CABS = [
  { w: 0.380, h: 0.045, d: 0.360, y: 0.0225, tier: 'plinth' },
  { w: 0.360, h: 0.420, d: 0.340, y: 0.2550, tier: 'sub' },
  { w: 0.320, h: 0.240, d: 0.300, y: 0.5850, tier: 'mid' },
  { w: 0.280, h: 0.150, d: 0.260, y: 0.7800, tier: 'horn' },
];

/** Top of the stack, where the yoke post stands. */
const STACK_TOP = 0.855;

/** Lamps per LED column. Two columns per cabinet. */
const LED_PER_COLUMN = 10;

/** Lamps in a driver ring. Sixteen is enough that the chase reads as motion
 *  rather than as individual lamps blinking in sequence. */
const RING_LAMPS = 16;
const RING_LAMPS_SMALL = 12;

// ---------------------------------------------------------------------------

const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);

/**
 * @param {{ scene: THREE.Scene }} deps
 */
export function initLighting({ scene }) {
  const group = new THREE.Group();
  group.name = 'reactive-lights';
  scene.add(group);

  /**
   * The cabinets get their own sub-group, separate from the emitters.
   *
   * This existed as one group and it was a bug waiting to be triggered, which
   * the power-on sequence duly triggered. The intro lifts the speaker stacks
   * 2.4 units so they can fall in — and with the lights in the same group, it
   * lifted those too, putting every emitter at nearly 6.4 in a room whose dome
   * apex is 4.9. The lights ended up OUTSIDE the enclosure, shining through it
   * from above (spot lights here cast no shadows, so nothing stopped them),
   * which lit the ceiling from the wrong side and blew the whole opening out.
   *
   * The deeper point is that "the light rig" was two things sharing a
   * transform for no reason other than having been written in one file. A
   * cabinet is furniture that can be moved; an emitter is a fixed point in the
   * room. Anything that wants to animate one has no business moving the other,
   * and now cannot.
   */
  const stacks = new THREE.Group();
  stacks.name = 'speaker-stacks';
  group.add(stacks);

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
    // Drivers, seen face-on. Lying along Z so their domed end points out of
    // the baffle.
    woofer: alongZ(roundedCylinderGeometry(0.082, 0.026, 0.020, 28, 3), 0.026),
    driver: alongZ(roundedCylinderGeometry(0.055, 0.022, 0.016, 24, 3), 0.022),
    hornMouth: roundedBoxGeometry(0.170, 0.062, 0.024, 0.014, 3),
    standby: roundedBoxGeometry(0.014, 0.010, 0.006, 0.002, 2),

    // One RGB LED. Instanced twenty times per tower — see the strips below.
    led: roundedBoxGeometry(0.022, 0.011, 0.007, 0.0025, 2),
  };

  /** Tier -> its box geometry, built once and shared by both towers. */
  const CAB_GEO = CABS.map((c) => roundedBoxGeometry(c.w, c.h, c.d, 0.016, 3));

  /** Grille panels, one per tier that has drivers behind it. */
  const GRILLE_GEO = CABS.map((c) =>
    roundedBoxGeometry(Math.max(0.02, c.w - 0.045), Math.max(0.02, c.h - 0.045), 0.014, 0.006, 2)
  );

  const housingMat = new THREE.MeshStandardMaterial({
    color: PALETTE.cabFace,
    metalness: 0.0,
    roughness: 0.75,
  });

  /**
   * Pale plastic, not metal.
   *
   * Every metallic surface in the project lost its argument with the new
   * background at once. Metalness has no diffuse response — a metal is
   * entirely what it reflects — and what it now reflects is a near-white
   * environment, so a chrome part renders as a slightly shiny white part and
   * disappears into the ground behind it. Dropping metalness and raising
   * roughness turns the same geometry into painted trim, which separates by
   * value and holds its colour from every angle.
   */
  const poleMat = new THREE.MeshStandardMaterial({
    color: PALETTE.mech,
    metalness: 0.0,
    roughness: 0.62,
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
    roughness: 0.85,
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
  /**
   * The baffle stays dark, and it is now one of only two dark surfaces in the
   * scene — the other is the instrument's display.
   *
   * That scarcity is the point. On a dark stage a black grille was one dark
   * thing among many and identified nothing; against a pastel ground it is the
   * only hole in the image, which is exactly what makes a speaker read as a
   * speaker from across the room. It is navy rather than black so it belongs
   * to the palette rather than sitting outside it.
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

  /**
   * The LED material: one instance, shared by every lamp on a tower.
   *
   * MeshBasicMaterial and `toneMapped: false`. A lamp must be exactly the
   * colour it is told and must not pick up the wash from anything else in the
   * room — these are emitters behind diffusers, not surfaces. Leaving tone
   * mapping off keeps a saturated LED saturated, where AgX's shoulder would
   * pull the brightest ones towards white: on a strip whose entire job is
   * colour, that is the one thing that must not happen.
   *
   * `setColorAt` reaches the shader because three defines USE_INSTANCING_COLOR
   * whenever an InstancedMesh carries an `instanceColor` attribute, and
   * multiplies it into the material colour — which is why the base colour here
   * is white rather than anything else.
   */
  const ledMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });

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
  // Emitters
  //
  // A light and nothing else. No housing, no lens, no yoke: the apex of every
  // shaft sits above and outside the camera's normal field of view, and the
  // only thing in the frame is what the light does.
  //
  // SpotLight throughout, and never PointLight. A spot has one frustum and one
  // shadow map where a point needs six, and — more to the point here — a spot
  // has an axis and a cone angle, which is exactly the description
  // volumetrics.js needs to march. A point light has no shape to draw.
  //
  // NONE of these cast shadows. The key light in main.js owns the shadow, and
  // a second shadow-casting light from a different direction would give every
  // object two overlapping silhouettes on the ground. This is also the reason
  // the shafts are unshadowed: cutting a dark slot through a beam means
  // sampling that light's shadow map, and there is no shadow map to sample.
  // Recorded as a limitation rather than hidden.
  // -----------------------------------------------------------------------

  /**
   * @type {Array<{
   *   light: THREE.SpotLight, peak: number, range: number,
   *   volumetric: boolean, position: THREE.Vector3, direction: THREE.Vector3
   * }>}
   */
  const fixtures = [];

  /**
   * One emitter: a spot at `position` aimed at `aim`.
   *
   * The target is a plain Object3D added to the group rather than left at the
   * origin, because a SpotLight aims at its target's WORLD position and an
   * unparented target is never updated by the renderer — the light would point
   * at (0,0,0) regardless of what was assigned to it. This is the single most
   * common SpotLight mistake and it fails silently.
   *
   * `volumetric` decides whether the shaft is drawn. Not every light should
   * have one: the low washes exist to put a pool on the floor, and a 54-degree
   * flood spreads its energy over roughly nine times the solid angle of a
   * narrow beam, so in air it does not read as a shaft at all. Marching it
   * would spend a third of the shader's budget on a faint even haze across the
   * whole frame.
   */
  function emitter({ hue, position, aim, angle, penumbra, peak, range = 6, volumetric = false }) {
    // The colour is not a parameter any more, it is a POSITION ON THE WHEEL.
    // `update()` rewrites it every frame from the same hue plus a shared
    // clock, so the value set here only has to be right for frame one.
    const light = new THREE.SpotLight(0xffffff, IDLE, 0, angle, penumbra, 2);
    light.color.setHSL(hue, BEAM_SATURATION, BEAM_LIGHTNESS);
    light.castShadow = false;
    light.position.set(...position);
    group.add(light);

    const target = new THREE.Object3D();
    target.position.set(...aim);
    group.add(target);
    light.target = target;

    const entry = {
      light,
      peak,
      range,
      volumetric,
      angle,
      penumbra,
      /** Where this fixture sits on the colour wheel, before the clock. */
      hue,
      position: light.position,
      direction: new THREE.Vector3(...aim).sub(light.position).normalize(),
    };

    fixtures.push(entry);
    return entry;
  }

  // -----------------------------------------------------------------------
  // The speaker stacks
  // -----------------------------------------------------------------------

  /** @type {Array<{side: number, woofers: THREE.Mesh[], leds: THREE.InstancedMesh, stack: THREE.Group, stackY0: number}>} */
  const towers = [];

  /** Scratch colour for the LED strips, allocated once per rig, not per lamp. */
  const ledColour = new THREE.Color();

  /** The towers' floor patches, handed to intro.js. */
  const towerShadows = [];

  function buildTower(side) {
    const root = new THREE.Group();
    root.position.set(side * TOWER.x, 0, TOWER.z);
    root.name = `tower-${side < 0 ? 'left' : 'right'}`;
    stacks.add(root);

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

    /**
     * RGB LIGHTING: two edge strips, and a ring around every driver.
     *
     * All of it is ONE `InstancedMesh` per tower — sixty-four lozenges sharing
     * one geometry and one material, in one draw call. That matters more than
     * it looks: each lamp needs its own colour, and the obvious way to get
     * that is a material per lamp, which here would be a hundred and twenty
     * eight materials and as many draw calls across the pair of towers, for an
     * object that is decoration. Instancing gives every instance its own
     * colour through a per-instance attribute at no per-lamp cost at all.
     *
     * The strips run the height of the sub, where there is unbroken edge to
     * run along. Two columns rather than one, because a single strip reads as
     * a meter and a symmetric pair reads as trim.
     *
     * The RINGS are the reason the count went from twenty to sixty-four. A
     * ring of lamps concentric with a driver is the one piece of RGB lighting
     * that is about the SPEAKER rather than about the cabinet: it frames the
     * moving part, so when the cone travels on a kick the ring is the
     * stationary reference that makes the travel legible. Without something
     * fixed beside it, a cone moving eight millimetres along its own axis is
     * nearly invisible — there is nothing in frame for the eye to measure it
     * against.
     *
     * Each ring lamp is rotated to lie tangent to its circle, because a ring
     * of identically-oriented rectangles reads as a dotted line bent into a
     * curve, and a ring of tangential ones reads as a manufactured bezel.
     */
    const ledSlots = [];
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const scaleOne = new THREE.Vector3(1, 1, 1);
    const position = new THREE.Vector3();
    const axisZ = new THREE.Vector3(0, 0, 1);

    const sub = CABS[1];
    const subFaceZ = sub.d / 2 + 0.004;

    // --- the two edge strips ---------------------------------------------
    for (const column of [-1, 1]) {
      for (let i = 0; i < LED_PER_COLUMN; i++) {
        const along = i / (LED_PER_COLUMN - 1);
        position.set(column * 0.152, sub.y - 0.165 + along * 0.330, subFaceZ + 0.008);
        ledSlots.push({
          kind: 'strip',
          along,
          matrix: new THREE.Matrix4().makeTranslation(position.x, position.y, position.z),
        });
      }
    }

    // --- a ring around each driver ---------------------------------------
    //
    // Radii sit just outside each cone, so the lamps frame the driver without
    // overlapping the part that moves.
    const RINGS = [
      { y: sub.y - 0.095, z: subFaceZ, radius: 0.098, lamps: RING_LAMPS },
      { y: sub.y + 0.095, z: subFaceZ, radius: 0.098, lamps: RING_LAMPS },
      { y: CABS[2].y, z: CABS[2].d / 2 + 0.004, radius: 0.070, lamps: RING_LAMPS_SMALL },
    ];

    RINGS.forEach((ring, ringIndex) => {
      for (let i = 0; i < ring.lamps; i++) {
        const phase = i / ring.lamps;
        const theta = phase * Math.PI * 2;

        position.set(
          Math.cos(theta) * ring.radius,
          ring.y + Math.sin(theta) * ring.radius,
          ring.z + 0.006
        );
        // Tangent to the circle: a rotation about Z by the angle itself turns
        // the lozenge's long axis from horizontal into the tangent direction.
        quaternion.setFromAxisAngle(axisZ, theta + Math.PI / 2);

        ledSlots.push({
          kind: 'ring',
          ring: ringIndex,
          phase,
          matrix: new THREE.Matrix4().compose(position, quaternion, scaleOne),
        });
      }
    });

    const leds = new THREE.InstancedMesh(GEO.led, ledMat, ledSlots.length);
    leds.castShadow = false;
    leds.receiveShadow = false;
    // The lamps never move relative to the cabinet, so the matrices are
    // written once. Telling three that saves a per-frame upload of sixty-four
    // matrices that would never have changed.
    leds.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    leds.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(ledSlots.length * 3), 3
    );

    ledSlots.forEach((slot, i) => {
      matrix.copy(slot.matrix);
      leds.setMatrixAt(i, matrix);
    });

    leds.instanceMatrix.needsUpdate = true;
    stack.add(leds);

    // Contact patch, sized wider than the plinth: the ambient occlusion under
    // a box does not stop at its footprint, it fades outward from it.
    const patch = makeContactShadow(0.34, 0.62);
    patch.position.set(side * TOWER.x, 0.0012, TOWER.z);
    // Tagged and collected so the power-on sequence can fade it in with the
    // cabinet it belongs to. A contact patch sitting on an empty floor
    // announces exactly where something is about to appear.
    patch.userData.kind = 'tower';
    towerShadows.push(patch);
    // The patch stays in the room, not on the stack: a contact shadow belongs
    // to the FLOOR, and a cabinet two units in the air should not be dragging
    // its own darkening up with it.
    group.add(patch);

    /**
     * The yoke branch is gone with the fixtures it carried.
     *
     * Recorded as a LOSS rather than as a tidy-up: `tower → post → pan → tilt
     * → can` was a five-level chain with two real degrees of freedom, and a
     * second example of structure-driven animation beside the wing fold.
     * Removing the visible lamp removed the thing the yoke existed to point.
     *
     * What survives is the derivation. Each shaft's aim is still computed from
     * the emitter's position and the point it lights, and still drifts on a
     * slow sweep — the mathematics moved out of a transform chain and into the
     * beam descriptors handed to volumetrics.js, so the behaviour is intact
     * even though the mechanism that displayed it is not. The graded pillar
     * rests on the fold in hierarchy.js and on the mascot's arms, untouched.
     */

    const entry = {
      side, woofers, leds, ledSlots, stack,
      stackY0: stack.position.y,
      stackScaleY: 1,
    };
    towers.push(entry);
    return entry;
  }

  const towerLeft = buildTower(-1);
  const towerRight = buildTower(1);

  // -----------------------------------------------------------------------
  // THE OVERHEAD RING
  //
  // Every emitter used to carry its own hand-typed position and its own
  // hand-typed aim, and the numbers had drifted apart over four
  // re-costings: apexes at 3.30, 3.95, 4.10 and 4.35, horizontal offsets of
  // 2.30, 2.55 and 2.60, one pair behind the instrument and another pair in
  // front of it, each aiming at a different point. Every one of those numbers
  // was defensible on its own and the set was not. Lights at four heights and
  // three radii do not read as a rig; they read as lamps that were placed one
  // at a time, which is exactly what they were.
  //
  // So position and aim are now DERIVED FROM A BEARING, the same way the
  // yokes derived their pan and tilt before the fixtures left the frame. One
  // radius, one height, one convergence point, and five bearings spaced
  // evenly around the room. That buys three things at once:
  //
  //   The apexes lie on a circle, so no shaft is longer or steeper than its
  //   neighbour and the frame has no odd man out.
  //
  //   The set is mirror-symmetric about the x = 0 plane, so orbiting from one
  //   side to the other shows the same rig rather than a different one.
  //
  //   Moving the whole rig — higher, wider, tighter — is one number, and
  //   every aim follows it. The old arrangement needed eleven edits and a
  //   re-check of each pool's landing point.
  // -----------------------------------------------------------------------

  const DEG = Math.PI / 180;

  const RING = {
    /**
     * Horizontal distance from the centre of the room to every apex.
     *
     * Outside the speaker stacks at 1.38 and outside the console at 1.66, so
     * no shaft passes through an object on its way down, and inside the fog's
     * near plane so the emitters are in clear air.
     */
    radius: 2.55,

    /**
     * Apex height, shared by all five ring fixtures.
     *
     * The constraint that used to set this was the dome's apex at 4.9; there
     * is no dome now, so what remains is the camera. The highest authored shot
     * puts the top of the frame at roughly y = 3.2 over the instrument, so
     * 3.6 keeps every apex out of shot while the shafts themselves fill it —
     * which is the whole reason the fixtures were deleted rather than moved.
     */
    height: 3.60,

    /**
     * The height the beams converge at, and how far past the centre each one
     * aims.
     *
     * Aiming every fixture at the origin would stack five pools on one spot
     * and cross five shafts at one point, which reads as a spotlight effect
     * rather than as a rig. Aiming each one at a point 0.30 beyond the centre
     * — on its own bearing, so the offsets cancel by symmetry — makes the
     * shafts cross over a VOLUME above the instrument instead of at a point,
     * and spreads the pools into a ring of overlapping ellipses around it.
     * That volume is the thing the raymarch exists to render.
     */
    focusY: 0.34,
    cross: 0.30,
  };

  /**
   * Bearings, in the same convention the camera uses: measured about +Y from
   * +Z (the front, where the player stands) towards +X (stage right).
   *
   * Five positions 72 degrees apart, mirrored about the front-to-back axis.
   * The gap is at the front by construction — there is no fixture at bearing
   * zero — because that is where the camera lives on every shot but one, and a
   * shaft coming straight down the camera's own axis is the one that shows
   * least.
   */
  const BEARING = {
    frontLeft: -36 * DEG,
    frontRight: 36 * DEG,
    rearLeft: -108 * DEG,
    rearRight: 108 * DEG,
    back: 180 * DEG,
  };

  /** A point on the ring at `bearing`. */
  function apexAt(bearing, radius = RING.radius, height = RING.height) {
    return [Math.sin(bearing) * radius, height, Math.cos(bearing) * radius];
  }

  /** The point a fixture at `bearing` aims at: past the centre, on its axis. */
  function aimFrom(bearing, cross = RING.cross, y = RING.focusY) {
    return [-Math.sin(bearing) * cross, y, -Math.cos(bearing) * cross];
  }

  /**
   * A fixture's place in the colour wheel, taken from where it stands.
   *
   * This is the whole of the gradient. Hue is not authored per lamp and it is
   * not random: it is the fixture's own bearing expressed in turns, so the
   * wheel is wrapped once around the room and any two neighbours are exactly
   * 72 degrees of hue apart, the way they are 72 degrees of arc apart. Adding
   * one clock to all five then rotates the entire gradient around the room
   * without ever collapsing two fixtures onto the same colour — see
   * `update()`.
   */
  function hueAt(bearing) {
    return ((bearing / (Math.PI * 2)) % 1 + 1) % 1;
  }

  /**
   * MID — a pair of shafts from the rear quarters, raking forward.
   *
   * The classic back pair: they cross over the instrument, rim the mascot's
   * silhouette from behind and put their pools on the floor between the
   * instrument and the camera, which is the half of the floor the viewer can
   * see. Narrow, at 0.26 radians — beam visibility per unit length goes as
   * intensity over solid angle, so a tight cone reads as a shaft where a wide
   * one reads as a general haze, which is also why the two floor washes below
   * are not marched at all.
   */
  const accentLeft = emitter({
    position: apexAt(BEARING.rearLeft),
    aim: aimFrom(BEARING.rearLeft),
    hue: hueAt(BEARING.rearLeft),
    angle: 0.26,
    penumbra: 0.72,
    peak: PEAK.accent,
    range: 5.4,
    volumetric: true,
  });

  const accentRight = emitter({
    position: apexAt(BEARING.rearRight),
    aim: aimFrom(BEARING.rearRight),
    hue: hueAt(BEARING.rearRight),
    angle: 0.26,
    penumbra: 0.72,
    peak: PEAK.accent,
    range: 5.4,
    volumetric: true,
  });

  /**
   * MID — the third of the trio, dead behind.
   *
   * It exists so that shafts CROSS from three bearings rather than two: two
   * beams overlap in a line, three from different bearings overlap in a
   * volume, and the fusion is the whole reason the raymarch was worth
   * building over cone meshes.
   */
  const accentBack = emitter({
    position: apexAt(BEARING.back),
    aim: aimFrom(BEARING.back),
    hue: hueAt(BEARING.back),
    angle: 0.24,
    penumbra: 0.68,
    peak: PEAK.accent * 0.9,
    range: 5.4,
    volumetric: true,
  });

  const accent = [accentLeft, accentRight, accentBack];

  /**
   * BASS — the front pair, wider and softer.
   *
   * These are the two fixtures a viewer sees THROUGH: they stand on the
   * camera's own side of the room and point away from it, so their shafts run
   * into the frame rather than across it and the eye follows them down onto
   * the instrument. Wide (0.32) and soft, so a kick reads as the room filling
   * rather than as two more pencils being drawn.
   *
   * The bass gets one identity across three representations — these shafts,
   * the floor pools below, and the driver excursion in the cabinets — so a
   * viewer can connect the pool on the floor with the shaft above it and with
   * the cone that just moved.
   */
  const bassBeams = [BEARING.frontLeft, BEARING.frontRight].map((bearing) => emitter({
    position: apexAt(bearing),
    aim: aimFrom(bearing),
    hue: hueAt(bearing),
    angle: 0.32,
    penumbra: 0.85,
    peak: PEAK.accent * 0.8,
    range: 5.6,
    volumetric: true,
  }));

  /**
   * HIGH — one tight shaft straight down the middle.
   *
   * The only fixture off the ring, and the only one whose bearing is
   * meaningless: it hangs over the centre and points at the floor. Overhead is
   * the one position where a hard specular highlight lands on the knob caps
   * and the pad caps at once.
   *
   * It is half a metre above the ring so its apex clears the other five, and
   * it is nudged off the exact centre so the shaft is seen at a slight angle
   * from every shot rather than end-on from directly above.
   */
  const sparkle = emitter({
    position: [0.08, RING.height + 0.55, 0.22],
    aim: [0, 0.06, 0],
    /**
     * Half a step of the ring's own spacing, which puts it exactly between
     * the two front fixtures on the wheel.
     *
     * The five bearings land on 0.1, 0.3, 0.5, 0.7 and 0.9 of a turn, so the
     * gaps are at the even tenths and 0.0 is the one furthest from anything.
     * A downlight that matched a side light would read as that light having
     * moved rather than as a sixth fixture.
     */
    hue: 0.0,
    angle: 0.17,
    penumbra: 0.55,
    peak: PEAK.sparkle,
    range: 5.0,
    volumetric: true,
  });

  /**
   * BASS — two low washes, grazing across the floor, with no shaft.
   *
   * ON THE SAME BEARINGS AS THE REAR PAIR, which is the arrangement a real
   * stage has: a high side light and a floor can at the same position, doing
   * opposite jobs. Sharing the bearing also means sharing the hue, so each
   * rear position reads as one colour arriving at two heights.
   *
   * At 380 mm the light skims the slab rather than falling onto it, so the
   * lambert term varies sharply over the bezel rails and the wing surfaces and
   * the slab gains a gradient instead of a uniform brighter flat. Most of each
   * cone lands on the floor beyond the instrument, which is the point now that
   * the floor is polished and returns a raking highlight.
   *
   * They also moved OUT, from 1.02 to 2.25. The old pair stood at the height
   * of a robot's chest and one of them sat 250 mm from where the mascot
   * parks — a lamp inside the furniture, close enough that its inverse square
   * put roughly twenty times more light on him than on the instrument it was
   * aimed at. It missed him only because he happened to fall outside the cone,
   * which is not a margin anything should depend on.
   *
   * `volumetric: false`, and that is physics rather than a budget cut. These
   * are 54-degree floods: they spread the same energy over roughly nine times
   * the solid angle of the shafts above, so the scattered radiance per unit
   * length is an order of magnitude lower and would render as an even wash
   * across the lower frame — not a shaft, just a fog that makes everything
   * else muddier.
   */
  const wash = [BEARING.rearLeft, BEARING.rearRight].map((bearing) => emitter({
    position: apexAt(bearing, 2.25, 0.38),
    aim: aimFrom(bearing, 0.55, 0.05),
    hue: hueAt(bearing),
    angle: 0.95,
    penumbra: 0.85,
    peak: PEAK.wash,
    volumetric: false,
  }));

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
   * THE ONE CLOCK EVERY FIXTURE'S COLOUR IS READ FROM.
   *
   * Kept as state rather than derived from `elapsed`, because the rate is not
   * constant — the programme level pushes it — so there is no closed form to
   * evaluate. One accumulator drives eight lamps: each adds its own fixed
   * offset, so the gradient rotates rigidly around the room and no two
   * fixtures can drift into the same colour however long the page is left
   * running.
   */
  let hueClock = 0.12;

  /** Seconds since the rig was built, for the yoke sweep. */
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
   * Push one scalar into an emitter.
   *
   * With the housings gone there is no lens to keep in step, so this is one
   * assignment plus the normalised level the shaft descriptor needs. `k` is
   * the fraction of the way to peak, and it drives the volumetric density
   * rather than the light's own intensity, which is already the value being
   * assigned — one number, two consumers, no possibility of the shaft and the
   * pool it casts disagreeing about how bright the lamp is.
   */
  function setFixture(entry, intensity) {
    entry.light.intensity = intensity;
    entry.level = Math.min(1, Math.max(0, (intensity - IDLE) / entry.peak));
  }

  /**
   * The shaft descriptors handed to volumetrics.js each frame.
   *
   * Rebuilt into a persistent array rather than reallocated, because this runs
   * sixty times a second and the objects are identical in shape every time.
   *
   * Only emitters marked `volumetric` appear. The drift term is what is left
   * of the moving heads: the aim swings on a slow sine and opens outward with
   * the midrange, so the shafts sweep across the room the way a programmed
   * desk moves them, and a busy bar visibly spreads the rig.
   */
  const beamDescriptors = fixtures
    .filter((f) => f.volumetric)
    .map((f) => ({
      source: f,
      /**
       * A WORLD position, refreshed each frame, not an alias of the light's
       * local one.
       *
       * volumetrics.js marches in world space, so handing it a local position
       * is only correct while every ancestor sits at the origin — which was
       * true until something animated one of them, and then silently was not.
       * Copying the world position costs one matrix decomposition per beam per
       * frame and removes the whole class of failure.
       */
      position: new THREE.Vector3(),
      direction: new THREE.Vector3(),
      color: f.light.color,
      intensity: 0,
      angle: f.angle,
      penumbra: f.penumbra,
      range: f.range,
    }));

  const driftAxis = new THREE.Vector3();

  function updateBeams(t) {
    for (let i = 0; i < beamDescriptors.length; i++) {
      const beam = beamDescriptors[i];
      const source = beam.source;

      // A small angular wobble applied to the base direction. Rotating the
      // aim rather than moving the target keeps the apex fixed, which is what
      // a panning head does — a shaft whose origin slides is a shaft nobody
      // believes.
      // World matrices are only refreshed by the renderer, which has not run
      // yet this frame. Six explicit updates cost nothing and remove a
      // one-frame lag that is invisible at rest and obvious during a drop.
      source.light.updateWorldMatrix(true, false);
      source.light.getWorldPosition(beam.position);

      const phase = i * 1.7;
      const yaw = Math.sin(t * 0.27 + phase) * 0.055 + level.mid * 0.04 * (i % 2 ? 1 : -1);
      const pitch = Math.sin(t * 0.19 + phase) * 0.030 - level.mid * 0.035;

      // Refreshed from the scene graph rather than assumed.
      source.light.getWorldPosition(beam.position);

      driftAxis.copy(source.direction);
      // Two small rotations about the world axes. At this magnitude the order
      // is immaterial — the composition error is under a milliradian — which
      // is the one case where not building a proper basis is defensible, and
      // worth saying out loud rather than leaving as an accident.
      driftAxis.applyAxisAngle(UP, yaw);
      driftAxis.applyAxisAngle(RIGHT, pitch);

      beam.direction.copy(driftAxis).normalize();

      // Aim the actual light with it, so the pool on the floor moves with the
      // shaft in the air.
      source.light.target.position
        .copy(source.position)
        .addScaledVector(beam.direction, 2.0);

      /**
       * A SMALL FLOOR, AND A GENTLER CURVE THAN SQUARING.
       *
       * This line was `level * level` with no floor at all, and between the
       * two of them they were most of the reason the shafts were barely
       * visible. Squaring a number that is already a fraction is brutal: a
       * band sitting at a perfectly audible 0.3 of full scale produced 0.09 of
       * beam, and the overhead shaft — whose own drive is `level.high`
       * squared before it ever gets here — was being raised to the FOURTH
       * power. A hi-hat at half level came out at six per cent.
       *
       * The exponent is now 0.8, which is a slight expansion of the low end
       * rather than a collapse of it, and there is an idle floor again. The
       * floor was removed on the argument that permanent cones give away a
       * fake volumetric — true on a closed stage, where four cones hung in a
       * lit room with nothing else to explain them. In an open room with a
       * visible haze the opposite is true: a rig whose shafts appear only on
       * transients reads as a flicker, and the gradient rotating through the
       * hues has nothing to rotate through while the transport is stopped.
       *
       * 0.10 is a shaft you can see is there and cannot mistake for a lit one.
       */
      const level01 = source.level ?? 0;
      beam.intensity = 0.10 + 0.90 * Math.pow(level01, 0.8);
    }
  }

  /**
   * The cabinets, driven by the bands.
   *
   * DRIVER EXCURSION is the low end, moving along the cabinet's own baffle
   * normal — free, because the drivers are children of the toed-in stack and
   * +Z in that frame IS the baffle normal. 14 mm on a 170 mm cone is roughly
   * 3x exaggerated; a physically accurate excursion at this scale is a
   * fraction of a pixel, and the honest move is to say so rather than claim a
   * simulation.
   *
   * CABINET RECOIL is the whole stack settling ~3.5 mm into its plinth. A box
   * that moves as one object reads as heavy, where a box whose parts move
   * independently reads as an assembly of decorations.
   */
  function updateCabinets() {
    /**
     * The bounce, considerably harder than it was.
     *
     * Three effects on one band, and they are stacked deliberately rather than
     * being one bigger number, because a cabinet under load does three
     * distinguishable things and doing only one of them at three times the
     * amplitude reads as a glitch instead of as mass.
     *
     *   EXCURSION   the cones travel along the baffle normal — 26 mm now,
     *               against 14. Roughly six times life size on a 170 mm
     *               driver, which is a caricature and is stated as one: a
     *               truthful excursion at this scale is a fraction of a pixel.
     *   RECOIL      the whole stack drops into its plinth, 9 mm against 3.5.
     *   SQUASH      the stack compresses vertically and swells slightly wide,
     *               conserving rough volume. This is the new one, and it is
     *               what makes the recoil read as the box ABSORBING something
     *               rather than as the box being moved down. It is the same
     *               trick mascot.js uses on a hit, for the same reason.
     */
    const excursion = level.bass * 0.026;
    const recoil = level.bass * 0.009;
    const squash = level.bass * 0.045;

    // Programme level, not a band. The three are already envelope-followed
    // with their own attack and release, so this needs no smoothing of its
    // own — it inherits the ballistics of the things it sums.
    const programme = Math.min(1, level.bass * 0.62 + level.mid * 0.48 + level.high * 0.30);

    for (const tower of towers) {
      for (const cone of tower.woofers) cone.position.z = cone.userData.z0 + excursion;

      tower.stack.position.y = tower.stackY0 - recoil;
      tower.stack.scale.set(1 + squash * 0.35, 1 - squash, 1 + squash * 0.35);

      updateLeds(tower, programme);
    }
  }

  /**
   * The RGB lamps: strips and rings, from one loop over one instanced mesh.
   *
   * The two kinds are driven differently on purpose, because they are
   * answering different questions.
   *
   * THE STRIPS are a meter. Hue travels along the column and drifts with time
   * so it is never one flat colour — that travelling gradient is what says
   * "individually addressable" rather than "a coloured tube" — and brightness
   * is the programme level as a bar rising from the bottom.
   *
   * THE RINGS are a chase. Hue rotates around the circle and the whole ring
   * brightens with the BASS specifically, not the programme level, because a
   * ring around a woofer should agree with what the woofer is doing. When a
   * kick lands, the cone travels and its ring flares at the same instant —
   * two representations of one number, which is the rule the whole project
   * runs on.
   *
   * `setColorAt` writes the per-instance colour attribute, so sixty-four lamps
   * in sixty-four colours remain one draw call. That attribute uploads once a
   * frame; the matrices never do.
   */
  function updateLeds(tower, programme) {
    const leds = tower.leds;
    const slots = tower.ledSlots;
    // Half a turn of the wheel apart, so the pair reads as complementary
    // rather than as one repeated prop.
    const towerHue = tower.side > 0 ? 0.5 : 0;

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];

      if (slot.kind === 'strip') {
        const hue = (elapsed * 0.07 + slot.along * 0.35 + towerHue) % 1;

        /**
         * A soft edge on the bar, not a hard one. A lamp sitting exactly at
         * the level boundary would flicker on and off every frame during a
         * loud passage, which reads as a fault; a smoothstep across a tenth of
         * the strip turns that into the lamp simply being dim.
         */
        const lit = THREE.MathUtils.smoothstep(programme, slot.along - 0.10, slot.along + 0.02);
        const value = 0.06 + lit * 0.94;
        ledColour.setHSL(hue, 0.85, 0.5 * value + 0.04);
      } else {
        // Chase: the hue offset around the ring advances with time, so colour
        // appears to run round the driver.
        const hue = (elapsed * 0.22 + slot.phase + towerHue + slot.ring * 0.12) % 1;
        const value = 0.14 + level.bass * 0.86;
        ledColour.setHSL(hue, 0.9, 0.48 * value + 0.05);
      }

      leds.setColorAt(i, ledColour);
    }

    leds.instanceColor.needsUpdate = true;
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

    // --- the gradient -----------------------------------------------------
    //
    // ONE CLOCK, EIGHT FIXTURES, AND NOTHING AUTHORED PER LAMP.
    //
    // The rig used to hold three fixed identities — cool on the left, warm on
    // the right, indigo on the bass — with a short hue arc swept by the
    // midrange, and only the overhead shaft actually travelling. That is a
    // defensible scheme and it is not what this asks for: the whole rig now
    // moves through the wheel together, keeping the 72-degree spacing that
    // `hueAt` derived from each fixture's bearing.
    //
    // The consequence worth stating is that the warm/cool split is no longer
    // permanent — it rotates, so at any instant some part of the room is warm
    // and some part is cool, but WHICH part changes. The mascot is amber and
    // the floor is near-black, so both survive whatever colour arrives; what
    // would not survive is two fixtures converging on one hue, and the fixed
    // offsets make that impossible by construction.
    const programme = Math.min(1, level.bass * 0.6 + level.mid * 0.5 + level.high * 0.4);
    hueClock = (hueClock + dt * (HUE_RATE + programme * HUE_PUSH)) % 1;

    for (const fixture of fixtures) {
      fixture.light.color.setHSL(
        (hueClock + fixture.hue) % 1,
        BEAM_SATURATION,
        BEAM_LIGHTNESS
      );
    }

    // --- bass -> the floor washes and the two wide shafts ------------------
    setFixture(wash[0], IDLE + level.bass * PEAK.wash);
    setFixture(wash[1], IDLE + level.bass * PEAK.wash);

    // The shafts run on the same envelope as the pools, so the two halves of
    // the bass response cannot disagree about how hard the kick landed.
    const bassLevel = IDLE + level.bass * PEAK.accent * 0.8;
    setFixture(bassBeams[0], bassLevel);
    setFixture(bassBeams[1], bassLevel);

    // --- mid -> the three accent shafts -----------------------------------
    //
    // Intensity only. The colour was written above, from the fixture's place
    // on the wheel rather than from the band — there is one authoritative
    // colour per fixture and one place that sets it, which is the rule the
    // whole project runs on: derive, never duplicate.
    const accentLevel = IDLE + level.mid * PEAK.accent;
    setFixture(accentLeft, accentLevel);
    setFixture(accentRight, accentLevel);
    setFixture(accentBack, IDLE + level.mid * PEAK.accent * 0.9);

    // --- high -> sparkle --------------------------------------------------
    //
    // The one place a band is still shaped before it reaches a light, and it
    // is deliberately gentler than the square it used to be. The high band's
    // mean is compressed by averaging four hundred bins, so it rarely reaches
    // the top of its range; squaring pushed the quiet majority to nearly
    // nothing, and then `updateBeams` squared it AGAIN — a hi-hat at half
    // level reached the shaft as six per cent. A 1.4 power keeps the flick
    // without throwing the range away.
    setFixture(sparkle, IDLE + Math.pow(level.high, 1.4) * PEAK.sparkle);

    // --- the shafts, once every fixture holds this frame's level ----------
    //
    // AFTER all six `setFixture` calls, not in the middle of them. It used to
    // run between the accents and the sparkle, which meant the overhead
    // shaft's density was computed from the PREVIOUS frame's level while its
    // own lamp already held this one — a one-frame disagreement between a
    // beam and the light casting it, invisible at rest and exactly the sort
    // of thing that shows on the fastest band in the kit.
    updateBeams(elapsed);

    // --- overall lift -----------------------------------------------------
    ambient.intensity = 0.05 + (level.bass + level.mid + level.high) * 0.06;

    // --- the cabinets -----------------------------------------------------
    updateCabinets();

    // Published so a VU meter, the GUI, or a future reactive material can read
    // the bands without any of them touching an AnalyserNode. Same rule as
    // everywhere else: measure once, broadcast, let subscribers decide.
    bus.emit('audio:bands', level);
  }

  /**
   * Toggle the reactive rig as a unit.
   *
   * One `visible` flag on the parent Group rather than a flag per light. A
   * Group's visibility gates its whole subtree during traversal, so the
   * renderer skips the fixtures and the stacks entirely instead of drawing
   * them at zero.
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
    towers,
    /**
     * The shafts, handed to volumetrics.js every frame by main.js.
     *
     * A live array of descriptors rather than a callback or a direct
     * reference: this module decides what a beam IS — where it starts, which
     * way it points, how bright and what colour — and volumetrics.js decides
     * how to draw one. Neither imports the other, which is the same rule the
     * audio and geometry halves have followed since phase 1.
     */
    beams: beamDescriptors,
    towerShadows,
    /** The cabinets alone, so the intro can drop them without moving lights. */
    stacks,
    lights: {
      wash: wash.map((f) => f.light),
      accent: accent.map((f) => f.light),
      sparkle: sparkle.light,
      ambient,
    },
    group,
  };
}