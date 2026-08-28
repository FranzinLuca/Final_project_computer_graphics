/**
 * intro.js — the power-on sequence.
 *
 * Otto drives in from off-camera with the camera following him, throws the
 * handle on a floor console, and the stage drops in from above: the speaker
 * stacks first, then the instrument, each landing with a bounce and a puff of
 * dust. The camera pulls back to frame it, and the slab stays SHUT — opening
 * it is the first thing the user does.
 *
 *
 * WHY THE SEQUENCE EXISTS
 *
 * Not decoration, and the case for it is not that it looks nice.
 *
 * FIRST, it is a fourth hierarchical model with structure-driven animation,
 * and a causal one: `base → console → pivot → handle`, where rotating the
 * pivot swings the handle as a child and that rotation is what triggers
 * everything else. When the yoke chain went with the light fixtures the
 * project lost a worked example; this replaces it with a better one, because
 * the mechanism here does something rather than merely moving.
 *
 * SECOND, it establishes the objects in order. A scene that simply exists when
 * the page loads is a scene the viewer has to parse. One that assembles itself
 * names its parts as they arrive — the character, then what the character
 * does, then the speakers, then the instrument — so by the time anything is
 * interactive the viewer already knows what everything is.
 *
 * THIRD, it ends on a question. The slab lands closed and the screen asks for
 * a click, so the first thing that happens is something the USER did.
 *
 *
 * HOW IT IS SEQUENCED
 *
 * A table of absolute times, exactly like the fold sequence in hierarchy.js,
 * and deliberately not tween.js's `chain()`. Chaining expresses "after", and
 * almost every relationship here is "at": the stacks start falling while
 * Otto's arm is still coming down, and he backs away while the instrument is
 * still in the air. A machine that waits politely for its operator reads as a
 * slideshow.
 *
 * Every cue is one line and retiming is one number.
 */

import * as THREE from 'three';
import { Tween, Easing } from '@tweenjs/tween.js';
import { tweens } from './tweens.js';
import { bus } from './events.js';
import { PALETTE } from './palette.js';
import { roundedBoxGeometry, roundedCylinderGeometry } from './geometry.js';
import { makeContactShadow, ROOM } from './environment.js';
import { radialFalloffTexture } from './textures.js';

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

/**
 * How far ABOVE their resting height the two groups wait.
 *
 * Dropping rather than rising, which reverses the earlier decision and is
 * worth saying why. Rising from under the floor was free — the floor is opaque
 * and the camera is clamped above the horizon, so depth testing hid everything
 * with no clipping plane to maintain. Dropping needs the objects to start
 * outside the frame instead, which is a framing constraint rather than a
 * geometric one: 2.2 units up is above the top of frame on every authored shot
 * and still below the cyclorama's rim at 2.4, so nothing is ever seen hanging
 * in the air before it is released.
 *
 * The gain is worth the constraint. A rig that rises has no impact — it
 * arrives at zero velocity by definition. A rig that falls lands, and landing
 * is what lets it bounce, throw dust, and read as having weight.
 */
const RIG_DROP = 2.20;
const TOWER_DROP = 2.40;

/**
 * The furthest from the centre anything on the ground may stand.
 *
 * When there were walls this stopped the mascot spawning INSIDE the
 * cyclorama's floor sweep, which he did, at radius 3.59 where the geometry
 * stands 0.66 units above y = 0. The walls are gone and nothing can be walked
 * into any more, so the clamp changed meaning rather than becoming redundant:
 * it now keeps him inside the composed stage instead of arriving out of the
 * fog like a ferry.
 *
 * Derived from ROOM rather than typed, so the room can be resized without
 * quietly putting the character back inside the wall. The margin is his own
 * footprint: the tracks are 210 mm deep, so his centre has to stay a little
 * over half of that inside the flat region, and 0.35 leaves room for the
 * fillet's first few centimetres to be genuinely flat rather than nominally.
 */
const FLOOR_LIMIT = ROOM.stageR - 0.15;

/**
 * Otto's entry: behind and to the right, on flat ground.
 *
 * Radius 2.86, which `clampToFloor` below would enforce anyway — the constant
 * is written as an already-legal value so that reading it does not require
 * knowing about the clamp, and the clamp exists so that a later edit cannot
 * reintroduce the bug.
 *
 * Behind rather than beside, because the drive is longer that way: 2.6 units
 * of travel against the 1.0 a side entry would give, which is the difference
 * between an arrival and a nudge.
 */
const ENTRY = { x: 2.30, z: -1.70 };

/**
 * Project a ground position back inside the flat floor if it is outside it.
 *
 * Scaling towards the centre rather than clamping x and z independently: a
 * per-axis clamp squares off the region and would still leave the corners
 * outside the disc, which is the same mistake as clamping a normalised vector
 * component-wise.
 */
function clampToFloor(x, z) {
  const r = Math.hypot(x, z);
  if (r <= FLOOR_LIMIT) return { x, z };
  const k = FLOOR_LIMIT / r;
  return { x: x * k, z: z * k };
}

/** Where the console stands, and where he pulls up beside it. */
const CONSOLE = { x: 1.66, z: 0.52 };

/** Absolute times in milliseconds from the start. */
const CUE = {
  driveIn: 0,
  driveDuration: 2300,
  reach: 1950,
  throwHandle: 2200,
  pullBack: 2300,
  pullBackDuration: 1500,
  towers: 2600,
  towerFall: 1000,
  rig: 3050,
  rigFall: 950,
  settle: 3100,
  settleDuration: 1300,
  done: 4500,
};

// ---------------------------------------------------------------------------

/**
 * @param {{
 *   scene: THREE.Scene, rigRoot: THREE.Object3D, stacksGroup: THREE.Object3D,
 *   mascot: any, hierarchy: any, cameraRig: any,
 *   mascotHome: THREE.Vector3, contactShadows?: THREE.Object3D[],
 * }} deps
 */
export function initIntro(deps) {
  /**
   * Dependency validation, and the reason it is worth six lines.
   *
   * This module takes seven injected objects and touches all of them during
   * construction. When one is missing — because a sibling module was edited to
   * expose it under a new name and one of the two files was not redeployed —
   * the failure surfaces as `Cannot read properties of undefined (reading
   * 'position')` from a line that has nothing to do with the mistake. That
   * error names the property, never the dependency, and never the module that
   * was supposed to supply it.
   *
   * Checking at the door turns a five-minute hunt into a sentence. Every
   * module in this project is wired by main.js precisely so that dependencies
   * are explicit; a missing one should say so out loud.
   */
  const REQUIRED = ['scene', 'rigRoot', 'stacksGroup', 'mascot', 'hierarchy', 'cameraRig', 'mascotHome'];
  const missing = REQUIRED.filter((key) => !deps?.[key]);
  if (missing.length) {
    throw new Error(
      `[intro] missing dependencies: ${missing.join(', ')}. ` +
      `main.js passes 'stacksGroup: lighting.stacks' — if that one is missing, ` +
      `lighting.js predates the split of the cabinets out of the light rig.`
    );
  }

  const {
    scene, rigRoot, stacksGroup, mascot, hierarchy, cameraRig,
    mascotHome, contactShadows = [],
  } = deps;

  // =======================================================================
  // The console
  //
  // Replacing a stick on a post, which is what the first version was: a
  // cylinder, a thinner cylinder and a cube. It read as placeholder geometry
  // because that is what it was, and next to a filleted instrument and a
  // machined speaker stack it was the one object in the scene that had not
  // been designed.
  //
  // What makes this read as equipment instead is three things, none of which
  // is polygon count:
  //
  //   A RAKED PANEL. Nothing operated by a standing person has a horizontal
  //   control face; it is tilted towards the operator so the controls are
  //   perpendicular to the line of sight. That single angle is most of what
  //   separates "a machine" from "a box with things on it".
  //
  //   MATERIAL BREAKS. A painted housing, a machined bezel around the panel,
  //   a black insert the handle slots through, and one unlit red grip. Four
  //   materials on a 260 mm object is what tells the eye it was assembled from
  //   parts rather than extruded.
  //
  //   A SLOT THE HANDLE TRAVELS IN. The handle passes through a visible gate,
  //   so its motion has somewhere to go and somewhere to stop. A lever with no
  //   slot is a stick that happens to rotate.
  // =======================================================================

  const consoleRoot = new THREE.Group();
  consoleRoot.position.set(CONSOLE.x, 0, CONSOLE.z);
  // Turned to face the point Otto stops at, so the panel is raked towards him
  // and the throw is broadside to the default camera.
  consoleRoot.rotation.y = -0.62;
  scene.add(consoleRoot);

  const housingMat = new THREE.MeshStandardMaterial({
    color: PALETTE.cab, metalness: 0.05, roughness: 0.72,
  });
  const bezelMat = new THREE.MeshStandardMaterial({
    color: PALETTE.bezel, metalness: 0.85, roughness: 0.40,
  });
  const insetMat = new THREE.MeshStandardMaterial({
    color: PALETTE.grille, metalness: 0.0, roughness: 0.9,
  });
  const shaftMat = new THREE.MeshStandardMaterial({
    color: PALETTE.mech, metalness: 0.75, roughness: 0.28,
  });

  /**
   * The grip and the two indicator lamps are unlit `MeshBasicMaterial`.
   *
   * The whole shot depends on the viewer reading "he is reaching for THAT",
   * and a lit surface on the far side of a dark stage cannot be relied on to
   * be bright at the moment it matters. An unlit red is the same red at every
   * angle and under every light state.
   */
  const gripMat = new THREE.MeshBasicMaterial({ color: 0xff5245 });
  const lampOff = new THREE.MeshBasicMaterial({ color: 0x2a1a1a });
  const lampOn = new THREE.MeshBasicMaterial({ color: 0x5fe6a8 });

  function part(geometry, material, x, y, z, parent) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    (parent ?? consoleRoot).add(mesh);
    return mesh;
  }

  // Plinth and body. The body is a touch narrower than the plinth so a shadow
  // line runs round the base — the same shadow-gap trick the instrument's
  // bezel caps use.
  part(roundedBoxGeometry(0.280, 0.036, 0.240, 0.012, 3), bezelMat, 0, 0.018, 0);
  part(roundedBoxGeometry(0.250, 0.240, 0.210, 0.020, 3), housingMat, 0, 0.156, 0);

  // Four feet, visible under the plinth's overhang.
  for (const fx of [-1, 1]) {
    for (const fz of [-1, 1]) {
      part(roundedCylinderGeometry(0.016, 0.014, 0.005, 12, 2), insetMat,
        fx * 0.105, 0, fz * 0.085);
    }
  }

  /**
   * The raked control panel: a thin slab pitched back 22 degrees, sitting in a
   * machined bezel one size larger. Two meshes rather than one, because the
   * step between them is the only thing that makes the panel look inset.
   */
  const panel = new THREE.Group();
  panel.position.set(0, 0.282, 0.010);
  panel.rotation.x = -THREE.MathUtils.degToRad(22);
  consoleRoot.add(panel);

  part(roundedBoxGeometry(0.230, 0.022, 0.190, 0.010, 3), bezelMat, 0, 0, 0, panel);
  part(roundedBoxGeometry(0.190, 0.016, 0.150, 0.007, 3), insetMat, 0, 0.010, 0, panel);

  // The gate the handle travels through: a raised collar with a slot in it,
  // built as two blocks either side of the gap rather than as a subtracted
  // shape, because there is no CSG and two blocks are the honest way to make a
  // gap between two things.
  for (const gx of [-1, 1]) {
    part(roundedBoxGeometry(0.060, 0.020, 0.120, 0.008, 3), bezelMat,
      gx * 0.052, 0.019, 0, panel);
  }

  const lamps = [-1, 1].map((lx) =>
    part(roundedCylinderGeometry(0.011, 0.008, 0.004, 14, 2), lampOff,
      lx * 0.062, 0.020, 0.056, panel)
  );

  /**
   * The pivot, and the rule every hinge in this project follows: an empty
   * Group placed exactly on the axis of rotation, with the moving parts offset
   * inside it. Three.js rotates about an object's own origin, so a handle mesh
   * rotated directly spins about its middle like a propeller.
   */
  const pivot = new THREE.Group();
  pivot.position.set(0, 0.014, 0);
  panel.add(pivot);

  // Boss, shaft, collar and ball grip. The boss is a cylinder lying across the
  // axis, which is what a real pivot looks like from the side and what makes
  // the axis legible as a physical part rather than an implied one.
  const boss = part(roundedCylinderGeometry(0.026, 0.070, 0.008, 20, 2), shaftMat, 0, 0, 0, pivot);
  boss.rotation.z = Math.PI / 2;
  boss.position.x = -0.035;

  part(roundedCylinderGeometry(0.013, 0.150, 0.006, 16, 2), shaftMat, 0, 0.010, 0, pivot);
  part(roundedCylinderGeometry(0.020, 0.020, 0.008, 16, 2), bezelMat, 0, 0.118, 0, pivot);
  // radius == half the smallest side, so the rounded box closes into a sphere:
  // one geometry generator, two shapes, no sphere primitive needed.
  part(roundedBoxGeometry(0.056, 0.056, 0.056, 0.028, 4), gripMat, 0, 0.168, 0, pivot);

  /** Thrown position and rest position, in the panel's own tilted frame. */
  const HANDLE_UP = -0.46;
  const HANDLE_DOWN = 0.62;
  pivot.rotation.x = HANDLE_UP;

  const consoleShadow = makeContactShadow(0.22, 0.58);
  consoleShadow.position.set(CONSOLE.x, 0.0012, CONSOLE.z);
  scene.add(consoleShadow);

  // =======================================================================
  // Dust
  //
  // One Points system for every impact, not one per landing. Three bursts
  // happen over two seconds and each is forty motes; allocating a buffer per
  // burst would mean three allocations and three draw calls for something that
  // is over before anybody looks at it directly.
  //
  // Instead there is a single pool. A burst claims the next slots, writes
  // their positions and velocities, and the update integrates the whole pool
  // whether or not it is in use — the dead motes are at zero opacity and cost
  // one multiply each.
  // =======================================================================

  const DUST_POOL = 180;
  const DUST_PER_BURST = 44;

  const dustPositions = new Float32Array(DUST_POOL * 3);
  const dustVelocities = new Float32Array(DUST_POOL * 3);
  const dustLife = new Float32Array(DUST_POOL);
  const dustSeed = new Float32Array(DUST_POOL);
  let dustCursor = 0;

  const dustGeometry = new THREE.BufferGeometry();
  dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
  // `opacity` per mote is carried as a colour, because PointsMaterial has one
  // opacity for the whole system and the motes have to fade independently.
  // Under additive blending a colour of zero contributes nothing, so colour IS
  // the fade.
  const dustColours = new Float32Array(DUST_POOL * 3);
  dustGeometry.setAttribute('color', new THREE.BufferAttribute(dustColours, 3));

  const dustMaterial = new THREE.PointsMaterial({
    size: 0.055,
    map: radialFalloffTexture(32, 1.6),
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
    fog: false,
    toneMapped: false,
  });

  const dust = new THREE.Points(dustGeometry, dustMaterial);
  dust.frustumCulled = false;
  dust.renderOrder = 3;
  scene.add(dust);

  /**
   * Throw a ring of dust outward from an impact.
   *
   * The velocities are mostly HORIZONTAL with a small upward component, which
   * is the opposite of the obvious choice and is what makes it read as an
   * impact rather than as smoke. A heavy object landing displaces the air
   * sideways; the cloud spreads along the floor and only then drifts up. A
   * burst that goes mostly upward reads as something burning.
   */
  function burst(x, z, radius, strength = 1) {
    for (let i = 0; i < DUST_PER_BURST; i++) {
      const index = dustCursor;
      dustCursor = (dustCursor + 1) % DUST_POOL;

      const theta = Math.random() * Math.PI * 2;
      const r = radius * (0.55 + Math.random() * 0.45);
      const j = index * 3;

      dustPositions[j] = x + Math.cos(theta) * r * 0.4;
      dustPositions[j + 1] = 0.012 + Math.random() * 0.03;
      dustPositions[j + 2] = z + Math.sin(theta) * r * 0.4;

      const speed = (0.35 + Math.random() * 0.55) * strength;
      dustVelocities[j] = Math.cos(theta) * speed;
      dustVelocities[j + 1] = (0.12 + Math.random() * 0.30) * strength;
      dustVelocities[j + 2] = Math.sin(theta) * speed;

      dustLife[index] = 1;
      dustSeed[index] = 0.55 + Math.random() * 0.45;
    }
  }

  function updateDust(dt) {
    let alive = false;

    for (let i = 0; i < DUST_POOL; i++) {
      if (dustLife[i] <= 0) continue;
      alive = true;

      const j = i * 3;

      dustPositions[j] += dustVelocities[j] * dt;
      dustPositions[j + 1] += dustVelocities[j + 1] * dt;
      dustPositions[j + 2] += dustVelocities[j + 2] * dt;

      /**
       * Drag, not gravity.
       *
       * Motes this small are dominated by air resistance — they do not
       * ballistically arc, they decelerate and hang. Applying gravity makes
       * the cloud rain back down, which is what sand does and not what dust
       * does. The tiny upward term that survives is buoyancy in warm air.
       */
      const drag = Math.exp(-dt * 2.6);
      dustVelocities[j] *= drag;
      dustVelocities[j + 1] = dustVelocities[j + 1] * drag + dt * 0.045;
      dustVelocities[j + 2] *= drag;

      dustLife[i] -= dt * 0.62;
      const fade = Math.max(0, dustLife[i]);
      // Squared, so the tail of the fade is long and the cloud dissolves
      // rather than switching off.
      const value = fade * fade * dustSeed[i] * 0.5;

      dustColours[j] = value * 0.95;
      dustColours[j + 1] = value * 0.92;
      dustColours[j + 2] = value * 0.86;
    }

    if (alive) {
      dustGeometry.attributes.position.needsUpdate = true;
      dustGeometry.attributes.color.needsUpdate = true;
    }
    dust.visible = alive;
  }

  // =======================================================================
  // Staging the actors
  // =======================================================================

  const rigHome = rigRoot.position.y;
  const stacksHome = stacksGroup.position.y;

  const shadowOpacities = contactShadows.map((s) => s.material.opacity);

  function stage() {
    rigRoot.position.y = rigHome + RIG_DROP;
    stacksGroup.position.y = stacksHome + TOWER_DROP;

    const entry = clampToFloor(ENTRY.x, ENTRY.z);
    mascot.root.position.set(entry.x, 0, entry.z);
    // Facing his direction of travel. Computed from the two endpoints rather
    // than typed, so moving either one keeps him pointing where he is going —
    // a character who drives sideways is the second most obvious way to make
    // an entrance look wrong, after driving through a wall.
    mascot.root.rotation.y = Math.atan2(
      CONSOLE.x - 0.40 - entry.x,
      CONSOLE.z + 0.20 - entry.z
    );
    pivot.rotation.x = HANDLE_UP;

    lamps.forEach((lamp) => { lamp.material = lampOff; });
    contactShadows.forEach((s) => { s.material.opacity = 0; });
    consoleShadow.material.opacity = 0;
    dust.visible = false;
    dustLife.fill(0);
  }

  // =======================================================================
  // The sequence
  // =======================================================================

  let timers = [];
  let running = false;
  let finished = false;

  function tween(target, to, duration, easing = Easing.Cubic.Out, delay = 0) {
    const t = new Tween(target).to(to, duration).easing(easing).delay(delay).start();
    tweens.add(t);
    return t;
  }

  function fadeShadow(mesh, to, duration, delay = 0) {
    tween(mesh.material, { opacity: to }, duration, Easing.Quadratic.Out, delay);
  }

  function opacityOf(mesh) {
    const index = contactShadows.indexOf(mesh);
    return index < 0 ? 0.5 : shadowOpacities[index];
  }

  function schedule() {
    const cues = [];
    const at = (ms, run) => cues.push({ ms, run });

    // --- Otto arrives, and the camera goes with him -----------------------
    at(CUE.driveIn, () => {
      /**
       * The camera FOLLOWS rather than being tweened to where he will be.
       *
       * A tween interpolates towards a fixed destination, so aiming one at a
       * moving robot frames where he was by the time it arrives. Holding the
       * orbit parameters and letting the target track him keeps him centred by
       * construction instead of by timing — and it survives the sequence being
       * retimed, which a hand-matched tween would not.
       */
      cameraRig.followObject(mascot.root, {
        radius: 1.55, phi: 1.24, theta: 0.86, ty: 0.22, ease: 2.6,
      });

      const stop = clampToFloor(CONSOLE.x - 0.40, CONSOLE.z + 0.20);
      tween(mascot.root.position, { x: stop.x, z: stop.z },
        CUE.driveDuration, Easing.Cubic.InOut);
      // Turning as he travels, so he arrives already facing the console rather
      // than arriving and then rotating, which reads as two separate moves.
      tween(mascot.root.rotation, { y: -0.95 }, CUE.driveDuration, Easing.Cubic.InOut);
      fadeShadow(consoleShadow, 0.58, 800, 700);
    });

    // --- he reaches ------------------------------------------------------
    at(CUE.reach, () => {
      mascot.look(0.26, -0.34);
      // Left arm, explicitly: he stands to the console's left, and letting the
      // alternating-hands rule choose would eventually reach across himself.
      mascot.strike(1.0, -1);
    });

    // --- the throw -------------------------------------------------------
    at(CUE.throwHandle, () => {
      /**
       * `Back.Out`, and this is the only place in the project that overshoots.
       *
       * The wing fold refuses overshoot because both ends of its travel are
       * hard mechanical stops, where an overshoot is interpenetration. A
       * handle has a stop too — but it is a sprung detent that a hand slams
       * into, so a small overshoot and settle is what the motion actually
       * does. Same question asked of two mechanisms, opposite answers, because
       * the mechanisms are different.
       */
      tween(pivot.rotation, { x: HANDLE_DOWN }, 380, Easing.Back.Out);
      lamps.forEach((lamp) => { lamp.material = lampOn; });
      bus.emit('intro:activate', {});
    });

    // --- camera pulls back to frame the stage ----------------------------
    at(CUE.pullBack, () => {
      cameraRig.moveTo(
        { radius: 2.05, phi: 1.06, theta: 0.66, target: [0.10, 0.42, 0] },
        CUE.pullBackDuration,
        'intro'
      );
    });

    // --- the stacks drop -------------------------------------------------
    at(CUE.towers, () => {
      /**
       * `Bounce.Out` on the fall.
       *
       * Every other easing in the project is monotonic, and this one is not,
       * for a reason that holds here and nowhere else: the constraint at the
       * end of THIS travel is the floor, which is a surface an object can
       * legitimately leave again. A wing overshooting its stop interpenetrates
       * the slab; a flight case overshooting the floor is called a bounce.
       */
      tween(stacksGroup.position, { y: stacksHome }, CUE.towerFall, Easing.Bounce.Out);
    });

    // Dust on contact, which is BEFORE the tween finishes. Bounce.Out first
    // reaches its destination at about 36% of its duration and spends the rest
    // of the time bouncing, so timing the puff to the tween's completion would
    // put it a full half-second after the impact anybody watched.
    at(CUE.towers + CUE.towerFall * 0.36, () => {
      for (const side of [-1, 1]) burst(side * 1.38, -0.12, 0.42, 1.15);
      contactShadows
        .filter((s) => s.userData.kind === 'tower')
        .forEach((s) => fadeShadow(s, opacityOf(s), 420));
    });

    // --- he backs off to his playing position ----------------------------
    at(CUE.settle, () => {
      tween(mascot.root.position, { x: mascotHome.x, z: mascotHome.z },
        CUE.settleDuration, Easing.Cubic.InOut);
      tween(mascot.root.rotation, { y: -0.62 }, CUE.settleDuration, Easing.Cubic.InOut);
      mascot.look(0, 0);
    });

    // --- the instrument drops --------------------------------------------
    at(CUE.rig, () => {
      tween(rigRoot.position, { y: rigHome }, CUE.rigFall, Easing.Bounce.Out);
    });

    at(CUE.rig + CUE.rigFall * 0.36, () => {
      burst(0, 0, 0.62, 1.0);
      contactShadows
        .filter((s) => s.userData.kind !== 'tower')
        .forEach((s) => fadeShadow(s, opacityOf(s), 420));
    });

    // --- and stops there, shut -------------------------------------------
    //
    // No unfold cue. The slab lands closed and the sequence hands over: the
    // first thing that opens it is a click, so the first thing that happens in
    // the scene is something the user did rather than something they watched.
    at(CUE.done, () => {
      finished = true;
      running = false;
      cameraRig.stopFollowing();
      bus.emit('intro:done', {});
    });

    return cues;
  }

  /**
   * Run it.
   *
   * `setTimeout` per cue rather than a clock polled in the render loop.
   * Everything a cue does is start a tween, and tweens are already advanced
   * from the loop against `performance.now()` — adding a second timeline to
   * poll would put two clocks in charge of one sequence. Timers decide when to
   * think; tween.js decides what moves. The same division audio.js makes
   * between its planner and the audio clock.
   */
  function start() {
    if (running || finished) return;
    running = true;

    stage();
    timers = schedule().map((cue) => setTimeout(cue.run, cue.ms));
    bus.emit('intro:start', {});
  }

  /**
   * Jump to the end.
   *
   * Values are written directly rather than the sequence being retimed to
   * something short: a fast version of a sequence is still a sequence, and
   * somebody skipping it wants it gone. The camera is handed back to the user
   * rather than moved anywhere, because a skip is a request for control.
   */
  function skip() {
    if (!running) return;

    for (const timer of timers) clearTimeout(timer);
    timers = [];

    rigRoot.position.y = rigHome;
    stacksGroup.position.y = stacksHome;
    mascot.root.position.set(mascotHome.x, 0, mascotHome.z);
    mascot.root.rotation.y = -0.62;
    pivot.rotation.x = HANDLE_DOWN;
    lamps.forEach((lamp) => { lamp.material = lampOn; });

    contactShadows.forEach((s, i) => { s.material.opacity = shadowOpacities[i]; });
    consoleShadow.material.opacity = 0.58;
    dustLife.fill(0);
    dust.visible = false;

    cameraRig.stopFollowing();
    cameraRig.goTo('Overview', 700);

    finished = true;
    running = false;
    bus.emit('intro:done', { skipped: true });
  }

  // Park everything before the first frame, so the scene is never rendered
  // fully assembled and then yanked into the air.
  stage();

  return {
    start,
    skip,
    update: updateDust,
    burst,
    console: consoleRoot,
    pivot,
    isRunning: () => running,
    isFinished: () => finished,
  };
}