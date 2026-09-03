/**
  audio.js — context, transport, scheduler, layers, recording.
  This module imports the event bus (which is dependency-free
  infrastructure) and the pad bank
 
  Signal path:
    scheduled hit -> layer[i].output --\
                                        >-- master -> drive -> space -> tone -> destination
    live hit --------------------------/
*/

import { bus } from './events.js';
import { PADS, PAD_BY_ID } from './pads.js';

// ----------------------
// Context and master bus
// ----------------------

/** @type {AudioContext | null} */
let ctx = null;
/** @type {GainNode | null} */
let master = null;
/** @type {BiquadFilterNode | null} */
let masterFilter = null;

/**
  Instead of a lookup table i use a fixed tanh shaped curve.
  The signal come in and gets pre-amplified by some amount.
  The more it gets preamplified the more the signal gets on the
  extreme of the curve and get more distorted.
  After there is a post amplifaction step so that i get only the
  distortion effect without the signal getting louder
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
  Create and unlock the AudioContext. Must be called from inside a user
  gesture handler or the context stays suspended and the project is silent.
*/
export async function initAudio() {
  if (!ctx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    ctx = new Ctor({ latencyHint: 'interactive' }); // optimize for low latency due to live performance

    master = ctx.createGain();
    master.gain.value = 0.8;

    masterFilter = ctx.createBiquadFilter();
    masterFilter.type = 'lowpass';
    masterFilter.frequency.value = FILTER_MAX;
    masterFilter.Q.value = Q_MIN;

    // --- drive ---
    drivePre = ctx.createGain();
    drivePre.gain.value = 1;

    driveShaper = ctx.createWaveShaper();
    driveShaper.curve = saturationCurve();
    /**
      A non-linearity generates harmonics above the input's own bandwidth, and
      anything above Nyquist folds back down as aliasing
      '4x' runs the shaper at four times the sample rate and
      filters before decimating, which pushes the fold-back point two octaves
      out of the way.
    */
    driveShaper.oversample = '4x';

    driveMakeup = ctx.createGain();
    driveMakeup.gain.value = 1;

    // --- space ---
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

    // --- wiring ---
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

// ---------------
// Master controls
// ---------------

const FILTER_MIN = 140;    // Hz
const FILTER_MAX = 18000;  // Hz

const Q_MIN = 0.7;         // flat, no audible peak
const Q_MAX = 14;          // resonant but not self-oscillating

/**
  Set master volume over time to avoid clicking
*/
export function setMasterVolume(value) {
  if (!master) return;
  const v = Math.min(1, Math.max(0, value));
  master.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
}

/**
  Master lowpass cutoff, from a 0..1 knob position.
  pitch/frequency perception is logarithmic not linear
  an octave from another is double the previous in hz

  f(t) = min * (max/min)^t
*/
export function setMasterFilter(value) {
  if (!masterFilter) return;
  const t = Math.min(1, Math.max(0, value));
  const freq = FILTER_MIN * Math.pow(FILTER_MAX / FILTER_MIN, t);
  masterFilter.frequency.setTargetAtTime(freq, ctx.currentTime, 0.02);
}

/**
  Master resonance, from a 0..1 knob position.
  `Q` is the height of the peak at the cutoff, and it is 
  exponential in perception exactly as frequency

  same formula as before
*/
export function setMasterResonance(value) {
  if (!masterFilter) return;
  const t = Math.min(1, Math.max(0, value));
  const q = Q_MIN * Math.pow(Q_MAX / Q_MIN, t);
  masterFilter.Q.setTargetAtTime(q, ctx.currentTime, 0.02);
}

/**
  Drive, from a 0..1 knob position.
 
  Pre-gain rises to 12x, which is well past the point where the curve stops being a straight line 
  at 0 it is clean, at 1 it is thick, and it is not simply louder
*/
export function setMasterDrive(value) {
  if (!drivePre) return;
  const t = Math.min(1, Math.max(0, value));
  drivePre.gain.setTargetAtTime(1 + t * 11, ctx.currentTime, 0.02);
  driveMakeup.gain.setTargetAtTime(1 / (1 + t * 2.4), ctx.currentTime, 0.02);
}

/**
  Space, from a 0..1 knob position.
  A SEND level, not a wet/dry mix. The dry path is untouched, so turning this
  up adds ambience rather than trading the direct sound away for it — which
  matters on percussion more than on anything else, because the transient IS
  the sound and a crossfade to wet destroys it.
*/
export function setMasterSpace(value) {
  if (!spaceSend) return;
  const t = Math.min(1, Math.max(0, value));
  spaceSend.gain.setTargetAtTime(t * t * 0.85, ctx.currentTime, 0.03);
}

/**
  The tanh saturation curve.
  2048 points is far more than needed for audio-rate interpolation and costs
  8 KB once.
*/
function saturationCurve(points = 2048) {
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 2.2) / Math.tanh(2.2);
  }
  return curve;
}

// ---------
// Transport
// ---------
const LOOKAHEAD_MS = 25;          // how often the planner wakes up
const SCHEDULE_AHEAD = 0.1;       // how far ahead it commits notes, in seconds

/**
  Pattern length, in sixteenths.
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
  Swing, 0..1, mapped to a delay on every odd sixteenth.
  The most musical of the six knobs it is a change to the scheduler rather than to the signal.

  Straight sixteenths are mathematically even and rhythmically dead: every
  groove a human plays pushes the off-beats later, and the amount is what
  separates one genre from another. 
  Odd steps are delayed by a fraction of a step:
    time(n) = startTime + n * spb + (n odd ? swing * spb * 0.62 : 0)

*/
let swing = 0;

export function setSwing(value) {
  swing = Math.min(1, Math.max(0, value));
  bus.emit('transport:swing', { swing });
}

export function getSwing() { return swing; }

/** How late absolute step `n` sounds, in seconds. Zero on the even steps. */
function swingOffset(n, spb) {
  return (n % 2 === 1) ? swing * spb * 0.62 : 0;
}

/**
  Audio-clock time of absolute step 0. Every step in the piece sits at
  startTime + n * secondsPerStep(), and every timing question in this file is
  answered from that one equation.
*/
let startTime = 0;
let absStep = 0; // absolute step

/** @type {number | null} setInterval handle for the planner. */
let timer = null;

export function secondsPerStep() {
  return 60 / bpm / 4; // 4 sixteenths per beat
}

export function getBpm() { return bpm; }
export function isRunning() { return running; }

/**
  Change tempo without losing the beat.
  You can naively assign bpm but would move every step when changed, because step positions are
  derived from startTime. 
  Rebasing startTime so the next scheduled step keeps its current audio time means the change takes effect going forward and
  everything already committed still lands where it was promised.
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
  // Stopping the transport ends capture but does not disarm. The layer stays
  // selected for recording, so pressing play again resumes into the same one
  // rather than silently dropping the choice
  if (capturing) {
    capturing = false;
    bus.emit('record:stop', getRecordState());
  }

  bus.emit('transport:stop', {});
}

export function toggle() { running ? stop() : start(); }

// -----------------------
// The lookahead scheduler
// -----------------------

/**
  Runs every LOOKAHEAD_MS (25ms) on the main thread. It never plays anything itself it
  commits notes to the audio clock.
  Given that every step time is computed as startTime + n * secondsPerStep
  rather than accumulated (nextTime += step), floating-point error cannot
  build up over a long session.
*/
function planner() {
  if (!ctx || !running) return;

  const horizon = ctx.currentTime + SCHEDULE_AHEAD;
  const spb = secondsPerStep();

  while (startTime + absStep * spb < horizon) {
    const time = startTime + absStep * spb + swingOffset(absStep, spb);
    scheduleStep(absStep, time);
    absStep++;
  }
}

/**
  Commit one absolute step to the audio clock.
  The step index is wrapped PER LAYER, against that layer's own pattern
  length, rather than once against a global.
*/
function scheduleStep(absoluteStep, time) {
  for (const layer of layers) {
    if (layer.effectiveGain === 0) continue;
    const pattern = layer.pattern;
    // step get out for each layer differntly
    // double module because the module keep the sign so avoid errors
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
  Resize every layer's pattern.
*/
export function setPatternLength(next) {
  if (!PATTERN_LENGTHS.includes(next) || next === patternLength) return;

  snapshot(); // for the undo section
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

// ----------------------
// Deferred visual events
// ----------------------


/** 
  The scheduler runs up to SCHEDULE_AHEAD seconds early. Emitting on the bus
  at schedule time would flash the LEDs 100ms before the sound. Instead,
  events go into a queue stamped with their audio time, and update() — called
  once per rendered frame from main.js — releases them when the audio clock
  catches up. Sound and light then land together.
*/

const pending = [];

function queueVisual(event) {
  pending.push(event);
}

/** Call once per frame from the render loop. */
export function update() {
  if (!ctx) return;
  const now = ctx.currentTime;

  // detect count in ending to start recording
  if (armed !== null && running && !capturing && currentAbsoluteStep() >= captureFromStep) {
    capturing = true;
    bus.emit('record:start', getRecordState());
  }
  // unroll pending events (also visual emit)
  while (pending.length && pending[0].time <= now) {
    const event = pending.shift();
    if (event.source === 'step') bus.emit('transport:step', event);
    else bus.emit('pad:hit', event);
  }
}

// ------------------
// Voices and choking
// ------------------

/** chokeGroup -> the output node of the voice currently ringing in it. */
const choking = new Map();

/**
  The single function that produce sounds
*/
function playVoice(padId, dest, time, velocity) {
  const pad = PAD_BY_ID.get(padId);
  if (!pad) {
    console.warn(`[audio] unknown pad "${padId}"`);
    return;
  }

  // A closed hi-hat cuts off a ringing open one, both
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
        // fall back because cancelandholdattime is a new function
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
  Play a pad now. `capture` decides whether the recorder hears it.
  Striking a pad is a PERFORMANCE, and a performance is what an armed layer exists to capture. 
  Clicking a cell in the step grid is an EDIT: the note has already been written, at the step the
  pointer chose, and the sound is played only so the writer can hear what they just placed.
*/
function fire(padId, velocity, capture) {
  if (!ctx) return;
  const time = ctx.currentTime;

  playVoice(padId, master, time, velocity);
  bus.emit('pad:hit', {
    padId, time, velocity, layer: armed,
    source: capture ? 'live' : 'audition',
  });

  // `capturing`, not `armed`: during the count-in the layer is armed and
  // nothing is written, which is the whole point of a count-in.
  if (capture && capturing) recordHit(padId, velocity, time);
}

/**
  Play a pad now, from a click or a key press.
  Always audible, and additionally written into the armed layer if recording.
*/
export function trigger(padId, velocity = 1.0) {
  fire(padId, velocity, true);
}

/**
 Play a pad now without the recorder hearing it.
 For anything that makes a sound as feedback on an EDIT rather than as a
 performance 
 It still emits `pad:hit`, so the cap still flashes and Rob8 still swings: the sound is real, it simply is not an input.
*/
export function audition(padId, velocity = 1.0) {
  fire(padId, velocity, false);
}

// ------
// Layers
// ------

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
 Recompute every layer's output gain.
 Solo is exclusive-by-implication: if any layer is soloed, only soloed layers
 are heard and mute is irrelevant.
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

/** Deep copy of all four patterns — the shape presets.js will store. NEVER USED */
export function exportPatterns() {
  return layers.map((l) => JSON.parse(JSON.stringify(l.pattern)));
}

// ---------
// Recording
// ---------

/** @type {number | null} index of the layer being recorded into. */
let armed = null;

let captureFromStep = 0;

/** True once the count-in has elapsed and hits are actually being written. */
let capturing = false;

export function isCapturing() { return capturing; }

/**
  Everything the UI needs to draw the recording state, in one object.
  Returned as a snapshot rather than exposed as live variables, so no consumer
  can hold a reference to engine state and start writing to it.
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
  Arm a layer for recording.
  @param {number} index
  @param {{ countIn?: boolean }} options
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

/** One control, two states*/
export function toggleArm(index) {
  if (armed === index) disarm();
  else arm(index);
}

export function getArmed() { return armed; }

/**
  count-in click to time the musician recording
*/
function playClick(time, accent) {
  if (!ctx) return;
  // oscillatore create acontinuos wave form
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  // sine is the purest waveform shape, create a plain "beep"
  osc.type = 'sine';
  // give a 1,2,3,4 feel giving an accent to the sound
  osc.frequency.value = accent ? 1600 : 1050;

  // click lifetime volume management
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(accent ? 0.42 : 0.24, time + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.055);

  osc.connect(gain);
  gain.connect(master);
  osc.start(time);
  osc.stop(time + 0.07);
}

// ----
// Undo
// ----

/**
  Classical undo operation, works only for more destructive operations like:
  - changing the preset beat
  - removing a full row
  - etc.

  To add the function to other part of the program just add audio.snapshot()
  everything else is automatic
*/

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
  Toggle one pad at one step of one layer
  remove is alreay there
  add if not there

  TO BE REMOVED
*/
export function toggleStep(layerIndex, step, padId, velocity = 0.9) {
  const slot = slotAt(layerIndex, step);
  if (!slot) return false;
  return slot.some((h) => h.padId === padId)
    ? (removeStep(layerIndex, step, padId), false)
    : (addStep(layerIndex, step, padId, velocity), true);
}

/** The step array for one cell, or null if either index is out of range. */
function slotAt(layerIndex, step) {
  const layer = layers[layerIndex];
  if (!layer) return null;
  return layer.pattern.steps[step] ?? null;
}

/**
  Put a note in a cell
*/
export function addStep(layerIndex, step, padId, velocity = 0.9) {
  const slot = slotAt(layerIndex, step);
  if (!slot) return false;
  if (slot.some((h) => h.padId === padId)) return false;

  slot.push({ padId, velocity });
  bus.emit('layers:changed', { layers });
  return true;
}

/**
  Take a note out of a cell.
  @returns {boolean} whether anything was removed
*/
export function removeStep(layerIndex, step, padId = null) {
  const slot = slotAt(layerIndex, step);
  if (!slot || slot.length === 0) return false;

  const index = padId === null
    ? slot.length - 1
    : slot.findIndex((h) => h.padId === padId);

  if (index < 0) return false;

  slot.splice(index, 1);
  bus.emit('layers:changed', { layers });
  return true;
}

/**
  Snap an audio-clock time to the nearest step of the loop.
  This is the function that convert real world hit into step for the loop
  Round rather than floor: flooring drags every hit backwards
  
  Same modulo tricks made for sign purpouse
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

// -----------------
// Console interface
// -----------------

// API for debug

export const audio = {
  initAudio, start, stop, toggle, trigger, audition, update,
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
  toggleStep, addStep, removeStep, isCapturing, getRecordState, snapshot, undo, canUndo,
};