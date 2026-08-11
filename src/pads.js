/**
 * pads.js — the pad bank: 16 drum voices, synthesised from scratch.
 *
 * No samples. Every sound here is oscillators and filtered noise, which means
 * nothing is imported and there are no licensing questions for the report.
 *
 * A "voice" is a function (ctx, dest, time, velocity) that builds a small node
 * graph, schedules it against the audio clock and returns its output gain node
 * so it can be choked. Nodes are created fresh per hit and never reused:
 * OscillatorNode and AudioBufferSourceNode are single-use by specification —
 * once stopped they cannot restart. Letting them be garbage collected is the
 * intended pattern, not a leak.
 *
 * This module imports nothing. It knows about the AudioContext it is handed
 * and nothing else — no transport, no geometry.
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** One noise buffer, reused by every noise-based voice. */
let noiseBuffer = null;

function getNoiseBuffer(ctx) {
  if (!noiseBuffer || noiseBuffer.sampleRate !== ctx.sampleRate) {
    // Three seconds — comfortably longer than the longest voice (the crash),
    // so a random read offset can never run past the end.
    const length = Math.floor(ctx.sampleRate * 3);
    noiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}

function noiseSource(ctx, time, duration) {
  const src = ctx.createBufferSource();
  src.buffer = getNoiseBuffer(ctx);
  // Random offset so repeated hits don't sound identical.
  src.loop = true;
  src.loopStart = 0;
  src.loopEnd = src.buffer.duration;
  const headroom = Math.max(0, src.buffer.duration - duration - 0.1);
  src.start(time, Math.random() * headroom);
  src.stop(time + duration + 0.02);
  return src;
}

/**
 * Percussive amplitude envelope: near-instant attack, exponential decay.
 *
 * Exponential rather than linear because perceived loudness is roughly
 * logarithmic — a linear fade sounds like it cuts out early. The floor is
 * 0.0001 (about -80 dB) rather than 0 because exponentialRampToValueAtTime
 * cannot target zero; exponential decay never reaches it and the API throws.
 */
function percEnv(param, time, peak, attack, decay) {
  const top = Math.max(peak, 0.0002);
  param.setValueAtTime(0.0001, time);
  param.exponentialRampToValueAtTime(top, time + attack);
  param.exponentialRampToValueAtTime(0.0001, time + attack + decay);
}

/** Pitch envelope: sweep a frequency param from `from` to `to`. */
function pitchEnv(param, time, from, to, duration) {
  param.setValueAtTime(from, time);
  param.exponentialRampToValueAtTime(Math.max(to, 0.01), time + duration);
}

// ---------------------------------------------------------------------------
// Voice constructors
//
// Each returns a voice function. Parameterising them this way means the four
// toms are one recipe with three sets of numbers, not three copies of a
// function — and retuning a family is one edit.
// ---------------------------------------------------------------------------

/** Sine with a fast downward pitch sweep: the whole of kick-drum synthesis. */
function makeKick({ from, to, sweep, decay, level = 1.0 }) {
  return (ctx, dest, time, velocity) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    pitchEnv(osc.frequency, time, from, to, sweep);

    const out = ctx.createGain();
    percEnv(out.gain, time, level * velocity, 0.004, decay);

    osc.connect(out).connect(dest);
    osc.start(time);
    osc.stop(time + decay + 0.1);
    return out;
  };
}

/** Noise through a bandpass, plus an optional tuned body tone. */
function makeSnare({ tone, noiseDecay, toneDecay, bandpass, q = 1.2, level = 1.0 }) {
  return (ctx, dest, time, velocity) => {
    const out = ctx.createGain();
    out.gain.value = level * velocity;
    out.connect(dest);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = bandpass;
    filter.Q.value = q;

    const noiseGain = ctx.createGain();
    percEnv(noiseGain.gain, time, 0.8, 0.002, noiseDecay);
    noiseSource(ctx, time, noiseDecay + 0.05).connect(filter);
    filter.connect(noiseGain).connect(out);

    if (tone) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      pitchEnv(osc.frequency, time, tone, tone * 0.7, toneDecay);

      const toneGain = ctx.createGain();
      percEnv(toneGain.gain, time, 0.5, 0.002, toneDecay);

      osc.connect(toneGain).connect(out);
      osc.start(time);
      osc.stop(time + toneDecay + 0.05);
    }

    return out;
  };
}

/**
 * Clap: several very short noise bursts a few milliseconds apart, then a
 * longer tail. The stagger is what makes it read as many hands rather than one
 * — a single burst sounds like a snare.
 */
function makeClap({ bandpass = 1100, spread = 0.011, tail = 0.16, level = 1.0 }) {
  return (ctx, dest, time, velocity) => {
    const out = ctx.createGain();
    out.gain.value = level * velocity;
    out.connect(dest);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = bandpass;
    filter.Q.value = 1.0;
    filter.connect(out);

    for (let i = 0; i < 3; i++) {
      const at = time + i * spread;
      const g = ctx.createGain();
      percEnv(g.gain, at, 0.7, 0.001, 0.02);
      noiseSource(ctx, at, 0.04).connect(g);
      g.connect(filter);
    }

    const tailAt = time + 3 * spread;
    const tailGain = ctx.createGain();
    percEnv(tailGain.gain, tailAt, 0.5, 0.002, tail);
    noiseSource(ctx, tailAt, tail + 0.05).connect(tailGain);
    tailGain.connect(filter);

    return out;
  };
}

/** Noise through a highpass. Decay length is the entire difference between a
 *  closed and an open hat. */
function makeHat({ highpass, decay, level = 1.0 }) {
  return (ctx, dest, time, velocity) => {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = highpass;

    const out = ctx.createGain();
    percEnv(out.gain, time, 0.45 * level * velocity, 0.001, decay);

    noiseSource(ctx, time, decay + 0.05).connect(hp);
    hp.connect(out).connect(dest);
    return out;
  };
}

/** Two detuned squares through a bandpass — the classic 808 cowbell. */
function makeCowbell({ a = 540, b = 800, decay = 0.32, level = 1.0 }) {
  return (ctx, dest, time, velocity) => {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2200;
    bp.Q.value = 1.4;

    const out = ctx.createGain();
    percEnv(out.gain, time, 0.35 * level * velocity, 0.002, decay);

    for (const freq of [a, b]) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = freq;
      osc.connect(bp);
      osc.start(time);
      osc.stop(time + decay + 0.05);
    }

    bp.connect(out).connect(dest);
    return out;
  };
}

/** Sawtooth with a steep pitch drop and a lowpass sweep chasing it. */
function makeZap({ from = 900, to = 70, sweep = 0.14, decay = 0.2, level = 1.0 }) {
  return (ctx, dest, time, velocity) => {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    pitchEnv(osc.frequency, time, from, to, sweep);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 6;
    pitchEnv(lp.frequency, time, from * 4, to * 6, sweep);

    const out = ctx.createGain();
    percEnv(out.gain, time, 0.5 * level * velocity, 0.003, decay);

    osc.connect(lp).connect(out).connect(dest);
    osc.start(time);
    osc.stop(time + decay + 0.1);
    return out;
  };
}

// ---------------------------------------------------------------------------
// The bank
//
// Order matters: index 0-15 maps to the 4x4 grid left-to-right, top-to-bottom,
// which is the same order as the keyboard map in phase 3 (1234/qwer/asdf/zxcv)
// and the same order the pad meshes are built in phase 2.
// ---------------------------------------------------------------------------

export const PADS = [
  // Row 1 — kicks and backbeat
  { id: 'kick_deep',   label: 'Kick Deep',  hue: 0.02, voice: makeKick({ from: 150, to: 42, sweep: 0.09, decay: 0.50 }) },
  { id: 'kick_tight',  label: 'Kick Tight', hue: 0.02, voice: makeKick({ from: 180, to: 58, sweep: 0.05, decay: 0.26 }) },
  { id: 'snare',       label: 'Snare',      hue: 0.09, voice: makeSnare({ tone: 190, noiseDecay: 0.16, toneDecay: 0.10, bandpass: 1900 }) },
  { id: 'clap',        label: 'Clap',       hue: 0.09, voice: makeClap({}) },

  // Row 2 — toms and rim
  { id: 'rim',         label: 'Rim',        hue: 0.14, voice: makeSnare({ tone: 420, noiseDecay: 0.03, toneDecay: 0.03, bandpass: 1700, q: 3.0, level: 0.8 }) },
  { id: 'tom_low',     label: 'Tom Low',    hue: 0.14, voice: makeKick({ from: 130, to: 78,  sweep: 0.14, decay: 0.34, level: 0.85 }) },
  { id: 'tom_mid',     label: 'Tom Mid',    hue: 0.14, voice: makeKick({ from: 190, to: 115, sweep: 0.13, decay: 0.30, level: 0.85 }) },
  { id: 'tom_high',    label: 'Tom High',   hue: 0.14, voice: makeKick({ from: 265, to: 160, sweep: 0.12, decay: 0.26, level: 0.85 }) },

  // Row 3 — cymbals
  { id: 'hat_closed',  label: 'Hat Closed', hue: 0.52, chokeGroup: 'hh', voice: makeHat({ highpass: 8000, decay: 0.045 }) },
  { id: 'hat_open',    label: 'Hat Open',   hue: 0.52, chokeGroup: 'hh', voice: makeHat({ highpass: 7000, decay: 0.42 }) },
  { id: 'ride',        label: 'Ride',       hue: 0.52, voice: makeHat({ highpass: 5200, decay: 0.85, level: 0.75 }) },
  { id: 'crash',       label: 'Crash',      hue: 0.52, voice: makeHat({ highpass: 3600, decay: 1.90, level: 0.75 }) },

  // Row 4 — percussion and effects
  { id: 'perc_click',  label: 'Click',      hue: 0.75, voice: makeSnare({ tone: 0, noiseDecay: 0.018, toneDecay: 0, bandpass: 3200, q: 4.0, level: 0.7 }) },
  { id: 'cowbell',     label: 'Cowbell',    hue: 0.75, voice: makeCowbell({}) },
  { id: 'zap',         label: 'Zap',        hue: 0.75, voice: makeZap({}) },
  { id: 'sub_drop',    label: 'Sub Drop',   hue: 0.75, voice: makeKick({ from: 110, to: 28, sweep: 0.55, decay: 0.80 }) },
];

/** id -> pad definition, for lookup by name. */
export const PAD_BY_ID = new Map(PADS.map((p) => [p.id, p]));

/** id -> 0..15 grid index, used by the geometry and the keyboard map. */
export const PAD_INDEX = new Map(PADS.map((p, i) => [p.id, i]));