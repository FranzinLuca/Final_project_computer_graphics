/**
 * audio.js — context, transport, scheduler, layers, recording.
 *
 * This module must never import from rig.js, hierarchy.js or anything that
 * touches Three.js. It imports the event bus (which is dependency-free
 * infrastructure) and the pad bank, nothing else. It can be driven entirely
 * from the browser console with no visuals present.
 *
 * Signal path:
 *
 *   scheduled hit -> layer[i].output --\
 *                                       >-- master -> drive -> space -> tone
 *   live hit --------------------------/                                  |
 *                                                                  destination
 *
 * Live hits bypass the layers deliberately: pressing a pad should always be
 * audible, even if the layer you are recording into is muted.
 *
 * The filter sits after the master gain so that phase 5's analyser, which will
 * tap masterFilter's output, sees exactly what reaches the speakers — close
 * the filter and the lights should dim with the sound.
 */

import { bus } from './events.js';
import { PADS, PAD_BY_ID } from './pads.js';

// ---------------------------------------------------------------------------
// Context and master bus
// ---------------------------------------------------------------------------

/** @type {AudioContext | null} */
let ctx = null;
/** @type {GainNode | null} */
let master = null;
/** @type {BiquadFilterNode | null} */
let masterFilter = null;

/**
 * The drive stage: a fixed waveshaper with a variable gain in front of it.
 *
 * This is the whole trick, and it is worth stating because the obvious
 * implementation is worse in a way that is not obvious. A WaveShaperNode's
 * curve is a static array — changing the amount of distortion by rebuilding
 * the curve means allocating and uploading a few thousand floats on every
 * frame the knob moves, and the discontinuity between the old curve and the
 * new one is audible as a tick.
 *
 * A saturator is a fixed non-linearity; how much you distort is how hard you
 * HIT it. So the curve is built once as a tanh and never touched, and the knob
 * drives `drivePre` — a plain gain that pushes the signal further up the
 * curve's shoulder. `driveMakeup` takes the level back out afterwards, so
 * turning the knob changes the character without changing the loudness, which
 * is the difference between a distortion control and a volume control that
 * happens to clip.
 */
/** @type {GainNode | null} */
let drivePre = null;
/** @type {WaveShaperNode | null} */
let driveShaper = null;
/** @type {GainNode | null} */
let driveMakeup = null;

/** The space send: two delay taps with a shared feedback path. */
/** @type {GainNode | null} */
let spaceSend = null;
/** @type {GainNode | null} */
let spaceReturn = null;

export function getContext() { return ctx; }
export function getMaster() { return master; }
export function getMasterFilter() { return masterFilter; }

/**
 * Create and unlock the AudioContext. Must be called from inside a user
 * gesture handler or the context stays suspended and the project is silent.
 */
export async function initAudio() {
  if (!ctx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    ctx = new Ctor({ latencyHint: 'interactive' });

    master = ctx.createGain();
    master.gain.value = 0.8;

    masterFilter = ctx.createBiquadFilter();
    masterFilter.type = 'lowpass';
    masterFilter.frequency.value = FILTER_MAX;
    masterFilter.Q.value = Q_MIN;

    // --- drive ----------------------------------------------------------
    drivePre = ctx.createGain();
    drivePre.gain.value = 1;

    driveShaper = ctx.createWaveShaper();
    driveShaper.curve = saturationCurve();
    /**
     * Oversampling is not optional on a waveshaper.
     *
     * A non-linearity generates harmonics above the input's own bandwidth, and
     * anything above Nyquist folds back down as inharmonic aliasing — which on
     * a drum kit lands as a metallic ring under every hit that gets worse the
     * harder you drive. '4x' runs the shaper at four times the sample rate and
     * filters before decimating, which pushes the fold-back point two octaves
     * out of the way.
     */
    driveShaper.oversample = '4x';

    driveMakeup = ctx.createGain();
    driveMakeup.gain.value = 1;

    // --- space ------------------------------------------------------------
    //
    // Two delay taps at incommensurate times with a shared feedback loop and a
    // lowpass inside it. This is not a reverb and does not claim to be: a real
    // reverb needs either a convolution (which needs an impulse response file,
    // and the project has no audio assets) or a dozen-odd allpass and comb
    // stages. What it is, is the thing those stages are made of — a damped
    // recirculating delay — and two taps at 131 and 187 ms are far enough from
    // any simple ratio that the repeats never line up into an audible pulse.
    //
    // The lowpass in the FEEDBACK path rather than after it is what makes it
    // read as a room: each pass around the loop loses more top end, so the
    // tail darkens as it decays, which is exactly what air and soft surfaces
    // do to a sound and what a bare delay conspicuously fails to do.
    spaceSend = ctx.createGain();
    spaceSend.gain.value = 0;

    spaceReturn = ctx.createGain();
    spaceReturn.gain.value = 0.9;

    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 2600;

    const feedback = ctx.createGain();
    feedback.gain.value = 0.34;

    for (const time of [0.131, 0.187]) {
      const tap = ctx.createDelay(0.5);
      tap.delayTime.value = time;
      spaceSend.connect(tap);
      tap.connect(damp);
    }

    damp.connect(feedback);
    feedback.connect(spaceSend);   // the recirculation
    damp.connect(spaceReturn);

    // --- wiring -----------------------------------------------------------
    master.connect(drivePre);
    drivePre.connect(driveShaper);
    driveShaper.connect(driveMakeup);

    driveMakeup.connect(masterFilter);   // dry
    driveMakeup.connect(spaceSend);      // send
    spaceReturn.connect(masterFilter);   // return

    masterFilter.connect(ctx.destination);

    buildLayers();
  }

  if (ctx.state === 'suspended') await ctx.resume();
  return ctx;
}

// ---------------------------------------------------------------------------
// Master controls
// ---------------------------------------------------------------------------

const FILTER_MIN = 140;    // Hz
const FILTER_MAX = 18000;  // Hz

const Q_MIN = 0.7;         // flat, no audible peak
const Q_MAX = 14;          // resonant but not self-oscillating

/**
 * Master volume, 0..1.
 *
 * setTargetAtTime rather than assigning .value: an instantaneous jump in gain
 * is a step discontinuity in the waveform, which is audible as a click. The
 * third argument is a time constant, so the gain glides to the new value over
 * roughly 30ms — fast enough to feel immediate, slow enough to be silent.
 */
export function setMasterVolume(value) {
  if (!master) return;
  const v = Math.min(1, Math.max(0, value));
  master.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
}

/**
 * Master lowpass cutoff, from a 0..1 knob position.
 *
 * The mapping is exponential, not linear. Pitch perception is logarithmic — the
 * musical distance from 140Hz to 280Hz is one octave, the same as 9kHz to
 * 18kHz — so a linear map would spend the bottom 1% of the knob's travel on
 * everything you can hear moving and the remaining 99% on almost nothing.
 * Interpolating in the exponent gives every part of the sweep equal musical
 * weight.
 *
 *   f(t) = min * (max/min)^t
 */
export function setMasterFilter(value) {
  if (!masterFilter) return;
  const t = Math.min(1, Math.max(0, value));
  const freq = FILTER_MIN * Math.pow(FILTER_MAX / FILTER_MIN, t);
  masterFilter.frequency.setTargetAtTime(freq, ctx.currentTime, 0.02);
}

/**
 * Master resonance, from a 0..1 knob position.
 *
 * `Q` on a biquad lowpass is the height of the peak at the cutoff, and it is
 * exponential in perception exactly as frequency is: 0.7 to 1.4 is barely
 * anything, 7 to 14 is the difference between a filter and a whistle. Mapped
 * in the exponent for the same reason the cutoff is.
 *
 * Capped at 14 rather than at the 1000 the API allows, and that ceiling is a
 * safety limit rather than taste. A high-Q lowpass has enormous gain at the
 * cutoff — a resonant peak at Q = 40 adds over 30 dB — and with the filter
 * sitting on the master bus that is a clipped output and, on headphones, a
 * genuinely unpleasant one. The control cannot reach a setting that damages
 * the mix.
 */
export function setMasterResonance(value) {
  if (!masterFilter) return;
  const t = Math.min(1, Math.max(0, value));
  const q = Q_MIN * Math.pow(Q_MAX / Q_MIN, t);
  masterFilter.Q.setTargetAtTime(q, ctx.currentTime, 0.02);
}

/**
 * Drive, from a 0..1 knob position.
 *
 * Pre-gain rises to 12x, which is 21 dB into the shoulder of the tanh — well
 * past the point where the curve stops being a straight line and starts
 * rounding transients off. Makeup falls as the reciprocal of roughly the
 * compression that produces, so the knob is close to level-matched end to end:
 * at 0 it is clean, at 1 it is thick, and it is NOT simply louder, which is
 * the trap every naive distortion control falls into and the reason people
 * think distortion "sounds better" when it is only louder.
 */
export function setMasterDrive(value) {
  if (!drivePre) return;
  const t = Math.min(1, Math.max(0, value));
  drivePre.gain.setTargetAtTime(1 + t * 11, ctx.currentTime, 0.02);
  driveMakeup.gain.setTargetAtTime(1 / (1 + t * 2.4), ctx.currentTime, 0.02);
}

/**
 * Space, from a 0..1 knob position.
 *
 * A SEND level, not a wet/dry mix. The dry path is untouched, so turning this
 * up adds ambience rather than trading the direct sound away for it — which
 * matters on percussion more than on anything else, because the transient IS
 * the sound and a crossfade to wet destroys it.
 *
 * Squared, so the bottom half of the travel covers the range from "dry" to
 * "there is a room", which is where all the useful settings are. Linear here
 * would put every usable value in the first fifth of the knob.
 */
export function setMasterSpace(value) {
  if (!spaceSend) return;
  const t = Math.min(1, Math.max(0, value));
  spaceSend.gain.setTargetAtTime(t * t * 0.85, ctx.currentTime, 0.03);
}

/**
 * The tanh saturation curve, built once.
 *
 * `tanh` rather than a hard clip: it is smooth everywhere, so its harmonic
 * series rolls off instead of extending forever, and it approaches its limit
 * asymptotically so nothing ever lands on a flat top. Odd-symmetric, which
 * means it generates only odd harmonics — the third and fifth — and that is
 * the sound people mean by "warm" rather than "buzzy".
 *
 * 2048 points is far more than needed for audio-rate interpolation and costs
 * 8 KB once.
 */
function saturationCurve(points = 2048) {
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 2.2) / Math.tanh(2.2);
  }
  return curve;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const LOOKAHEAD_MS = 25;          // how often the planner wakes up
const SCHEDULE_AHEAD = 0.1;       // how far ahead it commits notes, in seconds

/**
 * Pattern length, in sixteenths. Now variable, where it was a fixed 16.
 *
 * "I cannot make long recordings" was limitation 5 in the decisions log, filed
 * as "nothing in the maths assumes 16, but nothing exposes it either". This
 * exposes it. Every timing question in this file is answered from
 * `startTime + n * secondsPerStep()`, and the length only ever appears as the
 * modulus that wraps an absolute step into a pattern index — so lengthening
 * the loop genuinely is one variable, and the claim in that log entry gets
 * tested rather than asserted.
 *
 * Restricted to whole bars of 4/4 rather than any integer. A 23-step loop is
 * expressible and is not a bar, so a recording made against it could never be
 * combined with a preset or with another layer; keeping every layer a whole
 * number of bars is what lets four patterns of different lengths play together
 * and still line up at the top.
 */
export const PATTERN_LENGTHS = [16, 32, 64];   // 1, 2 and 4 bars
export const DEFAULT_PATTERN_LENGTH = 16;

let patternLength = DEFAULT_PATTERN_LENGTH;

export function getPatternLength() { return patternLength; }

/** Steps per bar, fixed. Used for the count-in and the bar readout. */
export const STEPS_PER_BAR = 16;

let bpm = 100;
let running = false;

/**
 * Swing, 0..1, mapped to a delay on every odd sixteenth.
 *
 * The most musical of the six knobs and the one with the most to say at the
 * oral, because it is a change to the SCHEDULER rather than to the signal.
 *
 * Straight sixteenths are mathematically even and rhythmically dead: every
 * groove a human plays pushes the off-beats later, and the amount is what
 * separates one genre from another. So odd steps are delayed by a fraction of
 * a step:
 *
 *   time(n) = startTime + n * spb + (n odd ? swing * spb * 0.62 : 0)
 *
 * 0.62 rather than 1.0 as the ceiling, because at a full step of delay the odd
 * note lands exactly on the even one after it and the pattern collapses to
 * eighths. The classic MPC maximum is triplet feel, which is 2/3 — the odd
 * note two thirds of the way through the pair. A shade under that is the
 * whole useful range.
 *
 * TWO PROPERTIES WORTH CHECKING, both of which hold:
 *
 *   Monotonicity. The offset is non-negative and strictly under one step, so
 *   step n + 1 can never be scheduled before step n. The scheduler's `while`
 *   loop still walks forward in time and never has to sort.
 *
 *   Recording is unaffected. `quantizeToStep` measures against the STRAIGHT
 *   grid, deliberately. A recorded hit is stored on the beat it was aimed at,
 *   and swing is applied on the way out — so changing the swing after
 *   recording re-feels the existing pattern instead of gradually dragging it
 *   out of time, and turning swing back to zero restores exactly what was
 *   played. Baking the offset into the stored step would make the operation
 *   lossy and non-reversible.
 */
let swing = 0;

/**
 * Audio-clock time of absolute step 0. Every step in the piece sits at
 * startTime + n * secondsPerStep(), and every timing question in this file is
 * answered from that one equation.
 */
let startTime = 0;

/** Next absolute step the scheduler has yet to commit. Monotonic, never wraps. */
let absStep = 0;

/** @type {number | null} setInterval handle for the planner. */
let timer = null;

export function secondsPerStep() {
  return 60 / bpm / 4; // 4 sixteenths per beat
}

export function getBpm() { return bpm; }
export function isRunning() { return running; }

/**
 * Change tempo without losing the beat.
 *
 * Naively assigning bpm would move every step, because step positions are
 * derived from startTime. Rebasing startTime so the next scheduled step keeps
 * its current audio time means the change takes effect going forward and
 * everything already committed still lands where it was promised.
 */
export function setBpm(next) {
  const clamped = Math.min(200, Math.max(40, next));
  if (running) {
    const nextTime = startTime + absStep * secondsPerStep();
    bpm = clamped;
    startTime = nextTime - absStep * secondsPerStep();
  } else {
    bpm = clamped;
  }
  bus.emit('transport:bpm', { bpm });
}

export function setSwing(value) {
  swing = Math.min(1, Math.max(0, value));
  bus.emit('transport:swing', { swing });
}

export function getSwing() { return swing; }

/** How late absolute step `n` sounds, in seconds. Zero on the even steps. */
function swingOffset(n, spb) {
  return (n % 2 === 1) ? swing * spb * 0.62 : 0;
}

export function start() {
  if (!ctx || running) return;
  running = true;
  absStep = 0;
  startTime = ctx.currentTime + 0.06; // small cushion so step 0 isn't already past
  timer = setInterval(planner, LOOKAHEAD_MS);
  bus.emit('transport:start', { startTime });
}

export function stop() {
  if (!running) return;
  running = false;
  clearInterval(timer);
  timer = null;
  pending.length = 0;

  // Stopping the transport ends capture but does NOT disarm. The layer stays
  // selected for recording, so pressing play again resumes into the same one
  // rather than silently dropping the choice — which is what "I lost track of
  // which layer I was recording into" felt like from the other side.
  if (capturing) {
    capturing = false;
    bus.emit('record:stop', getRecordState());
  }

  bus.emit('transport:stop', {});
}

export function toggle() { running ? stop() : start(); }

// ---------------------------------------------------------------------------
// The lookahead scheduler
// ---------------------------------------------------------------------------

/**
 * Runs every ~25ms on the main thread. It never plays anything itself — it
 * commits notes to the audio clock, which is immune to main-thread jitter.
 *
 * Because every step time is computed as startTime + n * secondsPerStep
 * rather than accumulated (nextTime += step), floating-point error cannot
 * build up over a long session.
 */
function planner() {
  if (!ctx || !running) return;

  const horizon = ctx.currentTime + SCHEDULE_AHEAD;
  const spb = secondsPerStep();

  // The loop bound uses the STRAIGHT time, not the swung one. Bounding on the
  // swung time would make the horizon breathe with the swing knob, and a
  // horizon that shrinks when a control moves is a horizon that can skip a
  // step at the moment it changes.
  while (startTime + absStep * spb < horizon) {
    const time = startTime + absStep * spb + swingOffset(absStep, spb);
    scheduleStep(absStep, time);
    absStep++;
  }
}

/**
 * Commit one absolute step to the audio clock.
 *
 * The step index is wrapped PER LAYER, against that layer's own pattern
 * length, rather than once against a global. That is what allows a two-bar
 * fill on layer 4 to run under a one-bar loop on layers 1 to 3 and come back
 * round together — each layer wraps on its own modulus and they realign at the
 * least common multiple, which for whole-bar lengths is always a whole number
 * of bars.
 *
 * The count-in is handled here rather than by gating `start()`, because the
 * count-in is not a different mode of the transport: it is the ordinary
 * transport with recording not yet capturing and a click on each beat. Nothing
 * about scheduling changes during it.
 */
function scheduleStep(absoluteStep, time) {
  for (const layer of layers) {
    if (layer.effectiveGain === 0) continue;
    const pattern = layer.pattern;
    const step = ((absoluteStep % pattern.length) + pattern.length) % pattern.length;
    for (const hit of pattern.steps[step]) {
      playVoice(hit.padId, layer.output, time, hit.velocity);
      queueVisual({ padId: hit.padId, time, velocity: hit.velocity, source: 'sequencer', layer: layer.index });
    }
  }

  // Count-in clicks, on the quarter notes only.
  if (armed !== null && absoluteStep < captureFromStep && absoluteStep % 4 === 0) {
    playClick(time, absoluteStep % STEPS_PER_BAR === 0);
  }

  queueVisual({
    step: ((absoluteStep % patternLength) + patternLength) % patternLength,
    absoluteStep,
    bar: Math.floor(absoluteStep / STEPS_PER_BAR),
    time,
    source: 'step',
  });
}

/**
 * Resize every layer's pattern.
 *
 * Growing pads with empty steps; shrinking truncates, and truncating is
 * DESTRUCTIVE — hits past the new end are gone. So a snapshot is taken first
 * and the operation is undoable, which is the same treatment every other
 * destructive operation in this file now gets. The alternative, refusing to
 * shrink a pattern that has content, trades a recoverable mistake for a
 * control that sometimes does nothing, and a control that sometimes does
 * nothing is worse.
 */
export function setPatternLength(next) {
  if (!PATTERN_LENGTHS.includes(next) || next === patternLength) return;

  snapshot();
  patternLength = next;

  for (const layer of layers) {
    const steps = layer.pattern.steps;
    if (next > steps.length) {
      while (steps.length < next) steps.push([]);
    } else {
      steps.length = next;
    }
    layer.pattern.length = next;
  }

  bus.emit('pattern:length', { length: patternLength });
  bus.emit('layers:changed', { layers });
}

// ---------------------------------------------------------------------------
// Deferred visual events
//
// The scheduler runs up to SCHEDULE_AHEAD seconds early. Emitting on the bus
// at schedule time would flash the LEDs 100ms before the sound. Instead,
// events go into a queue stamped with their audio time, and update() — called
// once per rendered frame from main.js — releases them when the audio clock
// catches up. Sound and light then land together.
// ---------------------------------------------------------------------------

const pending = [];

function queueVisual(event) {
  pending.push(event);
}

/** Call once per frame from the render loop. */
export function update() {
  if (!ctx) return;
  const now = ctx.currentTime;

  /**
   * The count-in ending is a state change with no event of its own in the
   * audio graph, so it is detected here — the same place scheduled visual
   * events are released, and for the same reason. Both are "the audio clock
   * has reached a moment the UI needs to know about", and both have to be
   * observed on the render thread because the audio thread cannot call into
   * JavaScript.
   */
  if (armed !== null && running && !capturing && currentAbsoluteStep() >= captureFromStep) {
    capturing = true;
    bus.emit('record:start', getRecordState());
  }

  while (pending.length && pending[0].time <= now) {
    const event = pending.shift();
    if (event.source === 'step') bus.emit('transport:step', event);
    else bus.emit('pad:hit', event);
  }
}

// ---------------------------------------------------------------------------
// Voices and choking
// ---------------------------------------------------------------------------

/** chokeGroup -> the output node of the voice currently ringing in it. */
const choking = new Map();

function playVoice(padId, dest, time, velocity) {
  const pad = PAD_BY_ID.get(padId);
  if (!pad) {
    console.warn(`[audio] unknown pad "${padId}"`);
    return;
  }

  // A closed hi-hat cuts off a ringing open one, as a real hi-hat does: both
  // sounds come from one pair of cymbals, so they cannot overlap.
  if (pad.chokeGroup) {
    const previous = choking.get(pad.chokeGroup);
    if (previous) {
      // cancelAndHoldAtTime freezes the envelope at its value at `time`
      // rather than at its value right now — which matters because `time` may
      // be up to SCHEDULE_AHEAD seconds in the future.
      if (previous.gain.cancelAndHoldAtTime) {
        previous.gain.cancelAndHoldAtTime(time);
      } else {
        previous.gain.cancelScheduledValues(time);
        previous.gain.setValueAtTime(Math.max(previous.gain.value, 0.0001), time);
      }
      previous.gain.exponentialRampToValueAtTime(0.0001, time + 0.02);
    }
  }

  const out = pad.voice(ctx, dest, time, velocity);
  if (pad.chokeGroup) choking.set(pad.chokeGroup, out);
}

/**
 * Play a pad now, from a click or a key press.
 *
 * Always audible, and additionally written into the armed layer if recording.
 */
export function trigger(padId, velocity = 1.0) {
  if (!ctx) return;
  const time = ctx.currentTime;

  playVoice(padId, master, time, velocity);
  bus.emit('pad:hit', { padId, time, velocity, source: 'live', layer: armed });

  // `capturing`, not `armed`: during the count-in the layer is armed and
  // nothing is written, which is the whole point of a count-in.
  if (capturing) recordHit(padId, velocity, time);
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

export const LAYER_COUNT = 4;

/**
 * @typedef {{ length: number, steps: Array<Array<{padId: string, velocity: number}>> }} Pattern
 */

export function emptyPattern() {
  return {
    length: patternLength,
    steps: Array.from({ length: patternLength }, () => []),
  };
}

export const layers = [];

function buildLayers() {
  for (let i = 0; i < LAYER_COUNT; i++) {
    const output = ctx.createGain();
    output.connect(master);
    layers.push({
      index: i,
      output,
      gain: 0.9,
      muted: false,
      solo: false,
      effectiveGain: 0.9,
      pattern: emptyPattern(),
    });
  }
  applyGains();
}

/**
 * Recompute every layer's output gain.
 *
 * Solo is exclusive-by-implication: if any layer is soloed, only soloed layers
 * are heard and mute is irrelevant. That is the convention on hardware and it
 * avoids the confusing state of a track being both soloed and muted.
 */
function applyGains() {
  const anySolo = layers.some((l) => l.solo);
  for (const layer of layers) {
    const audible = anySolo ? layer.solo : !layer.muted;
    layer.effectiveGain = audible ? layer.gain : 0;
    layer.output.gain.value = layer.effectiveGain;
  }
  bus.emit('layers:changed', { layers });
}

export function setLayerGain(index, gain) {
  layers[index].gain = Math.min(1, Math.max(0, gain));
  applyGains();
}

export function setMute(index, muted) {
  layers[index].muted = muted;
  applyGains();
}

export function setSolo(index, solo) {
  layers[index].solo = solo;
  applyGains();
}

export function clearLayer(index) {
  snapshot();
  layers[index].pattern = emptyPattern();
  bus.emit('layers:changed', { layers });
}

export function loadPattern(index, pattern) {
  layers[index].pattern = pattern;
  bus.emit('layers:changed', { layers });
}

/** Deep copy of all four patterns — the shape presets.js will store. */
export function exportPatterns() {
  return layers.map((l) => JSON.parse(JSON.stringify(l.pattern)));
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/** @type {number | null} index of the layer being recorded into. */
let armed = null;

/**
 * The absolute step at which capture begins. Everything before it is count-in.
 *
 * THE FOUR RECORDING BUGS WERE ALL ONE BUG: recording had no interval and no
 * visible state. You armed a layer and hits started landing at some moment you
 * could not perceive, into a loop whose boundaries you could not see, and the
 * only way out was to press the arm control four more times. Every part of
 * that is fixed by giving the operation a beginning, an end and a readout.
 *
 * THE BEGINNING is a count-in. Arming from a stopped transport starts it and
 * gives you one full bar of clicks before anything is captured — the same
 * contract every drum machine and every DAW has, and the reason it is
 * universal is that a musician cannot enter on beat one of a loop they have
 * not heard the tempo of. Arming while already running captures immediately,
 * because in that case you HAVE heard it.
 *
 * THE END is explicit. `disarm()` is one call, bound to one toggle, and it
 * stops capture without stopping playback so you can hear what you just made.
 * The cycling arm control that required four presses to switch off is gone;
 * choosing WHICH layer and choosing WHETHER to record are two decisions and
 * they now have two controls.
 */
let captureFromStep = 0;

/** True once the count-in has elapsed and hits are actually being written. */
let capturing = false;

export function isCapturing() { return capturing; }

/**
 * Everything a UI needs to draw the recording state, in one object.
 *
 * Returned as a snapshot rather than exposed as live variables, so no consumer
 * can hold a reference to engine state and start writing to it. The bus
 * carries the transitions; this answers "what is true right now" for anything
 * that arrives late — a panel built after recording has already started, for
 * instance.
 */
export function getRecordState() {
  const step = currentAbsoluteStep();
  return {
    armed,
    capturing,
    running,
    countingIn: armed !== null && running && !capturing,
    /** Whole bars of count-in remaining, rounded up. Zero once capturing. */
    countIn: capturing ? 0 : Math.max(0, Math.ceil((captureFromStep - step) / STEPS_PER_BAR)),
    step: ((Math.floor(step) % patternLength) + patternLength) % patternLength,
    bar: Math.max(0, Math.floor(step / STEPS_PER_BAR)),
    length: patternLength,
  };
}

/** Where the audio clock is now, in absolute steps. Fractional. */
function currentAbsoluteStep() {
  if (!ctx || !running) return 0;
  return (ctx.currentTime - startTime) / secondsPerStep();
}

/**
 * Arm a layer for recording.
 *
 * @param {number} index
 * @param {{ countIn?: boolean }} options
 */
export function arm(index, { countIn = true } = {}) {
  if (index === null) return disarm();

  armed = index;

  if (!running) {
    start();
    // One bar of clicks before anything is written.
    captureFromStep = countIn ? STEPS_PER_BAR : 0;
    capturing = !countIn;
  } else {
    // Already playing, so the tempo is audible and there is nothing to count
    // in for. Capture from wherever the clock is.
    captureFromStep = Math.floor(currentAbsoluteStep());
    capturing = true;
  }

  bus.emit('record:armed', { layer: armed });
  bus.emit(capturing ? 'record:start' : 'record:countin', getRecordState());
}

export function disarm() {
  if (armed === null) return;
  armed = null;
  capturing = false;
  bus.emit('record:armed', { layer: null });
  bus.emit('record:stop', getRecordState());
}

/** One control, two states. This is what replaced the five-state cycle. */
export function toggleArm(index) {
  if (armed === index) disarm();
  else arm(index);
}

export function getArmed() { return armed; }

/**
 * A count-in click. Not a pad.
 *
 * Deliberately NOT `perc_click` from the kit: a count-in that uses one of the
 * sixteen voices is indistinguishable from the pattern it is counting into,
 * which defeats the purpose. This is a bare sine blip outside the kit
 * entirely, and it goes straight to the master rather than through a layer so
 * mute and solo cannot silence it.
 */
function playClick(time, accent) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'sine';
  osc.frequency.value = accent ? 1600 : 1050;

  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(accent ? 0.42 : 0.24, time + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.055);

  osc.connect(gain);
  gain.connect(master);
  osc.start(time);
  osc.stop(time + 0.07);
}

// ---------------------------------------------------------------------------
// Undo
//
// One level, and one level is the right amount here.
//
// Every destructive operation in this module now takes a snapshot first:
// clearing a layer, loading a preset over the top of a recording, shrinking
// the pattern. The specific accident this exists for is real and was reported:
// pressing the pattern button to hear a preset silently replaced four layers
// of recorded work, because loadPreset writes all four and had no idea one of
// them had taken twenty minutes to play.
//
// The alternative to undo is to protect the layers — refusing to overwrite one
// that has content. That is worse, because a control that sometimes does what
// it says and sometimes does not is a control nobody can learn. Undo keeps the
// operation predictable and makes the mistake cheap.
// ---------------------------------------------------------------------------

/** @type {null | { patterns: object[], length: number }} */
let history = null;

export function snapshot() {
  history = {
    patterns: layers.map((l) => JSON.parse(JSON.stringify(l.pattern))),
    length: patternLength,
  };
  bus.emit('history:changed', { canUndo: true });
}

export function canUndo() { return history !== null; }

export function undo() {
  if (!history) return false;

  patternLength = history.length;
  layers.forEach((layer, i) => {
    layer.pattern = JSON.parse(JSON.stringify(history.patterns[i]));
  });

  history = null;
  bus.emit('pattern:length', { length: patternLength });
  bus.emit('layers:changed', { layers });
  bus.emit('history:changed', { canUndo: false });
  return true;
}

/**
 * Toggle one pad at one step of one layer — the grid's editing primitive.
 *
 * Editing by hand and recording by playing produce identical data, because
 * both end up as `{ padId, velocity }` in the same array. That is the same
 * property the preset compiler was built to have, extended one step further:
 * a pattern in this project has three possible origins — authored, performed,
 * drawn — and nothing downstream can tell which it was.
 *
 * Returns whether the step is now on, so a caller can update one cell rather
 * than re-reading the whole pattern.
 */
export function toggleStep(layerIndex, step, padId, velocity = 0.9) {
  const layer = layers[layerIndex];
  if (!layer) return false;

  const slot = layer.pattern.steps[step];
  if (!slot) return false;

  const existing = slot.findIndex((h) => h.padId === padId);
  if (existing >= 0) {
    slot.splice(existing, 1);
    bus.emit('layers:changed', { layers });
    return false;
  }

  slot.push({ padId, velocity });
  bus.emit('layers:changed', { layers });
  return true;
}

/**
 * Snap an audio-clock time to the nearest step of the loop.
 *
 * Round rather than floor: flooring drags every hit backwards, so a note
 * played 10ms early would land a whole step late. Rounding snaps to whichever
 * step is nearest, which is what a player intends.
 *
 * The modulo is written out because JavaScript's % keeps the sign of the left
 * operand, so a negative raw value would produce a negative index.
 */
export function quantizeToStep(when) {
  const raw = (when - startTime) / secondsPerStep();
  const rounded = Math.round(raw);
  return ((rounded % patternLength) + patternLength) % patternLength;
}

function recordHit(padId, velocity, when) {
  const step = quantizeToStep(when);
  const slot = layers[armed].pattern.steps[step];

  // One hit per pad per step: hitting the same pad twice inside one sixteenth
  // is a double-trigger, not two notes.
  if (slot.some((h) => h.padId === padId)) return;

  slot.push({ padId, velocity });
  bus.emit('record:hit', { padId, step, velocity, layer: armed });
}

// ---------------------------------------------------------------------------
// Console interface
// ---------------------------------------------------------------------------

export const audio = {
  initAudio, start, stop, toggle, trigger, update,
  setBpm, getBpm, isRunning, secondsPerStep, quantizeToStep,
  setSwing, getSwing,
  setMasterVolume, setMasterFilter, setMasterResonance,
  setMasterDrive, setMasterSpace,
  arm, disarm, toggleArm, getArmed,
  layers, setLayerGain, setMute, setSolo, clearLayer, loadPattern,
  exportPatterns, emptyPattern,
  getContext, getMaster, getMasterFilter,
  PADS,
  PATTERN_LENGTHS, getPatternLength, setPatternLength, STEPS_PER_BAR,
  toggleStep, isCapturing, getRecordState, snapshot, undo, canUndo,
};