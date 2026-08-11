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
 *                                       >-- master -> masterFilter -> destination
 *   live hit --------------------------/
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
    masterFilter.Q.value = 0.9;

    master.connect(masterFilter);
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

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const LOOKAHEAD_MS = 25;          // how often the planner wakes up
const SCHEDULE_AHEAD = 0.1;       // how far ahead it commits notes, in seconds

export const PATTERN_LENGTH = 16; // 16th notes, one bar

let bpm = 100;
let running = false;

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

  while (startTime + absStep * spb < horizon) {
    const time = startTime + absStep * spb;
    scheduleStep(absStep % PATTERN_LENGTH, time);
    absStep++;
  }
}

function scheduleStep(step, time) {
  for (const layer of layers) {
    if (layer.effectiveGain === 0) continue;
    for (const hit of layer.pattern.steps[step]) {
      playVoice(hit.padId, layer.output, time, hit.velocity);
      queueVisual({ padId: hit.padId, time, velocity: hit.velocity, source: 'sequencer', layer: layer.index });
    }
  }
  queueVisual({ step, time, source: 'step' });
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

  if (armed !== null && running) recordHit(padId, velocity, time);
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
    length: PATTERN_LENGTH,
    steps: Array.from({ length: PATTERN_LENGTH }, () => []),
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

export function arm(index) {
  armed = index;
  bus.emit('record:armed', { layer: armed });
}

export function disarm() { arm(null); }
export function getArmed() { return armed; }

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
  return ((rounded % PATTERN_LENGTH) + PATTERN_LENGTH) % PATTERN_LENGTH;
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
  setMasterVolume, setMasterFilter,
  arm, disarm, getArmed,
  layers, setLayerGain, setMute, setSolo, clearLayer, loadPattern,
  exportPatterns, emptyPattern,
  getContext, getMaster, getMasterFilter,
  PADS, PATTERN_LENGTH,
};