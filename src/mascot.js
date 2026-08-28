/**
 * mascot.js — Rob8, the drum tech.
 *
 * A tracked service robot: boxy amber shell, two binocular eye barrels on a
 * neck, two arms on sticks. The name works twice over now that he is a machine.
 *
 * Rob8 is not decoration bolted onto the scene. He is a second hierarchical
 * model with his own joint chain, and he is animated by the same mechanism the
 * pads are — rig.js subscribes to 'pad:hit' and flashes a pad, and this file
 * subscribes to the identical event and swings an arm. Neither knows the other
 * exists, and neither knows whether the hit came from a mouse, a key or the
 * sequencer. That is the decoupling rule paying for itself a third time: a
 * whole animated character was added without editing audio.js, interaction.js
 * or rig.js.
 *
 * WHY A ROBOT IS THE RIGHT MASCOT FOR THIS PROJECT
 *
 * A creature is spheres. A robot is rounded boxes and cylinders — which is
 * exactly what geometry.js already generates, so the character is built from
 * the same primitives, with the same fillets, as the instrument it stands next
 * to. The art direction asked for smooth corners everywhere; a machine is the
 * one kind of character where visible panel edges and hard-surface shapes are
 * the point, so every fillet reads as a manufacturing decision rather than as
 * a modelling shortcut.
 *
 * The chain, per arm:
 *
 *   body -> swing -> lift -> upper arm -> elbow -> forearm -> wrist -> stick
 *
 * Swing and lift are separate groups on separate axes rather than one Euler
 * triple. Composing two rotations in one Euler depends on the order three
 * multiplies them in, and getting that wrong gives an arm that lifts sideways
 * once it has been swung out. A group per axis makes the composition explicit
 * and the bug impossible. The head does the same thing with yaw and pitch.
 */

import * as THREE from 'three';
import { bus } from './events.js';
import { PALETTE } from './palette.js';
import { PAD_BY_ID, PAD_INDEX } from './pads.js';
import { toonRamp } from './textures.js';
import { roundedBoxGeometry, roundedCylinderGeometry } from './geometry.js';

// ---------------------------------------------------------------------------
// Proportions
//
// Cartoon proportion is mostly one rule: make the head far too big. Rob8's eye
// barrels are each nearly half the width of his whole chassis, which is what
// reads as "character" rather than "appliance".
// ---------------------------------------------------------------------------

const BODY = { w: 0.20, h: 0.19, d: 0.16, y: 0.145 };
const TREAD = { w: 0.055, h: 0.075, d: 0.21, x: 0.105 };
const EYE = { offset: 0.048, radius: 0.040, barrel: 0.055 };

/** Where each arm hangs, and how it rests with the sticks up and ready. */
const ARMS = [
  { side: -1, swing: -0.25 },
  { side: 1, swing: 0.25 },
];

const REST = { lift: -1.50, elbow: 0.60, wrist: 0.30 };

// ---------------------------------------------------------------------------

/**
 * Build Rob8.
 *
 * @param {{ scale?: number }} options
 */
export function buildMascot({ scale = 1.2 } = {}) {
  /**
   * One ramp texture shared by every material on the character.
   *
   * MeshToonMaterial rather than MeshStandardMaterial, and only here. The rig
   * is a manufactured object and gets physically based shading; Rob8 is a
   * drawn character and gets a banded ramp. Two shading models in one scene is
   * a deliberate art-direction choice, not an inconsistency — it is the same
   * separation an animated film makes between its sets and its cast, and it is
   * what stops him reading as another moulded plastic part.
   *
   * It also means the toon ramp is a genuinely different kind of texture from
   * the colour, normal and roughness maps the rig uses: this one is sampled as
   * a transfer function on the lighting, not as a property of a surface.
   */
  const gradientMap = toonRamp();

  const toon = (colour, extra = {}) =>
    new THREE.MeshToonMaterial({ color: colour, gradientMap, ...extra });

  const materials = {
    shell: toon(PALETTE.mascotBody),
    shade: toon(PALETTE.mascotShade),
    metal: toon(PALETTE.mascotMetal),
    dark: toon(PALETTE.mascotDark),
    lens: toon(PALETTE.mascotLens),
    stick: toon(PALETTE.stick),
    // One iris material for both eyes, so they light as a pair — and so a pad
    // hit repaints exactly one thing.
    iris: toon(PALETTE.mascotLens, {
      emissive: new THREE.Color(PALETTE.mascotIris),
      emissiveIntensity: 1.0,
    }),
  };

  // --- shared geometry -----------------------------------------------------
  //
  // Built once and drawn with different matrices. A cylinder from the lathe
  // stands on its own origin pointing up, so it is translated onto its centre
  // and turned onto the axis it is wanted on, once, at build time rather than
  // per instance.

  function axialCylinder(radius, length, corner, axis) {
    const geo = roundedCylinderGeometry(radius, length, corner, 24, 3);
    geo.translate(0, -length / 2, 0);
    if (axis === 'z') geo.rotateX(Math.PI / 2);
    else if (axis === 'x') geo.rotateZ(-Math.PI / 2);
    return geo;
  }

  const GEO = {
    body: roundedBoxGeometry(BODY.w, BODY.h, BODY.d, 0.028, 3),
    hatch: roundedBoxGeometry(0.115, 0.075, 0.012, 0.006, 3),
    tread: roundedBoxGeometry(TREAD.w, TREAD.h, TREAD.d, 0.030, 3),
    wheel: axialCylinder(0.024, 0.014, 0.006, 'x'),
    neck: roundedBoxGeometry(0.045, 0.055, 0.045, 0.018, 3),
    bridge: roundedBoxGeometry(0.075, 0.028, 0.030, 0.013, 3),
    // The lathe rounds only its top rim, so after turning onto +Z the domed
    // end faces forward and the flat end sits inside the housing — which is
    // the right way round for both a lens and a wheel.
    barrel: axialCylinder(EYE.radius, EYE.barrel, 0.014, 'z'),
    lens: axialCylinder(EYE.radius * 0.82, 0.012, 0.005, 'z'),
    iris: axialCylinder(EYE.radius * 0.42, 0.010, 0.004, 'z'),
    upperArm: roundedBoxGeometry(0.024, 0.075, 0.024, 0.011, 3),
    forearm: roundedBoxGeometry(0.021, 0.065, 0.021, 0.010, 3),
    hand: roundedBoxGeometry(0.030, 0.022, 0.026, 0.009, 3),
    stick: roundedCylinderGeometry(0.0072, 0.115, 0.0072, 16, 3),
  };

  function part(geometry, material, x = 0, y = 0, z = 0) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  // --- the nesting that everything else hangs from -------------------------

  const root = new THREE.Group();
  root.scale.setScalar(scale);

  const sway = new THREE.Group();       // slow idle lean
  root.add(sway);

  const bob = new THREE.Group();        // breathing, and the squash on a hit
  sway.add(bob);

  // --- chassis and tracks --------------------------------------------------

  const body = part(GEO.body, materials.shell, 0, BODY.y, 0);
  bob.add(body);

  // A recessed panel on the chest. It costs one mesh and it is most of what
  // makes the shell read as a fabricated housing rather than a painted block.
  bob.add(part(GEO.hatch, materials.shade, 0, BODY.y - 0.005, BODY.d / 2 - 0.002));

  const wheelSets = [];

  for (const side of [-1, 1]) {
    bob.add(part(GEO.tread, materials.dark, side * TREAD.x, TREAD.h / 2, 0));

    // Road wheels, on the outer face where they can be seen. They counter-
    // rotate a little when he rocks, which is the cheapest possible way to
    // suggest the tracks are load-bearing rather than painted on.
    const wheels = [];
    for (const z of [-0.068, 0, 0.068]) {
      const wheel = part(
        GEO.wheel,
        materials.metal,
        side * (TREAD.x + TREAD.w / 2 - 0.004),
        TREAD.h / 2,
        z
      );
      bob.add(wheel);
      wheels.push(wheel);
    }
    wheelSets.push(wheels);
  }

  // --- neck and head -------------------------------------------------------

  const neck = new THREE.Group();
  neck.position.set(0, BODY.y + BODY.h / 2 - 0.005, -0.01);
  bob.add(neck);
  neck.add(part(GEO.neck, materials.metal, 0, 0.0275, 0));

  const headYaw = new THREE.Group();
  headYaw.position.y = 0.055;
  neck.add(headYaw);

  const headPitch = new THREE.Group();
  headYaw.add(headPitch);

  headPitch.add(part(GEO.bridge, materials.dark, 0, 0, 0));

  /**
   * The eye barrels.
   *
   * These are the whole performance. A binocular head has one expressive
   * degree of freedom that a face does not: the two barrels can tilt against
   * each other, and that single angle reads as eyebrows. Tilting the outer
   * edges up is surprise, down is a scowl — and it is one number per eye.
   */
  const eyes = [-1, 1].map((side) => {
    const group = new THREE.Group();
    group.position.set(side * EYE.offset, 0, 0.004);
    headPitch.add(group);

    group.add(part(GEO.barrel, materials.shell, 0, 0, -0.026));
    group.add(part(GEO.lens, materials.lens, 0, 0, 0.030));

    // The iris sits in its own group so a blink can squash it without
    // squashing the housing it is set into.
    const iris = new THREE.Group();
    iris.position.z = 0.034;
    group.add(iris);
    iris.add(part(GEO.iris, materials.iris));

    return { group, iris, side };
  });

  // --- arms ----------------------------------------------------------------

  const arms = ARMS.map(({ side, swing }) => {
    // Swing carries the arm away from the body; lift swings it fore and aft.
    // Two groups, two axes, no Euler order to get wrong.
    const shoulder = new THREE.Group();
    shoulder.position.set(side * (BODY.w / 2 - 0.004), BODY.y + 0.045, 0.01);
    shoulder.rotation.z = swing;
    bob.add(shoulder);

    const lift = new THREE.Group();
    lift.rotation.x = REST.lift;
    shoulder.add(lift);
    lift.add(part(GEO.upperArm, materials.metal, 0, -0.0375, 0));

    const elbow = new THREE.Group();
    elbow.position.y = -0.075;
    elbow.rotation.x = REST.elbow;
    lift.add(elbow);
    elbow.add(part(GEO.forearm, materials.metal, 0, -0.0325, 0));

    const wrist = new THREE.Group();
    wrist.position.y = -0.065;
    wrist.rotation.x = REST.wrist;
    elbow.add(wrist);
    wrist.add(part(GEO.hand, materials.dark, 0, -0.011, 0));

    const stick = part(GEO.stick, materials.stick, 0, -0.016, 0);
    // The lathe builds upward from its own origin, so most of a half turn
    // about X points the stick down out of the hand and angles it the way a
    // held stick actually sits.
    stick.rotation.x = Math.PI * 0.86;
    wrist.add(stick);

    // `swing0` remembers the authored rest angle, because the per-frame code
    // writes `shoulder.rotation.z` and would otherwise drift away from it.
    return { shoulder, lift, elbow, wrist, side, strike: 0, swing0: swing };
  });

  // -----------------------------------------------------------------------
  // Reacting to hits
  // -----------------------------------------------------------------------

  let nextArm = 0;
  const lookTarget = new THREE.Vector2(0, 0);
  const irisColour = new THREE.Color(PALETTE.mascotIris);
  const irisTarget = new THREE.Color(PALETTE.mascotIris);
  let flash = 0;

  /**
   * Swing an arm, without a pad being involved.
   *
   * Extracted so the intro can make Rob8 press something. The alternative was
   * for the intro to publish a fake `pad:hit`, which would have been shorter
   * and wrong: rig.js would flash a pad that has not been struck, and the
   * event log would show a note that was never played. An animation call and
   * a musical event are different things and should not share a channel just
   * because they happen to move the same arm.
   *
   * @param {number} velocity
   * @param {number | null} side  -1 or 1 to choose a specific arm
   */
  function strike(velocity = 1, side = null) {
    const arm = side === null
      ? arms[nextArm++ % arms.length]
      : arms.find((a) => a.side === side) ?? arms[0];

    if (arm) arm.strike = Math.max(arm.strike, velocity);
    flash = Math.max(flash, velocity);
    return arm;
  }

  bus.on('pad:hit', ({ padId, velocity = 1 }) => {
    // Alternate hands. A drummer who strikes everything with the same arm
    // reads as a machine, which is the one thing this machine must not do.
    strike(velocity);

    // The eyes take the colour of the pad that fired. The hue is already
    // carried by the pad definition and already drives the rim glow on the
    // instrument, so the character and the hardware light up in agreement
    // without either of them being told about the other.
    const pad = PAD_BY_ID.get(padId);
    if (pad) irisTarget.setHSL(pad.hue, 0.75, 0.62);

    // Glance towards the pad that fired. He stands off to one side, so this is
    // a suggestion of attention rather than a real look-at, which is all it
    // needs to be at this size on screen.
    const index = PAD_INDEX.get(padId);
    if (index !== undefined) {
      lookTarget.set(
        ((index % 4) - 1.5) * 0.10,
        -(Math.floor(index / 4) - 1.5) * 0.06
      );
    }
  });

  // -----------------------------------------------------------------------
  // Per-frame animation
  // -----------------------------------------------------------------------

  let blinkCountdown = 2.0;
  let blinking = 0;

  const BLINK_DURATION = 0.16;

  // -----------------------------------------------------------------------
  // Keeping time
  //
  // The arms did not move. That is worth stating plainly because it was not
  // obvious from the code: `strike` was decayed every frame and spent on the
  // body squash, the head dip and the eye flash, and the shoulder chain that
  // was built specifically to swing a stick was never written to at all. So a
  // hit made him flinch and never made him play.
  //
  // Two things fixed it, and they are different animations that happen to
  // share a joint chain.
  //
  //   THE STROKE is the reaction to a hit: the existing per-arm `strike`
  //   envelope, now driving lift, elbow and wrist so a stick actually comes
  //   down and springs back.
  //
  //   THE GROOVE is the thing a drummer does between hits, which is most of
  //   what makes one look like a drummer. He counts. The arms rise and fall on
  //   the beat whether or not anything is being struck, in opposite phase, so
  //   the sticks alternate the way hands do.
  //
  // The groove needs the tempo, and the tempo lives in audio.js — which this
  // module must never import. It arrives on the bus instead, the same way
  // every other cross-module fact does.
  // -----------------------------------------------------------------------

  let bpm = 100;
  let playing = false;

  /**
   * Beats since the transport started, as a running float.
   *
   * Advanced continuously in `update` rather than stepped on each
   * `transport:step` event, because a phase that only moves sixteen times a
   * bar is a phase that moves in visible jerks — the arms would tick rather
   * than swing. The events are used to CORRECT it instead: every downbeat
   * snaps the phase back to a whole number, so the swing stays locked to the
   * music without being quantised by it.
   *
   * The same relationship the lighting envelopes have with the analyser:
   * continuous motion, periodically corrected by discrete truth.
   */
  let beatPhase = 0;

  /** How much of the groove is showing, 0..1. Ramped, never switched. */
  let grooveAmount = 0;

  bus.on('transport:bpm', (payload) => { bpm = payload.bpm; });

  bus.on('transport:start', () => {
    playing = true;
    beatPhase = 0;
  });

  bus.on('transport:stop', () => { playing = false; });

  bus.on('transport:step', ({ step }) => {
    // Resync on the downbeat only. Correcting on every sixteenth would drag
    // the phase back four times a beat and flatten the swing into a stutter.
    if (step % 4 === 0) beatPhase = Math.round(beatPhase);
  });

  /**
   * @param {number} dt seconds since the last frame
   * @param {number} t  seconds since the page started
   */
  function update(dt, t) {
    // Strike envelopes, decayed exactly the way pad presses are. Same problem,
    // same answer: a tween per hit would have to be cancelled and restarted on
    // every retrigger, where multiplying by exp(-dt*k) retriggers for free.
    let impulse = 0;
    for (const arm of arms) {
      arm.strike *= Math.exp(-dt * 9);
      if (arm.strike < 0.001) arm.strike = 0;
      impulse = Math.max(impulse, arm.strike);
    }
    flash *= Math.exp(-dt * 6);

    // --- the beat --------------------------------------------------------
    //
    // Advanced in BEATS, from the tempo, so the groove is locked to the music
    // rather than to the wall clock. `bpm / 60` is beats per second, which is
    // the only conversion in here and the reason nothing needs retuning when
    // the tempo knob moves.
    if (playing) beatPhase += dt * (bpm / 60);

    // Ramped in and out over about a second rather than switched, so pressing
    // stop lets him wind down instead of freezing mid-swing.
    const grooveTarget = playing ? 1 : 0;
    grooveAmount += (grooveTarget - grooveAmount) * Math.min(1, dt * 3.2);

    const beat = beatPhase * Math.PI * 2;

    // --- chassis ---------------------------------------------------------
    sway.rotation.z = Math.sin(t * 0.9) * 0.030;

    /**
     * The body bob is the idle breath PLUS a bounce on the beat.
     *
     * Doubled frequency on the tempo term — `beat * 2` is eighth notes —
     * because a body that rises and falls once per beat reads as slow and
     * seasick at anything under 110 bpm. Bouncing on the eighths is what
     * people actually do, and it stays legible up to drill tempo.
     *
     * Negative sine so he is DOWN on the beat rather than up: weight drops
     * onto the downbeat, it does not launch off it.
     */
    bob.position.y =
      Math.sin(t * 2.1) * 0.006
      - impulse * 0.020
      - grooveAmount * Math.max(0, Math.sin(beat * 2)) * 0.012;

    // Squash and stretch, conserving rough volume: what is lost in height is
    // returned in width. Without the widening a squash reads as the character
    // shrinking rather than absorbing an impact.
    bob.scale.set(1 + impulse * 0.05, 1 - impulse * 0.075, 1 + impulse * 0.05);

    // Tracks rock back under the recoil.
    for (const wheels of wheelSets) {
      for (const wheel of wheels) wheel.rotation.x = -impulse * 0.9;
    }

    // --- arms ------------------------------------------------------------
    //
    // The joint chain that exists to swing a stick, finally being written to.
    //
    // Three joints move together and they are not three separate animations:
    // a drum stroke is one motion distributed down an arm, so all three are
    // driven from the same `strike` scalar with different gains and signs. The
    // upper arm drops, the elbow extends into the hit, and the wrist snaps
    // last — which is the order a real stroke happens in and the reason the
    // wrist gain is the largest of the three despite the smallest travel.
    for (const arm of arms) {
      /**
       * Opposite phase per side, so the sticks alternate.
       *
       * `side` is -1 or +1 and half a cycle is π, so multiplying by `side`
       * puts the two arms exactly out of step with each other. That single
       * term is most of what makes him read as playing rather than as
       * flapping: two hands moving together is a clap, two hands alternating
       * is a groove.
       */
      const phase = beat + (arm.side > 0 ? Math.PI : 0);
      const groove = Math.sin(phase) * grooveAmount * 0.20;

      // Idle sway, so he is never completely still even stopped.
      const idle = Math.sin(t * 1.1 + arm.side) * 0.035 * (1 - grooveAmount);

      arm.lift.rotation.x = REST.lift + groove + idle + arm.strike * 0.62;
      arm.elbow.rotation.x = REST.elbow - groove * 0.45 - arm.strike * 0.38;
      arm.wrist.rotation.x = REST.wrist - groove * 0.30 + arm.strike * 0.70;

      // A little shoulder rotation with the swing, so the arm travels slightly
      // outward as it lifts instead of hinging in one plane like a pump handle.
      arm.shoulder.rotation.z = arm.swing0 + groove * 0.12 * arm.side;
    }

    // --- head ------------------------------------------------------------
    // Drift rather than snap. A head that teleports to a new angle reads as a
    // glitch; one that takes a few frames reads as a glance.
    const ease = Math.min(1, dt * 6);
    headYaw.rotation.y += (lookTarget.x - headYaw.rotation.y) * ease;
    headPitch.rotation.x +=
      (lookTarget.y + 0.06 - impulse * 0.16 - headPitch.rotation.x) * ease;

    // Brows: outer edges lift with the impact, and breathe when idle.
    for (const eye of eyes) {
      const idle = Math.sin(t * 1.6 + eye.side) * 0.02;
      eye.group.rotation.z = eye.side * (0.10 + impulse * 0.22) + idle;
    }

    // --- blink -----------------------------------------------------------
    blinkCountdown -= dt;
    if (blinkCountdown <= 0 && blinking <= 0) {
      blinking = BLINK_DURATION;
      blinkCountdown = 2.4 + Math.random() * 3.6;
    }

    let openness = 1;
    if (blinking > 0) {
      blinking -= dt;
      // Half a cosine period over the blink: open, shut, open.
      const phase = Math.max(blinking, 0) / BLINK_DURATION;
      openness = Math.max(0.08, Math.abs(Math.cos(Math.PI * phase)));
    }

    for (const eye of eyes) eye.iris.scale.y = openness;

    // --- eye colour ------------------------------------------------------
    // Snap towards the struck pad's hue and drift back, so a fast pattern
    // leaves the eyes strobing through the kit's colours.
    irisColour.lerp(irisTarget, Math.min(1, dt * 7));
    materials.iris.emissive.copy(irisColour);
    materials.iris.emissiveIntensity = 0.85 + flash * 2.2;
  }

  /** Point the head somewhere in its own local space, for the intro. */
  function look(x, y) {
    lookTarget.set(x, y);
  }

  return { root, update, materials, strike, look, arms };
}