
/**
  quality.js — adaptive resolution, measured and stepped at runtime.
*/
const TIERS = [
  { name: 'High',     pixelRatio: 2.00, shadowMap: 2048, steps: 28, shadows: true },
  { name: 'High -',   pixelRatio: 1.75, shadowMap: 2048, steps: 24, shadows: true },
  { name: 'Medium',   pixelRatio: 1.50, shadowMap: 1024, steps: 20, shadows: true },
  { name: 'Medium -', pixelRatio: 1.25, shadowMap: 1024, steps: 16, shadows: true },
  { name: 'Low',      pixelRatio: 1.00, shadowMap: 1024, steps: 12, shadows: true },
  { name: 'Low -',    pixelRatio: 1.00, shadowMap: 512,  steps: 8,  shadows: true },
  { name: 'Minimum',  pixelRatio: 0.75, shadowMap: 512,  steps: 8,  shadows: false },
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
  @param {{
    renderer: import('three').WebGLRenderer,
    shadowLight?: import('three').Light,
    onTierChange?: (tier: object, index: number) => void,
  }} deps
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
    Per-tier retry gate. 
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

    // setPixelRatio alone does not resize the drawing buffer the renderer
    // needs to be told the CSS size again so it can recompute it. `false` keeps
    // it from writing inline styles onto the canvas element.
    const canvas = renderer.domElement;
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

    renderer.shadowMap.enabled = tier.shadows;

    if (shadowLight && shadowLight.shadow) {
      const shadow = shadowLight.shadow;
      if (shadow.mapSize.width !== tier.shadowMap) {
        shadow.mapSize.set(tier.shadowMap, tier.shadowMap);
        if (shadow.map) {
          shadow.map.dispose();
          shadow.map = null;
        }
      }
    }

    onTierChange?.(tier, next);
  }

  /**
    The 75th percentile of the window, not the mean
  */
  function percentile75() {
    const n = filled;
    sorted.set(times.subarray(0, n));
    const view = sorted.subarray(0, n);
    view.sort();
    return view[Math.min(n - 1, Math.floor(n * 0.75))];
  }

  /**
    @param {number} dt seconds since the last frame, from the same clock the
                       rest of the loop uses
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
      // This tier just failed
      retryAfter[index] = elapsed + retryDelay[index];
      retryDelay[index] = Math.min(retryDelay[index] * 2, 240);

      apply(index + 1);
      cooldown = COOLDOWN_DOWN;
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

  /** Pin to a tier and stop adapting */
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