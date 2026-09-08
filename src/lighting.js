
/**
 lighting.js — the analyser, the frequency bands, and the reactive light rig.
*/

import * as THREE from 'three';
import { bus } from './events.js';
import { PALETTE } from './palette.js';
import { roundedBoxGeometry, roundedCylinderGeometry } from './geometry.js';
import { makeContactShadow } from './environment.js';

// -------------------
// Analysis parameters
// -------------------

/**
 2048 because i need 6 bins to register all the sounds
*/
const FFT_SIZE = 2048;

/**
  The analyser's own smoothing
*/
const SMOOTHING = 0.55;

/**
  The dB window mapped onto 0..255 by getByteFrequencyData
*/
const MIN_DB = -78;
const MAX_DB = -12;

/**
  Band edges in Hz, chosen against the kit rather than against round numbers.
 
    bass  35–170     the two kicks, sub_drop, and the body of the low tom
    mid   170–2200   snare body, toms, rim, cowbell, clap
    high  2200–12000 hats, ride, crash, click
*/
const BANDS = {
  bass: [35, 170],
  mid: [170, 2200],
  high: [2200, 12000],
};

/**
  Per-band gain
*/
const BAND_GAIN = { bass: 1.0, mid: 1.5, high: 2.1 };

/**
 * Noise threshold
 */
const GATE = 0.06;

// ------------------
// Envelope following
// ------------------

/**
  Asymmetric first-order follower: fast up, slow down.
*/
function follow(current, target, dt, attack, release) {
  const k = target > current ? attack : release;
  return current + (target - current) * (1 - Math.exp(-dt * k));
}

/** Attack and release rates per band, in reciprocal seconds. */
const ENVELOPE = {
  bass: { attack: 26, release: 4.5 },
  mid: { attack: 30, release: 6.0 },
  high: { attack: 60, release: 13.0 },
};

// ------------
// Light budget
// ------------

const PEAK = {
  wash: 16.0,
  accent: 15.0,
  sparkle: 24.0,
};

const BEAM_SATURATION = 0.88;
const BEAM_LIGHTNESS = 0.55;
const HUE_RATE = 0.036;
const HUE_PUSH = 0.075;

/**
  A floor under every fixture, so the rig is lit before a note is played.
*/
const IDLE = 0.18;

// ----------
// The stacks
// ----------

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

/** Lamps in a driver ring */
const RING_LAMPS = 16;
const RING_LAMPS_SMALL = 12;


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
    The cabinets get their own sub-group, separate from the emitters.
  */
  const stacks = new THREE.Group();
  stacks.name = 'speaker-stacks';
  group.add(stacks);

  // -----------------------------
  // Shared geometry and materials
  // -----------------------------

  function alongZ(geo, length) {
    geo.translate(0, -length / 2, 0);
    geo.rotateX(-Math.PI / 2);
    return geo;
  }

  const GEO = {
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
    Pale plastic, not metal.
  */
  const poleMat = new THREE.MeshStandardMaterial({
    color: PALETTE.mech,
    metalness: 0.0,
    roughness: 0.62,
  });

  /**
    Painted plywood
  */
  const cabMat = new THREE.MeshStandardMaterial({
    color: PALETTE.cab,
    metalness: 0.0,
    roughness: 0.85,
  });

  /**
    The baffle: the darkest material in the project
  */

  const grilleMat = new THREE.MeshStandardMaterial({
    color: PALETTE.grille,
    metalness: 0.0,
    roughness: 0.95,
  });

  /**
    The standby LED
  */
  const standbyMat = new THREE.MeshBasicMaterial({ color: PALETTE.standby });

  /**
    The LED material: one instance, shared by every lamp on a tower.
  */
  const ledMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });

  function part(geometry, material, position, parent = null, receive = true) {
    const mesh = new THREE.Mesh(geometry, material);
    if (position) mesh.position.set(...position);
    mesh.castShadow = false;
    mesh.receiveShadow = receive;
    (parent ?? group).add(mesh);
    return mesh;
  }

  // --------
  // Emitters
  // --------

  /**
    @type {Array<{
      light: THREE.SpotLight, peak: number, range: number,
      volumetric: boolean, position: THREE.Vector3, direction: THREE.Vector3
    }>}
  */
  const fixtures = [];

  /**
    One emitter: a spot at `position` aimed at `aim`.
  */
  function emitter({ hue, position, aim, angle, penumbra, peak, range = 6, volumetric = false }) {
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
      hue,
      position: light.position,
      direction: new THREE.Vector3(...aim).sub(light.position).normalize(),
    };

    fixtures.push(entry);
    return entry;
  }

  // ------------------
  // The speaker stacks
  // ------------------

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

    // branch one: the cabinets, toed in
    const stack = new THREE.Group();
    stack.rotation.y = -side * TOWER.toe;
    root.add(stack);

    const woofers = [];

    CABS.forEach((cab, i) => {
      part(CAB_GEO[i], cabMat, [0, cab.y, 0], stack);
      if (cab.tier === 'plinth') return;

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
      rgb lighting
    */
    const ledSlots = [];
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const scaleOne = new THREE.Vector3(1, 1, 1);
    const position = new THREE.Vector3();
    const axisZ = new THREE.Vector3(0, 0, 1);

    const sub = CABS[1];
    const subFaceZ = sub.d / 2 + 0.004;

    // the two edge strips
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

    // a ring around each driver
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

    const patch = makeContactShadow(0.34, 0.62);
    patch.position.set(side * TOWER.x, 0.0012, TOWER.z);
    patch.userData.kind = 'tower';
    towerShadows.push(patch);
    group.add(patch);

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

  // -----------------
  // THE OVERHEAD RING
  // -----------------

  const DEG = Math.PI / 180;

  const RING = {
    /**
      Horizontal distance from the centre of the room to every apex.
    */
    radius: 2.55,

    /**
      Apex height, shared by all five ring fixtures.
    */
    height: 3.60,

    /**
      The height the beams converge at, and how far past the centre each one
      aims.
    */
    focusY: 0.34,
    cross: 0.30,
  };

  /**
    Bearings, in the same convention the camera uses: measured about +Y from
    +Z (the front, where the player stands) towards +X (stage right).
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
    A fixture's place in the colour wheel, taken from where it stands.
  */
  function hueAt(bearing) {
    return ((bearing / (Math.PI * 2)) % 1 + 1) % 1;
  }

  /**
    MID — a pair of shafts from the rear quarters, raking forward.
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
    MID — the third of the trio, dead behind.
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
    BASS — the front pair, wider and softer.
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
    HIGH — one tight shaft straight down the middle.
  */
  const sparkle = emitter({
    position: [0.08, RING.height + 0.55, 0.22],
    aim: [0, 0.06, 0],
    hue: 0.0,
    angle: 0.17,
    penumbra: 0.55,
    peak: PEAK.sparkle,
    range: 5.0,
    volumetric: true,
  });

  /**
    BASS — two low washes, grazing across the floor, with no shaft.
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
    A hemisphere term that lifts with the whole mix.
  */
  const ambient = new THREE.HemisphereLight(PALETTE.skyTop, PALETTE.ground, 0.0);
  group.add(ambient);

  // --------
  // Analyser
  // --------

  /** @type {AnalyserNode | null} */
  let analyser = null;
  /** @type {Uint8Array | null} */
  let spectrum = null;

  /** Band name -> [firstBin, lastBin], computed once the sample rate is known. */
  let binRanges = null;

  /**
    Connect the analyser to the end of the signal chain.
    @param {AudioNode} source
    @param {AudioContext} ctx
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
      Bin index for a frequency: `f * fftSize / sampleRate`.
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

  // ---------
  // Per-frame
  // ---------

  /** Smoothed 0..1 energy per band. Read by anything that wants a meter. */
  const level = { bass: 0, mid: 0, high: 0 };

  let hueClock = 0.12;

  /** Seconds since the rig was built, for the yoke sweep. */
  let elapsed = 0;

  /**
    Mean of the byte values across a band, normalised to 0..1 and gated
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
    Push one scalar into an emitter.
  */
  function setFixture(entry, intensity) {
    entry.light.intensity = intensity;
    entry.level = Math.min(1, Math.max(0, (intensity - IDLE) / entry.peak));
  }

  /**
    The shaft descriptors handed to volumetrics.js each frame.
  */
  const beamDescriptors = fixtures
    .filter((f) => f.volumetric)
    .map((f) => ({
      source: f,
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

      source.light.updateWorldMatrix(true, false);
      source.light.getWorldPosition(beam.position);

      const phase = i * 1.7;
      const yaw = Math.sin(t * 0.27 + phase) * 0.055 + level.mid * 0.04 * (i % 2 ? 1 : -1);
      const pitch = Math.sin(t * 0.19 + phase) * 0.030 - level.mid * 0.035;

      // Refreshed from the scene graph rather than assumed.
      source.light.getWorldPosition(beam.position);

      driftAxis.copy(source.direction);
      driftAxis.applyAxisAngle(UP, yaw);
      driftAxis.applyAxisAngle(RIGHT, pitch);

      beam.direction.copy(driftAxis).normalize();

      source.light.target.position
        .copy(source.position)
        .addScaledVector(beam.direction, 2.0);

      const level01 = source.level ?? 0;
      beam.intensity = 0.10 + 0.90 * Math.pow(level01, 0.8);
    }
  }

  /**
    The cabinets, driven by the bands.
  */
  function updateCabinets() {

    const excursion = level.bass * 0.026;
    const recoil = level.bass * 0.009;
    const squash = level.bass * 0.045;

    const programme = Math.min(1, level.bass * 0.62 + level.mid * 0.48 + level.high * 0.30);

    for (const tower of towers) {
      for (const cone of tower.woofers) cone.position.z = cone.userData.z0 + excursion;

      tower.stack.position.y = tower.stackY0 - recoil;
      tower.stack.scale.set(1 + squash * 0.35, 1 - squash, 1 + squash * 0.35);

      updateLeds(tower, programme);
    }
  }

  /**
    The RGB lamps
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

        const lit = THREE.MathUtils.smoothstep(programme, slot.along - 0.10, slot.along + 0.02);
        const value = 0.06 + lit * 0.94;
        ledColour.setHSL(hue, 0.85, 0.5 * value + 0.04);
      } else {
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

    // the gradient
    const programme = Math.min(1, level.bass * 0.6 + level.mid * 0.5 + level.high * 0.4);
    hueClock = (hueClock + dt * (HUE_RATE + programme * HUE_PUSH)) % 1;

    for (const fixture of fixtures) {
      fixture.light.color.setHSL(
        (hueClock + fixture.hue) % 1,
        BEAM_SATURATION,
        BEAM_LIGHTNESS
      );
    }

    // bass -> the floor washes and the two wide shafts
    setFixture(wash[0], IDLE + level.bass * PEAK.wash);
    setFixture(wash[1], IDLE + level.bass * PEAK.wash);

    const bassLevel = IDLE + level.bass * PEAK.accent * 0.8;
    setFixture(bassBeams[0], bassLevel);
    setFixture(bassBeams[1], bassLevel);

    // mid -> the three accent shafts
    const accentLevel = IDLE + level.mid * PEAK.accent;
    setFixture(accentLeft, accentLevel);
    setFixture(accentRight, accentLevel);
    setFixture(accentBack, IDLE + level.mid * PEAK.accent * 0.9);

    // high -> sparkle
    setFixture(sparkle, IDLE + Math.pow(level.high, 1.4) * PEAK.sparkle);

    // the shafts, once every fixture holds this frame's level
    updateBeams(elapsed);

    // overall lift
    ambient.intensity = 0.05 + (level.bass + level.mid + level.high) * 0.06;

    // the cabinets
    updateCabinets();

    bus.emit('audio:bands', level);
  }

  /**
    Toggle the reactive rig as a unit.
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
    beams: beamDescriptors,
    towerShadows,
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