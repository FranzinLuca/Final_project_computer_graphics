/**
 * quality.js — adaptive resolution, measured and stepped at runtime.
 *
 * The phase 9 plan says "framerate check on a weaker machine". Checking once,
 * by hand, on one machine answers a question nobody asked: the project is
 * deployed to GitHub Pages and will be opened on hardware nobody has seen,
 * including — at the oral — a machine that matters and cannot be tested first.
 *
 * So the scene measures itself and steps its own cost down when it has to.
 *
 *
 * WHY PIXEL RATIO IS THE FIRST LEVER, AND BY A LONG WAY
 *
 * This scene is fragment-bound, not vertex-bound. Around 125 meshes is nothing
 * — a mid-range GPU eats that without noticing — but every one of those
 * fragments runs a MeshStandardMaterial with four lights, three map lookups, a
 * prefiltered environment sample and a shadow comparison. The frame's cost is
 * very close to linear in the number of fragments shaded, and the number of
 * fragments is the pixel count, which goes as the SQUARE of the device pixel
 * ratio.
 *
 * Dropping from 2.0 to 1.5 therefore removes 44% of the work. Nothing else
 * available here is remotely competitive: halving the shadow map saves one
 * depth-only pass at a quarter resolution, and turning off the beam cones saves
 * three transparent draws. Both are worth having, and both are worth less than
 * the first step of the pixel ratio ladder.
 *
 * It is also the least visible loss, because almost every edge in the scene is
 * a filleted curve under smooth shading rather than a hard line — the geometry
 * that geometry.js goes to such trouble to produce is exactly the geometry that
 * survives being rendered at three-quarter resolution.
 *
 *
 * WHY HYSTERESIS IS NOT OPTIONAL
 *
 * The naive controller uses one threshold: below 60 fps, step down; above it,
 * step up. It oscillates, always, and it is worth understanding that this is
 * not a tuning problem but a structural one.
 *
 * Stepping down is what RAISES the framerate. So the moment the controller
 * fixes the problem, the condition that triggered the fix stops holding, and it
 * steps back up — into exactly the state that was too slow. The system does not
 * settle; it finds the boundary and sits on it, flipping. And every flip is a
 * visible resolution change and a shadow map reallocation, so the cure is far
 * more distracting than the original stutter.
 *
 * Two things fix it. First, separate thresholds with a dead band between them
 * (step down under 50 fps, step up only over 74) so there is a range where the
 * controller does nothing at all. Second, an asymmetric cooldown: three seconds
 * before another step down, but eight before any step up, because the cost of
 * being one tier too low is invisible and the cost of thrashing is not.
 *
 * A dead band alone is NOT ENOUGH, and simulating the controller is what showed
 * it. The band spans a cost ratio of 20/13.5, about 1.48. The gap between two
 * pixel-ratio tiers is the ratio of their squares — 1.5 to 1.0 is 2.25. So on a
 * machine that runs at 25 ms on one tier and 11 ms on the next, NEITHER tier
 * lands inside the band: the first is too slow and steps down, the second is
 * fast enough to step back up, and the controller flips forever no matter how
 * wide the band is made. Simulated against exactly that machine, the
 * band-and-cooldown version changed tier five times in twenty seconds.
 *
 * So the third mechanism is a retry backoff. A tier that has already failed is
 * not tried again until a delay has passed, and every failure doubles that
 * delay. Convergence is then guaranteed rather than hoped for: even in the
 * pathological case where no tier fits the band, the oscillation period
 * doubles each time and the scene is effectively settled within seconds. It is
 * the same escalating-backoff shape a network client uses on a failing
 * endpoint, and for the same reason — retrying something that just failed, at
 * the same rate, is never the right policy.
 */

/**
 * The ladder, most expensive first.
 *
 * `pixelRatio` is a CAP, not a value — it is always min'd with the device's own
 * ratio, because rendering above native resolution buys nothing on any display
 * and costs the square of the difference.
 */
const TIERS = [
  { name: 'High',    pixelRatio: 2.00, shadowMap: 2048, beams: true,  dust: true,  shadows: true },
  { name: 'High -',  pixelRatio: 1.75, shadowMap: 2048, beams: true,  dust: true,  shadows: true },
  { name: 'Medium',  pixelRatio: 1.50, shadowMap: 1024, beams: true,  dust: true,  shadows: true },
  { name: 'Medium -', pixelRatio: 1.25, shadowMap: 1024, beams: true, dust: true,  shadows: true },
  { name: 'Low',     pixelRatio: 1.00, shadowMap: 1024, beams: true,  dust: true,  shadows: true },
  /**
   * Beams go before dust, which is the opposite of what their relative
   * subtlety suggests and the right way round for what they cost. A beam cone
   * covers a large, near-fullscreen-adjacent area of blended fragments; the
   * whole dust field is 260 sprites of eleven millimetres, which even at close
   * range is a small fraction of that area. Cutting the expensive effect first
   * is what lets the distinctive one survive a tier longer.
   */
  { name: 'Low -',   pixelRatio: 1.00, shadowMap: 512,  beams: false, dust: true,  shadows: true },
  { name: 'Minimum', pixelRatio: 0.75, shadowMap: 512,  beams: false, dust: false, shadows: false },
];

/** Frames to ignore at startup. */
const WARMUP_FRAMES = 90;

/** Frame times kept for the running estimate. */
const WINDOW = 90;

/** Milliseconds. 50 fps and 74 fps — note the gap between them. */
const STEP_DOWN_ABOVE_MS = 20.0;
const STEP_UP_BELOW_MS = 13.5;

const COOLDOWN_DOWN = 3.0;  // seconds
const COOLDOWN_UP = 8.0;

/**
 * @param {{
 *   renderer: import('three').WebGLRenderer,
 *   shadowLight?: import('three').Light,
 *   onTierChange?: (tier: object, index: number) => void,
 * }} deps
 */
export function initQuality({ renderer, shadowLight = null, onTierChange = null }) {
  const deviceRatio = window.devicePixelRatio || 1;

  const times = new Float32Array(WINDOW);
  let filled = 0;
  let cursor = 0;
  let warmup = WARMUP_FRAMES;
  let cooldown = 0;

  let index = 0;
  let auto = true;
  let elapsed = 0;

  /**
   * Per-tier retry gate. `retryAfter[k]` is the earliest time the controller
   * may step back up INTO tier k, and `retryDelay[k]` is how long the next
   * failure will push that out by. Doubling on each failure is what turns a
   * possible infinite oscillation into a few flips that decay away.
   */
  const retryAfter = new Float32Array(TIERS.length);
  const retryDelay = new Float32Array(TIERS.length).fill(COOLDOWN_UP);

  /** Scratch array for the percentile, allocated once. */
  const sorted = new Float32Array(WINDOW);

  function apply(next) {
    const tier = TIERS[next];
    index = next;

    // Never above native. A retina display reporting 3.0 is still capped at the
    // tier's own ceiling, and a 1x display is never asked to render at 2x.
    renderer.setPixelRatio(Math.min(deviceRatio, tier.pixelRatio));

    // setPixelRatio alone does not resize the drawing buffer — the renderer
    // needs to be told the CSS size again so it can recompute it. `false` keeps
    // it from writing inline styles onto the canvas element.
    const canvas = renderer.domElement;
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

    renderer.shadowMap.enabled = tier.shadows;

    if (shadowLight && shadowLight.shadow) {
      const shadow = shadowLight.shadow;
      if (shadow.mapSize.width !== tier.shadowMap) {
        shadow.mapSize.set(tier.shadowMap, tier.shadowMap);
        /**
         * The existing render target has to be disposed and nulled, or three
         * keeps using it at the old size and the change silently does nothing.
         * `mapSize` is only read when the target is created. Forgetting this
         * makes the shadow lever look useless and is very hard to spot, because
         * everything still renders correctly — just at the old cost.
         */
        if (shadow.map) {
          shadow.map.dispose();
          shadow.map = null;
        }
      }
    }

    onTierChange?.(tier, next);
  }

  /**
   * The 75th percentile of the window, not the mean.
   *
   * A mean is dragged around by single catastrophic frames — a garbage
   * collection, a shader compile, the compositor stalling — none of which say
   * anything about whether the scene is too expensive. A percentile ignores
   * them by construction. The 75th rather than the median because the goal is
   * that most frames are comfortable, not that half of them are.
   */
  function percentile75() {
    const n = filled;
    sorted.set(times.subarray(0, n));
    const view = sorted.subarray(0, n);
    view.sort();
    return view[Math.min(n - 1, Math.floor(n * 0.75))];
  }

  /**
   * @param {number} dt seconds since the last frame, from the same clock the
   *                    rest of the loop uses
   */
  function update(dt) {
    const ms = dt * 1000;
    elapsed += dt;

    // Startup is not representative. The first frames pay for shader
    // compilation, texture upload and PMREM generation, and a controller that
    // watched them would drop straight to Minimum on a machine that is
    // perfectly capable of High.
    if (warmup > 0) {
      warmup -= 1;
      return;
    }

    times[cursor] = ms;
    cursor = (cursor + 1) % WINDOW;
    filled = Math.min(filled + 1, WINDOW);

    if (cooldown > 0) cooldown -= dt;
    if (!auto || filled < WINDOW || cooldown > 0) return;

    const p75 = percentile75();

    if (p75 > STEP_DOWN_ABOVE_MS && index < TIERS.length - 1) {
      // This tier just failed. Bar it for a while, and bar it for twice as long
      // next time.
      retryAfter[index] = elapsed + retryDelay[index];
      retryDelay[index] = Math.min(retryDelay[index] * 2, 240);

      apply(index + 1);
      cooldown = COOLDOWN_DOWN;
      // The window is cleared after every change, because the frames in it were
      // measured at a cost that no longer exists. Leaving them would let the
      // old, slow measurements trigger a second step down immediately.
      filled = 0;
      cursor = 0;
    } else if (
      p75 < STEP_UP_BELOW_MS &&
      index > 0 &&
      elapsed >= retryAfter[index - 1]
    ) {
      apply(index - 1);
      cooldown = COOLDOWN_UP;
      filled = 0;
      cursor = 0;
    }
  }

  /** Pin to a tier and stop adapting. For the GUI, and for the oral. */
  function setTier(next) {
    auto = false;
    apply(Math.min(TIERS.length - 1, Math.max(0, next)));
  }

  function setAuto(on) {
    auto = on;
    if (on) {
      filled = 0;
      cursor = 0;
      cooldown = COOLDOWN_DOWN;
    }
  }

  apply(0);

  return {
    update,
    setTier,
    setAuto,
    TIERS,
    tierName: () => TIERS[index].name,
    tierIndex: () => index,
    isAuto: () => auto,
    frameMs: () => (filled === WINDOW ? percentile75() : 0),
  };
}