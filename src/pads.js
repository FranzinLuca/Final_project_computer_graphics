/**
  pads.js — the pad bank: 16 drum voices, synthesised from scratch.

  No samples. Every sound here is oscillators and filtered noise.
*/

// --------------
// Shared helpers
// --------------

/** One noise buffer, reused by every noise-based voice. */
let noiseBuffer = null;

// white noise generator
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

// read from a random offset of the white noise
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
  Percussive amplitude envelope: near-instant attack, exponential decay.

  Standard AR envelope shape
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

/**
  Velocity -> brightness multiplier.

  if you strike a drum harder it get's louder but also have more 
  vibrations (brighter) 
*/
function brightness(velocity, depth = 0.68) {
  return 1 - depth + depth * Math.pow(Math.min(1, Math.max(0, velocity)), 0.7);
}

/**
  Having identical waveforms at perfectly regular time feels like a 
  continous tone into human ear. 

  Giving a small variance can help decorrelate different hits
*/
function vary(value, amount = 0.02) {
  return value * (1 + (Math.random() * 2 - 1) * amount);
}

/**
  A tanh-shaped waveshaper.

  tanh curve (as in audio.js) is a good soft clipping/saturation curve
*/
function saturator(ctx, drive = 2.2) {
  const shaper = ctx.createWaveShaper();
  const n = 1024;
  const curve = new Float32Array(n);
  const norm = Math.tanh(drive);

  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(drive * x) / norm;
  }

  shaper.curve = curve;
  shaper.oversample = '4x';
  return shaper;
}

/**
 Terminal node for every voice: level, then stereo placement..
*/
function out(ctx, dest, level, pan = 0) {
  const gain = ctx.createGain();

  if (pan !== 0) {
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    gain.connect(panner).connect(dest);
  } else {
    gain.connect(dest);
  }

  gain.gain.value = level;
  return gain;
}

// --------------------
// The oscillator banks
// --------------------

const BANK = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0];
const HAT_BANK = [263.1, 400.5, 421.7, 551.3, 638.9, 779.4, 830.6, 991.2];
const RIDE_BANK = [305.0, 460.7, 540.0, 800.0, 1068.5];
const CRASH_BANK = [178.2, 243.6, 311.4, 366.8, 428.5, 512.9, 587.3, 671.6, 745.1, 833.8];

/**
  Build the bank, detuned per hit, and connect it to `dest`.
  @param {number} tune multiplies every partial — the bank's "pitch"
 */
function oscBank(ctx, dest, time, duration, tune = 1, ratios = BANK) {
  for (const freq of ratios) {
    const osc = ctx.createOscillator();
    osc.type = 'square';
    // Per-partial variation rather than one detune for the whole bank: shifting
    // them together would just transpose the sound, where scattering them
    // slightly changes which partials beat against each other and gives every
    // hit its own shimmer.
    osc.frequency.value = vary(freq * tune, 0.012);
    osc.connect(dest);
    osc.start(time);
    osc.stop(time + duration + 0.05);
  }
}

// ------------------
// Voice constructors
// ------------------

/**
  Kick: a sine with a fast downward pitch sweep, a beater click on top, and
  saturation across both.
*/
function makeKick({ from, to, sweep, decay, click = 0.55, drive = 2.2, level = 1.0, punch = 0.35 }) {
  return (ctx, dest, time, velocity) => {
    const output = out(ctx, dest, level * velocity);

    const shaper = saturator(ctx, drive);
    shaper.connect(output);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const startFreq = vary(from, 0.015);

    const kneeTime = Math.max(0.006, sweep * 0.12);
    const kneeFreq = to + (startFreq - to) * 0.35;
    osc.frequency.setValueAtTime(startFreq, time);
    osc.frequency.exponentialRampToValueAtTime(Math.max(kneeFreq, 0.01), time + kneeTime);
    osc.frequency.exponentialRampToValueAtTime(Math.max(to, 0.01), time + sweep);

    const body = ctx.createGain();
    percEnv(body.gain, time, 0.9, 0.004, decay);
    osc.connect(body).connect(shaper);
    osc.start(time);
    osc.stop(time + decay + 0.1);

    if (punch > 0) {
      const punchOsc = ctx.createOscillator();
      punchOsc.type = 'triangle';
      pitchEnv(punchOsc.frequency, time, vary(startFreq * 2.6, 0.02), startFreq * 1.1, kneeTime * 2.2);
      const punchGain = ctx.createGain();
      percEnv(punchGain.gain, time, punch * velocity, 0.0004, kneeTime * 2.5);
      punchOsc.connect(punchGain).connect(shaper);
      punchOsc.start(time);
      punchOsc.stop(time + kneeTime * 3 + 0.02);
    }

    if (click > 0) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1900 * brightness(velocity, 0.55);
      bp.Q.value = 0.8;

      const tick = ctx.createGain();
      percEnv(tick.gain, time, click * velocity, 0.0005, 0.014);

      noiseSource(ctx, time, 0.03).connect(bp);
      bp.connect(tick).connect(output);
    }

    return output;
  };
}

/**
  Snare: two body modes, plus wires.
*/
function makeSnare({
  tone, noiseDecay, toneDecay, bandpass, wires = 0.9,
  q = 1.2, level = 1.0, pan = 0,
}) {
  return (ctx, dest, time, velocity) => {
    const output = out(ctx, dest, level * velocity, pan);

    // Body — the two membrane modes.
    if (tone) {
      const bodyShaper = saturator(ctx, 1.4);
      bodyShaper.connect(output);

      for (const [ratio, weight] of [[1, 0.5], [1.78, 0.28]]) {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        const f = vary(tone * ratio, 0.02);
        pitchEnv(osc.frequency, time, f, f * 0.72, toneDecay);

        const g = ctx.createGain();
        percEnv(g.gain, time, weight, 0.002, toneDecay * (ratio > 1 ? 0.7 : 1));

        osc.connect(g).connect(bodyShaper);
        osc.start(time);
        osc.stop(time + toneDecay + 0.05);
      }
    }

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1400 * brightness(velocity, 0.5);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = bandpass * brightness(velocity, 0.35);
    bp.Q.value = q;

    const wireGain = ctx.createGain();
    percEnv(wireGain.gain, time, wires, 0.001, vary(noiseDecay, 0.08));

    noiseSource(ctx, time, noiseDecay + 0.05).connect(hp);
    hp.connect(bp).connect(wireGain).connect(output);

    return output;
  };
}

/**
  Clap: several very short noise bursts a few milliseconds apart, then a
  longer tail.
*/
function makeClap({ bandpass = 1100, spread = 0.011, tail = 0.16, level = 1.0, pan = 0 }) {
  return (ctx, dest, time, velocity) => {
    const output = out(ctx, dest, level * velocity, pan);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = bandpass * brightness(velocity, 0.4);
    filter.Q.value = 1.0;
    filter.connect(output);

    let at = time;
    for (let i = 0; i < 3; i++) {
      const g = ctx.createGain();
      percEnv(g.gain, at, 0.7, 0.001, 0.02);
      noiseSource(ctx, at, 0.04).connect(g);
      g.connect(filter);
      at += vary(spread, 0.22);
    }

    const tailGain = ctx.createGain();
    percEnv(tailGain.gain, at, 0.5, 0.002, tail);
    noiseSource(ctx, at, tail + 0.05).connect(tailGain);
    tailGain.connect(filter);

    return output;
  };
}

/**
  Metallic voice: hats, ride and crash.
*/
function makeMetal({
  highpass, bandpass = 0, decay, tune = 1, q = 1.4,
  swell = 0, level = 1.0, pan = 0, ratios = BANK, shimmer = true,
}) {
  return (ctx, dest, time, velocity) => {
    const output = out(ctx, dest, level * velocity, pan);

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = highpass * brightness(velocity, 0.42);

    let node = hp;

    if (bandpass) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = bandpass;
      bp.Q.value = q;
      node.connect(bp);
      node = bp;
    }

    const env = ctx.createGain();
    const length = vary(decay, 0.05);

    if (swell > 0) {
      percEnv(env.gain, time, 0.5, swell, length);
    } else {
      percEnv(env.gain, time, 0.5, 0.001, length);
    }

    node.connect(env).connect(output);

    oscBank(ctx, hp, time, length, tune, ratios);

    if (shimmer) {
      const shimmerGain = ctx.createGain();
      shimmerGain.gain.value = 0.55;
      shimmerGain.connect(hp);
      oscBank(ctx, shimmerGain, time, length, tune * 1.006, ratios);
    }

    const noiseHp = ctx.createBiquadFilter();
    noiseHp.type = 'highpass';
    noiseHp.frequency.value = highpass * 1.4;
    const noiseGain = ctx.createGain();
    percEnv(noiseGain.gain, time, 0.22, 0.001, length * 0.7);
    noiseSource(ctx, time, length + 0.05).connect(noiseHp);
    noiseHp.connect(noiseGain).connect(output);

    return output;
  };
}

/**
  Cowbell: two of the same six partials, hard bandpassed.
*/
function makeCowbell({ a = 540, b = 800, decay = 0.32, level = 1.0, pan = 0 }) {
  return (ctx, dest, time, velocity) => {
    const output = out(ctx, dest, level * velocity, pan);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2200 * brightness(velocity, 0.3);
    bp.Q.value = 1.4;

    const env = ctx.createGain();
    percEnv(env.gain, time, 0.4, 0.002, vary(decay, 0.04));

    oscBank(ctx, bp, time, decay, 1, [vary(a, 0.008), vary(b, 0.008)]);
    bp.connect(env).connect(output);

    return output;
  };
}

/**
  Rim shot: a stick striking the hoop. Almost no body, all click.
*/
function makeRim({ a = 1720, b = 2610, decay = 0.028, level = 1.0, pan = 0 }) {
  return (ctx, dest, time, velocity) => {
    const output = out(ctx, dest, level * velocity, pan);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2400 * brightness(velocity, 0.22);
    bp.Q.value = 2.6;

    const env = ctx.createGain();
    percEnv(env.gain, time, 0.55, 0.0008, decay);

    oscBank(ctx, bp, time, decay, 1, [vary(a, 0.02), vary(b, 0.02)]);

    const tick = ctx.createGain();
    percEnv(tick.gain, time, 0.35, 0.0005, 0.006);
    noiseSource(ctx, time, 0.02).connect(tick);
    tick.connect(bp);

    bp.connect(env).connect(output);
    return output;
  };
}

/**
  Tom: a kick's pitch sweep, opened out and given a skin.
*/
function makeTom({ from, to, sweep, decay, level = 0.85, pan = 0 }) {
  return (ctx, dest, time, velocity) => {
    const output = out(ctx, dest, level * velocity, pan);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const f = vary(from, 0.018);
    pitchEnv(osc.frequency, time, f, to, sweep);

    const body = ctx.createGain();
    percEnv(body.gain, time, 0.85, 0.003, vary(decay, 0.06));
    osc.connect(body).connect(output);
    osc.start(time);
    osc.stop(time + decay + 0.1);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2600 * brightness(velocity, 0.6);
    bp.Q.value = 0.7;

    const attack = ctx.createGain();
    percEnv(attack.gain, time, 0.30 * velocity, 0.0008, 0.020);
    noiseSource(ctx, time, 0.04).connect(bp);
    bp.connect(attack).connect(output);

    return output;
  };
}

/** Sawtooth with a steep pitch drop and a lowpass sweep chasing it. */
function makeZap({ from = 900, to = 70, sweep = 0.14, decay = 0.2, level = 1.0, pan = 0 }) {
  return (ctx, dest, time, velocity) => {
    const output = out(ctx, dest, 0.5 * level * velocity, pan);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const f = vary(from, 0.03);
    pitchEnv(osc.frequency, time, f, to, sweep);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 6;
    pitchEnv(lp.frequency, time, f * 4 * brightness(velocity, 0.5), to * 6, sweep);

    const env = ctx.createGain();
    percEnv(env.gain, time, 0.9, 0.003, decay);

    osc.connect(lp).connect(env).connect(output);
    osc.start(time);
    osc.stop(time + decay + 0.1);
    return output;
  };
}

/** Very short filtered noise. The metronome tick of the kit. */
function makeClick({ highpass = 2600, decay = 0.016, level = 0.7, pan = 0 }) {
  return (ctx, dest, time, velocity) => {
    const output = out(ctx, dest, level * velocity, pan);

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = highpass * brightness(velocity, 0.35);

    const env = ctx.createGain();
    percEnv(env.gain, time, 0.7, 0.0005, decay);

    noiseSource(ctx, time, decay + 0.03).connect(hp);
    hp.connect(env).connect(output);
    return output;
  };
}

// ----------
// The layout
// ----------

export const LAYOUT = [
  // Row 1 — the pulse and the backbeat
  { id: 'kick_deep',  hue: 0.02, pan: 0 },
  { id: 'kick_tight', hue: 0.02, pan: 0 },
  { id: 'snare',      hue: 0.09, pan: 0 },
  { id: 'clap',       hue: 0.09, pan: 0.18 },

  // Row 2 — mid percussion
  { id: 'rim',        hue: 0.30, pan: -0.22 },
  { id: 'tom_low',    hue: 0.30, pan: -0.30 },
  { id: 'tom_mid',    hue: 0.30, pan: 0.00 },
  { id: 'tom_high',   hue: 0.30, pan: 0.30 },

  // Row 3 — cymbals
  { id: 'hat_closed', hue: 0.52, pan: 0.26, chokeGroup: 'hh' },
  { id: 'hat_open',   hue: 0.52, pan: 0.26, chokeGroup: 'hh' },
  { id: 'ride',       hue: 0.52, pan: -0.34 },
  { id: 'crash',      hue: 0.52, pan: 0.40 },

  // Row 4 — colour and low end
  { id: 'perc_click', hue: 0.78, pan: -0.15 },
  { id: 'cowbell',    hue: 0.78, pan: 0.22 },
  { id: 'zap',        hue: 0.78, pan: -0.28 },
  { id: 'sub_drop',   hue: 0.78, pan: 0 },
];

// --------
// The kits
// --------

/**
  STUDIO — the acoustic-leaning original. Sampled-kit character: short decays,
  moderate drive, membranes that sound like membranes.
*/
const STUDIO = {
  kick_deep:  ['Kick Deep',  makeKick({ from: 150, to: 42, sweep: 0.09, decay: 0.50, click: 0.45, drive: 2.4 })],
  kick_tight: ['Kick Tight', makeKick({ from: 180, to: 58, sweep: 0.05, decay: 0.26, click: 0.70, drive: 2.0 })],
  snare:      ['Snare',      makeSnare({ tone: 190, noiseDecay: 0.16, toneDecay: 0.10, bandpass: 1900 })],
  clap:       ['Clap',       makeClap({})],
  rim:        ['Rim',        makeRim({})],
  tom_low:    ['Tom Low',    makeTom({ from: 130, to: 78,  sweep: 0.14, decay: 0.34 })],
  tom_mid:    ['Tom Mid',    makeTom({ from: 190, to: 115, sweep: 0.13, decay: 0.30 })],
  tom_high:   ['Tom High',   makeTom({ from: 265, to: 160, sweep: 0.12, decay: 0.26 })],
  hat_closed: ['Hat Closed', makeMetal({ highpass: 7800, decay: 0.045, tune: 1.0, level: 0.55, ratios: HAT_BANK })],
  hat_open:   ['Hat Open',   makeMetal({ highpass: 6600, decay: 0.42,  tune: 1.0, level: 0.50, ratios: HAT_BANK })],
  ride:       ['Ride',       makeMetal({ highpass: 4200, bandpass: 5200, q: 1.1, decay: 0.90, tune: 1.32, level: 0.42, ratios: RIDE_BANK })],
  crash:      ['Crash',      makeMetal({ highpass: 3000, decay: 1.90, tune: 0.86, swell: 0.020, level: 0.40, ratios: CRASH_BANK })],
  perc_click: ['Click',      makeClick({})],
  cowbell:    ['Cowbell',    makeCowbell({})],
  zap:        ['Zap',        makeZap({})],
  sub_drop:   ['Sub Drop',   makeKick({ from: 110, to: 28, sweep: 0.55, decay: 0.80, click: 0, drive: 1.6 })],
};

/**
  REGGAETÓN — the dembow kit.
*/
const REGGAETON = {
  kick_deep:  ['Kick Round', makeKick({ from: 120, to: 47, sweep: 0.11, decay: 0.36, click: 0.16, drive: 1.9 })],
  kick_tight: ['Kick Short', makeKick({ from: 145, to: 55, sweep: 0.05, decay: 0.20, click: 0.30, drive: 1.7 })],
  snare:      ['Snare Tite', makeSnare({ tone: 260, noiseDecay: 0.10, toneDecay: 0.055, bandpass: 2400, wires: 0.8 })],
  clap:       ['Clap Wide',  makeClap({ bandpass: 1500, spread: 0.014, tail: 0.20 })],
  rim:        ['Timbal Rim', makeRim({ a: 2100, b: 3080, decay: 0.024 })],
  tom_low:    ['Timbale Lo', makeTom({ from: 250, to: 205, sweep: 0.05, decay: 0.20, level: 0.9 })],
  tom_mid:    ['Timbale Hi', makeTom({ from: 340, to: 285, sweep: 0.04, decay: 0.17, level: 0.9 })],
  tom_high:   ['Conga',      makeTom({ from: 430, to: 380, sweep: 0.03, decay: 0.14, level: 0.85 })],
  hat_closed: ['Hat Soft',   makeMetal({ highpass: 6800, decay: 0.038, tune: 0.94, level: 0.42, ratios: HAT_BANK })],
  hat_open:   ['Hat Loose',  makeMetal({ highpass: 5600, decay: 0.30, tune: 0.94, level: 0.38, ratios: HAT_BANK })],
  ride:       ['Cascara',    makeMetal({ highpass: 3400, bandpass: 4200, q: 2.2, decay: 0.30, tune: 1.5, level: 0.40, ratios: RIDE_BANK })],
  crash:      ['Crash',      makeMetal({ highpass: 2600, decay: 1.60, tune: 0.80, swell: 0.018, level: 0.42, ratios: CRASH_BANK })],
  // A güiro scrape: broadband noise with the low end taken out, long enough to
  // read as a stroke across the ridges rather than as a tick.
  perc_click: ['Guiro',      makeClick({ highpass: 1800, decay: 0.075, level: 0.55 })],
  cowbell:    ['Campana',    makeCowbell({ a: 620, b: 925, decay: 0.42, level: 1.0 })],
  zap:        ['Riser',      makeZap({ from: 300, to: 1400, sweep: 0.30, decay: 0.34, level: 0.6 })],
  sub_drop:   ['Sub',        makeKick({ from: 90, to: 38, sweep: 0.30, decay: 0.60, click: 0, drive: 1.4 })],
};

/**
  TECHNO — the 909-derived kit.
*/
const TECHNO = {
  kick_deep:  ['Kick 909',   makeKick({ from: 210, to: 45, sweep: 0.13, decay: 0.62, click: 0.55, drive: 3.6 })],
  kick_tight: ['Kick Punch', makeKick({ from: 240, to: 62, sweep: 0.04, decay: 0.28, click: 0.85, drive: 3.0 })],
  snare:      ['Snare 909',  makeSnare({ tone: 220, noiseDecay: 0.22, toneDecay: 0.08, bandpass: 2600, wires: 1.05 })],
  clap:       ['Clap Long',  makeClap({ bandpass: 1250, spread: 0.010, tail: 0.30, level: 1.05 })],
  rim:        ['Rimshot',    makeRim({ a: 1900, b: 2900, decay: 0.020 })],
  tom_low:    ['Tom 909 Lo', makeTom({ from: 150, to: 70,  sweep: 0.20, decay: 0.42 })],
  tom_mid:    ['Tom 909 Md', makeTom({ from: 215, to: 105, sweep: 0.18, decay: 0.36 })],
  tom_high:   ['Tom 909 Hi', makeTom({ from: 300, to: 150, sweep: 0.16, decay: 0.30 })],
  hat_closed: ['Hat Tight',  makeMetal({ highpass: 9200, decay: 0.032, tune: 1.18, level: 0.60, ratios: HAT_BANK })],
  hat_open:   ['Hat Open',   makeMetal({ highpass: 7600, decay: 0.60, tune: 1.18, level: 0.52, ratios: HAT_BANK })],
  ride:       ['Ride Bell',  makeMetal({ highpass: 5200, bandpass: 6800, q: 1.6, decay: 1.10, tune: 1.44, level: 0.40, ratios: RIDE_BANK })],
  crash:      ['Crash Big',  makeMetal({ highpass: 2800, decay: 2.60, tune: 0.82, swell: 0.028, level: 0.44, ratios: CRASH_BANK })],
  perc_click: ['Tick',       makeClick({ highpass: 4200, decay: 0.012, level: 0.75 })],
  cowbell:    ['Cowbell',    makeCowbell({ a: 587, b: 845, decay: 0.26, level: 0.9 })],
  zap:        ['Acid Blip',  makeZap({ from: 1600, to: 180, sweep: 0.09, decay: 0.24, level: 0.85 })],
  sub_drop:   ['Sub Rumble', makeKick({ from: 70, to: 32, sweep: 0.80, decay: 1.40, click: 0, drive: 1.3 })],
};

/**
  DRILL — the 808 kit.
*/
const DRILL = {
  kick_deep:  ['Kick 808',   makeKick({ from: 200, to: 50, sweep: 0.045, decay: 0.30, click: 0.80, drive: 2.6 })],
  kick_tight: ['Kick Tap',   makeKick({ from: 230, to: 66, sweep: 0.03, decay: 0.16, click: 0.95, drive: 2.2 })],
  snare:      ['Snare Thin', makeSnare({ tone: 320, noiseDecay: 0.09, toneDecay: 0.04, bandpass: 3100, wires: 0.75, level: 0.9 })],
  clap:       ['Clap Tight', makeClap({ bandpass: 1700, spread: 0.007, tail: 0.11 })],
  rim:        ['Rim Click',  makeRim({ a: 2400, b: 3600, decay: 0.014 })],
  tom_low:    ['808 Tom Lo', makeTom({ from: 120, to: 96,  sweep: 0.10, decay: 0.50 })],
  tom_mid:    ['808 Tom Md', makeTom({ from: 175, to: 140, sweep: 0.09, decay: 0.44 })],
  tom_high:   ['808 Tom Hi', makeTom({ from: 240, to: 195, sweep: 0.08, decay: 0.38 })],
  hat_closed: ['Hat Roll',   makeMetal({ highpass: 8600, decay: 0.022, tune: 1.10, level: 0.50, ratios: HAT_BANK })],
  hat_open:   ['Hat Open',   makeMetal({ highpass: 7000, decay: 0.24, tune: 1.10, level: 0.44, ratios: HAT_BANK })],
  ride:       ['Ride Dark',  makeMetal({ highpass: 3600, bandpass: 4600, q: 1.3, decay: 0.70, tune: 1.16, level: 0.36, ratios: RIDE_BANK })],
  crash:      ['Crash Dark', makeMetal({ highpass: 2400, decay: 1.70, tune: 0.74, swell: 0.024, level: 0.38, ratios: CRASH_BANK })],
  perc_click: ['Stick',      makeClick({ highpass: 3400, decay: 0.010, level: 0.65 })],
  cowbell:    ['Bell Hi',    makeCowbell({ a: 780, b: 1180, decay: 0.18, level: 0.7 })],
  zap:        ['Slide Down', makeZap({ from: 420, to: 55, sweep: 0.28, decay: 0.42, level: 0.8 })],
  // The 808 proper: nearly two seconds, no click at all, and a long glide.
  sub_drop:   ['808 Slide',  makeKick({ from: 130, to: 30, sweep: 0.70, decay: 1.60, click: 0, drive: 1.5 })],
};

/**
  The kit table. `bpm` is the tempo the style lives at, offered when the kit is
  chosen rather than forced — switching kits should not silently retempo a
  pattern somebody is in the middle of recording.
*/
export const KITS = [
  { id: 'studio',    name: 'Studio',     bpm: 92,  description: 'Acoustic-leaning kit. Short decays, real membranes.', voices: STUDIO },
  { id: 'reggaeton', name: 'Reggaetón',  bpm: 96,  description: 'Dembow kit: timbales, campana, güiro, round kick.', voices: REGGAETON },
  { id: 'techno',    name: 'Techno',     bpm: 132, description: '909-derived. Long saturated kick, harsh hats, acid blip.', voices: TECHNO },
  { id: 'drill',     name: 'Drill',      bpm: 142, description: '808 kit. Gliding sub bass, 22 ms hat for rolls.', voices: DRILL },
];

export const KIT_BY_ID = new Map(KITS.map((k) => [k.id, k]));

/**
  Merge the layout with a kit's voices into the sixteen pad definitions.

  The `pan` from the layout is injected into the voice at BUILD time rather
  than being passed by each kit, which is why no kit above writes a pan value:
  stereo placement (pan) is a property of where the pad sits on the instrument, and
  letting a kit override it would let one kit put its snare off-centre and
  quietly break the mix in a way nobody would think to look for.
*/

function panned(voice, pan) {
  if (!pan) return voice;
  return (ctx, dest, time, velocity) => {
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    panner.connect(dest);
    return voice(ctx, panner, time, velocity);
  };
}

function buildKit(kit) {
  return LAYOUT.map((slot) => {
    const entry = kit.voices[slot.id];
    if (!entry) {
      console.error(`[pads] kit "${kit.id}" has no voice for slot "${slot.id}"`);
      return null;
    }
    const [label, voice] = entry;
    return {
      id: slot.id,
      label,
      hue: slot.hue,
      pan: slot.pan,
      chokeGroup: slot.chokeGroup,
      voice: panned(voice, slot.pan),
    };
  }).filter(Boolean);
}

// --------------
// The active kit
// --------------

let activeKit = KITS[0];

export let PADS = buildKit(activeKit);
export let PAD_BY_ID = new Map(PADS.map((p) => [p.id, p]));
export let PAD_INDEX = new Map(PADS.map((p, i) => [p.id, i]));

export function getKit() { return activeKit; }

/**
  Swap the loaded kit.
  Takes effect on the NEXT hit, not on notes already scheduled: `playVoice`
  looks the pad up at the moment it builds the node graph, and the scheduler
  commits up to 100 ms ahead. 
  @returns {object | null} the kit now loaded
*/
export function setKit(id) {
  const kit = KIT_BY_ID.get(id);
  if (!kit) {
    console.error(`[pads] no kit named "${id}"`);
    return null;
  }

  activeKit = kit;
  PADS = buildKit(kit);
  PAD_BY_ID = new Map(PADS.map((p) => [p.id, p]));
  PAD_INDEX = new Map(PADS.map((p, i) => [p.id, i]));
  return kit;
}