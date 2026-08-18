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
// The layout
//
// Sixteen SLOTS, each a role rather than a sound. Order matters: index 0-15
// maps to the 4x4 grid left-to-right, top-to-bottom, which is the same order
// as the keyboard map (1234/qwer/asdf/zxcv) and the same order the pad meshes
// are built in.
//
// WHAT BELONGS TO THE LAYOUT AND WHAT BELONGS TO THE KIT
//
// This split is the whole design of the kit system and it is what makes
// switching kits safe. A slot's `id`, `hue`, `pan` and choke group are
// properties of the INSTRUMENT — where the pad sits, what colour it lights,
// where it sits in the stereo field, which pair of cymbals it belongs to. A
// slot's `label` and `voice` are properties of the KIT — what sound is loaded
// into that pad today.
//
// Because the ids never change, a pattern recorded in one kit plays correctly
// in every other kit. That is not a happy accident, it is the reason the split
// exists: you can record a groove with the studio kit, switch to techno
// mid-bar, and hear the same rhythm in different sounds with the sequencer
// none the wiser. It also means rig.js needs no rebuild on a kit change, since
// every hue and every printed key letter is unchanged.
//
// The `hue` values colour-code by family, one hue per row (row 1 splits,
// because kicks and backbeat are genuinely different jobs). They were respaced
// in phase 9: the original set put three rows within a twelfth of the wheel of
// each other and the grid could not be read at a glance.
//
// Perceived brightness is NOT balanced here — palette.js solves the lightness
// of each hue so every row emits at the same luminance. Hue is a property of
// the kit's layout; brightness is a property of the display, and they belong
// in different files.
//
// The `pan` values follow the convention of a kit seen from the drummer's
// seat: kick and snare dead centre because they carry the pulse and anything
// off-centre in the low end unbalances the mix, toms sweeping left to right as
// they rise, cymbals wide.
// ---------------------------------------------------------------------------

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

  // Row 3 — cymbals. The two hats share a choke group in every kit, because
  // that is a physical fact about a pair of cymbals rather than a stylistic
  // one: they cannot be open and closed at the same instant.
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

// ---------------------------------------------------------------------------
// The kits
//
// Four sets of sixteen voices over one layout. Each kit gives every slot a
// label and a synthesis recipe, and nothing else — no kit may move a pad,
// recolour it, or change what choke group it is in.
//
// These are not four random collections. Each is built around what the genre
// actually asks of a drum machine, and the differences are in the SYNTHESIS
// parameters rather than in which constructors are used, which is the point of
// having parameterised constructors at all (D15). Every voice below is one of
// the same nine recipes with different numbers.
// ---------------------------------------------------------------------------

/**
 * STUDIO — the acoustic-leaning original. Sampled-kit character: short decays,
 * moderate drive, membranes that sound like membranes.
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
  hat_closed: ['Hat Closed', makeMetal({ highpass: 7800, decay: 0.045, tune: 1.0, level: 0.55 })],
  hat_open:   ['Hat Open',   makeMetal({ highpass: 6600, decay: 0.42,  tune: 1.0, level: 0.50 })],
  ride:       ['Ride',       makeMetal({ highpass: 4200, bandpass: 5200, q: 1.1, decay: 0.90, tune: 1.32, level: 0.42 })],
  crash:      ['Crash',      makeMetal({ highpass: 3000, decay: 1.90, tune: 0.86, swell: 0.020, level: 0.40 })],
  perc_click: ['Click',      makeClick({})],
  cowbell:    ['Cowbell',    makeCowbell({})],
  zap:        ['Zap',        makeZap({})],
  sub_drop:   ['Sub Drop',   makeKick({ from: 110, to: 28, sweep: 0.55, decay: 0.80, click: 0, drive: 1.6 })],
};

/**
 * REGGAETÓN — the dembow kit.
 *
 * The defining sounds are not the kick and snare at all: they are the TIMBALE
 * and the CAMPANA. So the two tom slots become timbales — short, high, barely
 * swept, because a timbale shell is shallow and metal-rimmed and does not
 * pitch-bend the way a floor tom does — and the cowbell is retuned up and
 * lengthened, since in this style it is a lead voice rather than a garnish.
 *
 * The kick is round and short with almost no click: dembow puts the kick and
 * the snare a sixteenth apart constantly, and a long clicky kick smears into
 * the snare that follows it. The clap is wide and bright because the snare in
 * this music is usually a layered clap-and-rim rather than a struck drum.
 *
 * Hats are dark and soft — the top end in this genre belongs to the güiro and
 * the shaker, which is what the click slot becomes.
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
  hat_closed: ['Hat Soft',   makeMetal({ highpass: 6800, decay: 0.038, tune: 0.94, level: 0.42 })],
  hat_open:   ['Hat Loose',  makeMetal({ highpass: 5600, decay: 0.30, tune: 0.94, level: 0.38 })],
  ride:       ['Cascara',    makeMetal({ highpass: 3400, bandpass: 4200, q: 2.2, decay: 0.30, tune: 1.5, level: 0.40 })],
  crash:      ['Crash',      makeMetal({ highpass: 2600, decay: 1.60, tune: 0.80, swell: 0.018, level: 0.42 })],
  // A güiro scrape: broadband noise with the low end taken out, long enough to
  // read as a stroke across the ridges rather than as a tick.
  perc_click: ['Guiro',      makeClick({ highpass: 1800, decay: 0.075, level: 0.55 })],
  cowbell:    ['Campana',    makeCowbell({ a: 620, b: 925, decay: 0.42, level: 1.0 })],
  zap:        ['Riser',      makeZap({ from: 300, to: 1400, sweep: 0.30, decay: 0.34, level: 0.6 })],
  sub_drop:   ['Sub',        makeKick({ from: 90, to: 38, sweep: 0.30, decay: 0.60, click: 0, drive: 1.4 })],
};

/**
 * TECHNO — the 909-derived kit.
 *
 * Everything is longer, louder and more saturated. The kick is the whole
 * record: a long decay with heavy drive, so it occupies the bar rather than
 * punctuating it, and the sweep is slow because a 909 kick's pitch envelope is
 * what gives it the "thump into hum" shape that survives on a big system.
 *
 * The hats are the other half of the identity, and they are bright to the
 * point of being harsh — a 909 hat is six square waves through a highpass, and
 * the tune value here pushes the partial bank up so it sits above everything
 * else in the mix rather than inside it.
 *
 * The clap has a long tail because it is doing the job a reverb would, and the
 * zap becomes an acid blip: a fast downward sweep that reads as a resonant
 * filter being plucked.
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
  hat_closed: ['Hat Tight',  makeMetal({ highpass: 9200, decay: 0.032, tune: 1.18, level: 0.60 })],
  hat_open:   ['Hat Open',   makeMetal({ highpass: 7600, decay: 0.60, tune: 1.18, level: 0.52 })],
  ride:       ['Ride Bell',  makeMetal({ highpass: 5200, bandpass: 6800, q: 1.6, decay: 1.10, tune: 1.44, level: 0.40 })],
  crash:      ['Crash Big',  makeMetal({ highpass: 2800, decay: 2.60, tune: 0.82, swell: 0.028, level: 0.44 })],
  perc_click: ['Tick',       makeClick({ highpass: 4200, decay: 0.012, level: 0.75 })],
  cowbell:    ['Cowbell',    makeCowbell({ a: 587, b: 845, decay: 0.26, level: 0.9 })],
  zap:        ['Acid Blip',  makeZap({ from: 1600, to: 180, sweep: 0.09, decay: 0.24, level: 0.85 })],
  sub_drop:   ['Sub Rumble', makeKick({ from: 70, to: 32, sweep: 0.80, decay: 1.40, click: 0, drive: 1.3 })],
};

/**
 * DRILL — the 808 kit.
 *
 * The organising fact of this style is that the KICK AND THE BASS ARE THE SAME
 * SOUND. An 808 is a long sine with a pitch envelope, played melodically, and
 * it sits in the slot a bassline would occupy. So `sub_drop` becomes a long
 * gliding 808 with a 1.6-second decay and a wide sweep, and the kicks above it
 * are short and clicky — their job is the transient, with the 808 carrying the
 * weight underneath.
 *
 * The hats are the other signature: drill rolls run at 32nd and 64th
 * subdivisions, so the closed hat has to be very short indeed or the roll
 * becomes a wash. 22 ms, which at 140 bpm is under a sixteenth of a beat.
 *
 * The snare is thin and high because it is usually a rimshot or a clap layered
 * high above the 808 rather than a struck drum in the middle of the mix, and
 * the toms are tuned as 808 toms — sine-ish and pitched, not membranes.
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
  hat_closed: ['Hat Roll',   makeMetal({ highpass: 8600, decay: 0.022, tune: 1.10, level: 0.50 })],
  hat_open:   ['Hat Open',   makeMetal({ highpass: 7000, decay: 0.24, tune: 1.10, level: 0.44 })],
  ride:       ['Ride Dark',  makeMetal({ highpass: 3600, bandpass: 4600, q: 1.3, decay: 0.70, tune: 1.16, level: 0.36 })],
  crash:      ['Crash Dark', makeMetal({ highpass: 2400, decay: 1.70, tune: 0.74, swell: 0.024, level: 0.38 })],
  perc_click: ['Stick',      makeClick({ highpass: 3400, decay: 0.010, level: 0.65 })],
  cowbell:    ['Bell Hi',    makeCowbell({ a: 780, b: 1180, decay: 0.18, level: 0.7 })],
  zap:        ['Slide Down', makeZap({ from: 420, to: 55, sweep: 0.28, decay: 0.42, level: 0.8 })],
  // The 808 proper: nearly two seconds, no click at all, and a long glide.
  sub_drop:   ['808 Slide',  makeKick({ from: 130, to: 30, sweep: 0.70, decay: 1.60, click: 0, drive: 1.5 })],
};

/**
 * The kit table. `bpm` is the tempo the style lives at, offered when the kit is
 * chosen rather than forced — switching kits should not silently retempo a
 * pattern somebody is in the middle of recording.
 */
export const KITS = [
  { id: 'studio',    name: 'Studio',     bpm: 92,  description: 'Acoustic-leaning kit. Short decays, real membranes.', voices: STUDIO },
  { id: 'reggaeton', name: 'Reggaetón',  bpm: 96,  description: 'Dembow kit: timbales, campana, güiro, round kick.', voices: REGGAETON },
  { id: 'techno',    name: 'Techno',     bpm: 132, description: '909-derived. Long saturated kick, harsh hats, acid blip.', voices: TECHNO },
  { id: 'drill',     name: 'Drill',      bpm: 142, description: '808 kit. Gliding sub bass, 22 ms hat for rolls.', voices: DRILL },
];

export const KIT_BY_ID = new Map(KITS.map((k) => [k.id, k]));

/**
 * Merge the layout with a kit's voices into the sixteen pad definitions.
 *
 * The `pan` from the layout is injected into the voice at BUILD time rather
 * than being passed by each kit, which is why no kit above writes a pan value:
 * stereo placement is a property of where the pad sits on the instrument, and
 * letting a kit override it would let one kit put its snare off-centre and
 * quietly break the mix in a way nobody would think to look for.
 */
/**
 * Wrap a voice so its output passes through a panner on the way to the bus.
 *
 * The constructors each take a `pan` option and build their own panner, which
 * worked when the pan value was written next to the recipe. Now that pan
 * belongs to the layout and the recipe belongs to the kit, the two are
 * assembled from different places, so the placement is applied here instead —
 * a panner in front of whatever destination the caller passed, with the voice
 * rendered into it.
 *
 * One extra node per hit, built and discarded with the rest of the graph,
 * which is the pattern every voice already follows (D16). Centre-panned slots
 * skip the wrapper entirely rather than building a panner set to zero.
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

// ---------------------------------------------------------------------------
// The active kit
//
// `PADS`, `PAD_BY_ID` and `PAD_INDEX` are `let` rather than `const`, which is
// unusual enough to justify.
//
// ES module bindings are LIVE: an importer holds a reference to the binding,
// not a copy of the value, so reassigning here updates every module that
// imported it — rig.js, audio.js, interaction.js, mascot.js and sequencer.js
// all see the new kit with no notification and no re-import. That is exactly
// the behaviour wanted, and it is a property of the module system rather than
// a trick: there is one authoritative kit and everybody reads it.
//
// The alternative was a getter function called at every use site, which would
// mean editing five modules to ask for something they already have.
//
// Note what does NOT change on a kit switch: ids, hues, pan, choke groups,
// grid positions and key letters. So no geometry is rebuilt, no material is
// re-tinted, and every pattern in every layer keeps playing.
// ---------------------------------------------------------------------------

let activeKit = KITS[0];

export let PADS = buildKit(activeKit);
export let PAD_BY_ID = new Map(PADS.map((p) => [p.id, p]));
export let PAD_INDEX = new Map(PADS.map((p, i) => [p.id, i]));

export function getKit() { return activeKit; }

/**
 * Swap the loaded kit.
 *
 * Takes effect on the NEXT hit, not on notes already scheduled: `playVoice`
 * looks the pad up at the moment it builds the node graph, and the scheduler
 * commits up to 100 ms ahead. So a kit change lands within a sixteenth at any
 * sensible tempo, and the handful of notes already promised to the audio clock
 * finish in the old kit rather than being cancelled — which is both easier and
 * more musical than trying to rewrite committed events.
 *
 * @returns {object | null} the kit now loaded
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