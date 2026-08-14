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
 *
 *
 * WHAT PHASE 8 CHANGED, AND WHY
 *
 * The phase 1 bank was correct and characterless. Every voice was one envelope
 * on one source, velocity only scaled gain, and repeated hits were bit-identical.
 * Five things changed, roughly in order of how much difference they make:
 *
 *   1. VELOCITY SHAPES TIMBRE, NOT ONLY LEVEL.
 *      Striking a drum harder does not just move more air, it excites higher
 *      modes — a hard snare hit is brighter, not merely louder. Every voice
 *      here scales its filter cutoff with velocity as well as its gain. This is
 *      what makes the 0.45 ghost notes in presets.js sound like ghost notes
 *      rather than like quiet copies of the same sound, and it is the single
 *      largest improvement in the file.
 *
 *   2. CYMBALS ARE OSCILLATOR BANKS, NOT NOISE.
 *      White noise has a flat continuous spectrum with no modes in it at all,
 *      so filtered noise reads as "sh" and never as "ting". A cymbal is a metal
 *      plate with discrete inharmonic partials. Six square oscillators at the
 *      TR-808's ratios give those partials, and squares rather than sines
 *      because a square is already a stack of odd harmonics — six of them
 *      produce far more spectral density than six oscillators has any right to.
 *
 *   3. THE KICKS ARE SATURATED.
 *      A pure sine has exactly one partial. A 45 Hz sine on a laptop speaker
 *      with no response below 150 Hz is inaudible — the sound is simply not
 *      there. Running it through a tanh curve generates odd harmonics; measured
 *      on this drive setting the third lands at 135 Hz and the fifth at 225 Hz,
 *      both comfortably inside what a small speaker reproduces, and the ear
 *      reconstructs the missing fundamental from them. This project is going to
 *      be demonstrated on a laptop.
 *
 *   4. EVERY HIT VARIES SLIGHTLY.
 *      Two identical waveforms starting at different times phase-lock into a
 *      machine-gun effect the ear picks up immediately. Small random deviations
 *      in pitch and decay break it. The noise voices already did this by
 *      reading from a random offset; the tonal ones did not.
 *
 *   5. THE KIT HAS A STEREO IMAGE.
 *      Toms spread across the field, hats sit slightly off centre, kick and
 *      snare stay dead centre because they are the anchor. Panning lives inside
 *      the voices rather than in audio.js, so this whole phase touches one file.
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

/**
 * Velocity -> brightness multiplier.
 *
 * Applied to filter cutoffs, never to gain — gain is handled separately by the
 * envelope peak. A hard hit excites a drumhead's higher modes; a soft one
 * barely moves them, so the sound is genuinely darker and not just quieter.
 *
 * The floor of 0.32 rather than 0 matters: a cutoff that reaches zero silences
 * the voice entirely, and the quietest ghost note still has to be audible. The
 * 0.7 exponent bends the curve so most of the brightening happens in the lower
 * half of the velocity range, where the ear notices it.
 */
function brightness(velocity, depth = 0.68) {
  return 1 - depth + depth * Math.pow(Math.min(1, Math.max(0, velocity)), 0.7);
}

/**
 * Multiply a value by a small random deviation.
 *
 * Percussion synthesis without this has a specific and very recognisable
 * failure: identical hits at regular intervals fuse into one continuous tone
 * rather than reading as separate strikes, because their partials stay in phase
 * with each other. A percent or two of pitch scatter is enough to break it and
 * far too little to sound out of tune.
 */
function vary(value, amount = 0.02) {
  return value * (1 + (Math.random() * 2 - 1) * amount);
}

/**
 * A tanh-shaped waveshaper.
 *
 * `oversample: '4x'` is not optional. Distortion by definition generates
 * harmonics above the input's, and any that land above Nyquist alias — they
 * fold back down as inharmonic garbage at frequencies unrelated to anything
 * played. Running the shaper at four times the sample rate pushes the fold
 * point high enough that the harmonics decay before they reach it. It is the
 * cheapest correctness fix in this file and the most audible when missing.
 *
 * The curve is normalised by tanh(drive) so the shaper is unity-gain at full
 * scale, which keeps drive and level independent — otherwise turning up the
 * drive also turns up the volume and the two cannot be judged separately.
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
 * Terminal node for every voice: level, then stereo placement.
 *
 * Placing the panner here rather than in audio.js keeps the whole of phase 8
 * inside this file. It also sits AFTER the gain node that gets returned, so
 * choking still works untouched — `playVoice` ramps the gain, and the panner
 * downstream neither knows nor cares.
 *
 * StereoPannerNode uses an equal-power law, so a sound panned hard to one side
 * is the same perceived loudness as one in the centre. A naive linear pan
 * would make everything off-centre quieter, and the kit would sound like it
 * had a hole in the middle.
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

// ---------------------------------------------------------------------------
// The 808 oscillator bank
//
// Six square waves at fixed inharmonic frequencies. These exact numbers are the
// TR-808's, and they are worth knowing because of what they are NOT: they are
// not multiples of a fundamental. 205.3, 304.4, 369.6, 522.7, 540 and 800 have
// no common divisor worth speaking of, which is precisely why the result reads
// as struck metal rather than as a chord. A harmonic stack sounds like a note;
// an inharmonic one sounds like an object.
//
// The 808's cowbell is two of these same six — 540 and 800 — with a different
// filter and envelope on them. That is not a coincidence and not a shortcut on
// its designers' part: it is the same physical claim, that a piece of struck
// metal is a handful of unrelated partials, applied twice.
// ---------------------------------------------------------------------------

const BANK = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0];

/**
 * Build the bank, detuned per hit, and connect it to `dest`.
 *
 * @param {number} tune multiplies every partial — the bank's "pitch"
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

// ---------------------------------------------------------------------------
// Voice constructors
//
// Each returns a voice function. Parameterising them this way means the four
// toms are one recipe with three sets of numbers, not three copies of a
// function — and retuning a family is one edit.
// ---------------------------------------------------------------------------

/**
 * Kick: a sine with a fast downward pitch sweep, a beater click on top, and
 * saturation across both.
 *
 * The sweep alone is the whole of textbook kick synthesis and it is only half a
 * kick. The other half is the transient — the sound of a beater hitting a
 * skin, which is broadband, three milliseconds long, and carries almost all of
 * the information the ear uses to place the hit in time. Without it a kick has
 * no attack and always feels slightly late.
 */
function makeKick({ from, to, sweep, decay, click = 0.55, drive = 2.2, level = 1.0 }) {
  return (ctx, dest, time, velocity) => {
    const output = out(ctx, dest, level * velocity);

    const shaper = saturator(ctx, drive);
    shaper.connect(output);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    pitchEnv(osc.frequency, time, vary(from, 0.015), to, sweep);

    const body = ctx.createGain();
    percEnv(body.gain, time, 0.9, 0.004, decay);
    osc.connect(body).connect(shaper);
    osc.start(time);
    osc.stop(time + decay + 0.1);

    if (click > 0) {
      // Bandpassed noise, very short. Its cutoff rides velocity hard, so a soft
      // kick is round and a hard one has a slap on the front.
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1900 * brightness(velocity, 0.55);
      bp.Q.value = 0.8;

      const tick = ctx.createGain();
      percEnv(tick.gain, time, click * velocity, 0.0005, 0.014);

      noiseSource(ctx, time, 0.03).connect(bp);
      // Deliberately joins AFTER the saturator. Distorting a broadband
      // transient turns a click into a splat; the saturation is there to give
      // the fundamental harmonics, and the click already has its own.
      bp.connect(tick).connect(output);
    }

    return output;
  };
}

/**
 * Snare: two body modes, plus wires.
 *
 * A snare drum is not one tone and noise. The top head has two strongly excited
 * modes about a fifth apart — hence two triangles at `tone` and `tone * 1.78`
 * rather than one — and the "snares" themselves are a coil of wire rattling
 * against the bottom head, which is a separate, brighter, longer sound with its
 * own envelope. Modelling them separately is the difference between a snare and
 * a hand clap on a drum.
 */
function makeSnare({
  tone, noiseDecay, toneDecay, bandpass, wires = 0.9,
  q = 1.2, level = 1.0, pan = 0,
}) {
  return (ctx, dest, time, velocity) => {
    const output = out(ctx, dest, level * velocity, pan);

    // Body — the two membrane modes.
    if (tone) {
      for (const [ratio, weight] of [[1, 0.5], [1.78, 0.28]]) {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        const f = vary(tone * ratio, 0.02);
        pitchEnv(osc.frequency, time, f, f * 0.72, toneDecay);

        const g = ctx.createGain();
        percEnv(g.gain, time, weight, 0.002, toneDecay * (ratio > 1 ? 0.7 : 1));

        osc.connect(g).connect(output);
        osc.start(time);
        osc.stop(time + toneDecay + 0.05);
      }
    }

    // Wires — high, bright, and the part that rides velocity hardest, because
    // it is what actually changes when a drummer hits harder.
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
 * Clap: several very short noise bursts a few milliseconds apart, then a
 * longer tail. The stagger is what makes it read as many hands rather than one
 * — a single burst sounds like a snare.
 *
 * The burst spacing is now jittered per hit. Evenly spaced bursts are a comb
 * filter: they cancel and reinforce at fixed frequencies and give the clap a
 * hollow, metallic ring that no amount of filtering removes. Real hands are
 * never that punctual, and a few percent of scatter is enough to smear the comb
 * into something that sounds like a room full of people.
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
 * Metallic voice: hats, ride and crash.
 *
 * All three are the same instrument in the model's terms — a struck plate — and
 * differ only in how the bank is filtered and how long it is allowed to ring.
 * A closed hat is 45 ms, an open hat is 420, a crash is nearly two seconds; the
 * decay is essentially the entire perceptual difference, which is why the
 * physical instrument really is one pair of cymbals opening and closing.
 *
 * The highpass is what removes the squares' fundamentals and leaves only the
 * clatter above them. Without it the bank sounds like a broken organ chord.
 */
function makeMetal({
  highpass, bandpass = 0, decay, tune = 1, q = 1.4,
  swell = 0, level = 1.0, pan = 0,
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
      // A crash does not start at its loudest. The plate takes a few tens of
      // milliseconds to reach full amplitude as the strike energy spreads
      // across it, and skipping that makes a cymbal sound like a gunshot.
      percEnv(env.gain, time, 0.5, swell, length);
    } else {
      percEnv(env.gain, time, 0.5, 0.001, length);
    }

    node.connect(env).connect(output);

    oscBank(ctx, hp, time, length, tune);

    // A thin layer of noise under the partials. A real cymbal has broadband
    // content from the strike itself; the bank alone is a little too tidy.
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
 * Cowbell: two of the same six partials, hard bandpassed.
 *
 * Kept as its own constructor rather than folded into makeMetal because the
 * point is the narrowness — two partials, not six — and expressing that as
 * "makeMetal with four of them removed" would hide what makes it a cowbell.
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
 * Rim shot: a stick striking the hoop. Almost no body, all click.
 *
 * Two very short high partials plus a noise tick, and a decay measured in
 * hundredths of a second. The velocity response is deliberately shallow: a rim
 * click is a nearly binary sound and modelling it as a smooth gradient makes it
 * mushy.
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
 * Tom: a kick's pitch sweep, opened out and given a skin.
 *
 * The difference between a tom and a low kick is mostly the sweep depth — a
 * kick falls most of an octave in 50 ms, a tom barely a third over 140 — plus a
 * short noise attack for the stick on the head. No saturation: a tom is
 * supposed to be round, and the harmonics that rescue a kick on a small speaker
 * make a tom sound like a cardboard box.
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
    // The filter chases the oscillator down. Sweeping both together is what
    // makes it read as one object moving rather than as a tone and a filter.
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

// ---------------------------------------------------------------------------
// The bank
//
// Order matters: index 0-15 maps to the 4x4 grid left-to-right, top-to-bottom,
// which is the same order as the keyboard map in phase 3 (1234/qwer/asdf/zxcv)
// and the same order the pad meshes are built in phase 2.
//
// The `hue` values colour-code the kit by family, one hue per row (row 1 splits
// into two, because kicks and backbeat are genuinely different jobs). They were
// respaced in phase 9: the original set put 0.02, 0.09 and 0.14 within a twelfth
// of the wheel of each other, so three of the four rows lit up as variations on
// orange and the grid could not be read at a glance. Row 2 moved to green and
// row 4 to a cleaner magenta, which spreads the adjacent gaps to roughly a fifth
// of the wheel each.
//
// Perceived brightness is NOT balanced here — palette.js solves the lightness of
// each hue so every row emits at the same luminance. Hue is a property of the
// kit; brightness is a property of the display, and they belong in different
// files.
//
// The `pan` values are a mixing decision, not a synthesis one, and they follow
// the convention of a drum kit seen from the drummer's seat: kick and snare
// dead centre because they carry the pulse and anything off-centre in the low
// end unbalances the whole mix, toms sweeping left to right as they rise in
// pitch, cymbals wide.
// ---------------------------------------------------------------------------

export const PADS = [
  // Row 1 — kicks and backbeat
  { id: 'kick_deep',   label: 'Kick Deep',  hue: 0.02, voice: makeKick({ from: 150, to: 42, sweep: 0.09, decay: 0.50, click: 0.45, drive: 2.4 }) },
  { id: 'kick_tight',  label: 'Kick Tight', hue: 0.02, voice: makeKick({ from: 180, to: 58, sweep: 0.05, decay: 0.26, click: 0.70, drive: 2.0 }) },
  { id: 'snare',       label: 'Snare',      hue: 0.09, voice: makeSnare({ tone: 190, noiseDecay: 0.16, toneDecay: 0.10, bandpass: 1900 }) },
  { id: 'clap',        label: 'Clap',       hue: 0.09, voice: makeClap({ pan: 0.18 }) },

  // Row 2 — toms and rim
  { id: 'rim',         label: 'Rim',        hue: 0.30, voice: makeRim({ pan: -0.22 }) },
  { id: 'tom_low',     label: 'Tom Low',    hue: 0.30, voice: makeTom({ from: 130, to: 78,  sweep: 0.14, decay: 0.34, pan: -0.30 }) },
  { id: 'tom_mid',     label: 'Tom Mid',    hue: 0.30, voice: makeTom({ from: 190, to: 115, sweep: 0.13, decay: 0.30, pan: 0.00 }) },
  { id: 'tom_high',    label: 'Tom High',   hue: 0.30, voice: makeTom({ from: 265, to: 160, sweep: 0.12, decay: 0.26, pan: 0.30 }) },

  // Row 3 — cymbals
  { id: 'hat_closed',  label: 'Hat Closed', hue: 0.52, chokeGroup: 'hh', voice: makeMetal({ highpass: 7800, decay: 0.045, tune: 1.0, level: 0.55, pan: 0.26 }) },
  { id: 'hat_open',    label: 'Hat Open',   hue: 0.52, chokeGroup: 'hh', voice: makeMetal({ highpass: 6600, decay: 0.42,  tune: 1.0, level: 0.50, pan: 0.26 }) },
  { id: 'ride',        label: 'Ride',       hue: 0.52, voice: makeMetal({ highpass: 4200, bandpass: 5200, q: 1.1, decay: 0.90, tune: 1.32, level: 0.42, pan: -0.34 }) },
  { id: 'crash',       label: 'Crash',      hue: 0.52, voice: makeMetal({ highpass: 3000, decay: 1.90, tune: 0.86, swell: 0.020, level: 0.40, pan: 0.40 }) },

  // Row 4 — percussion and effects
  { id: 'perc_click',  label: 'Click',      hue: 0.78, voice: makeClick({ pan: -0.15 }) },
  { id: 'cowbell',     label: 'Cowbell',    hue: 0.78, voice: makeCowbell({ pan: 0.22 }) },
  { id: 'zap',         label: 'Zap',        hue: 0.78, voice: makeZap({ pan: -0.28 }) },
  { id: 'sub_drop',    label: 'Sub Drop',   hue: 0.78, voice: makeKick({ from: 110, to: 28, sweep: 0.55, decay: 0.80, click: 0, drive: 1.6 }) },
];

/** id -> pad definition, for lookup by name. */
export const PAD_BY_ID = new Map(PADS.map((p) => [p.id, p]));

/** id -> 0..15 grid index, used by the geometry and the keyboard map. */
export const PAD_INDEX = new Map(PADS.map((p, i) => [p.id, i]));