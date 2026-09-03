/**
  ui.js — the lil-gui panel.
  The panel is a VIEW, not a second source of truth.
*/

import GUI from 'lil-gui';
import { bus } from './events.js';
import { PRESETS, loadPreset } from './presets.js';
import { KITS } from './pads.js';
import { SHOTS } from './camera.js';

/**
  Build the panel

  @param {{
     audio: any, interaction: any, hierarchy: any,
     cameraRig: any, onKitChange: (id: string) => void
   }} deps
*/
export function initUI({ audio, interaction, hierarchy, cameraRig, onKitChange }) {
  const gui = new GUI({ title: 'Drum Rig', width: 300 });

  /**
    The mirror. Every value here is written by a bus handler and read by a
    `.listen()` controller — never the reverse, except where a control writes
    a value and then immediately hears it echo back with the same number.
  */
  const view = {
    playing: false,
    bpm: audio.getBpm(),
    volume: 0.80,
    tone: 1.00,
    resonance: 0.12,
    drive: 0.00,
    space: 0.18,
    swing: 0.00,
    kit: 'Studio',
  };

  // ---------
  // Transport
  // ---------

  const transport = gui.addFolder('Transport');

  const actions = {
    playStop: () => bus.emit('transport:toggle', {}),
    fold: () => bus.emit('case:toggle', {}),
  };

  const playButton = transport.add(actions, 'playStop').name('Play');

  transport
    .add(view, 'bpm', 40, 200, 1)
    .name('Tempo (BPM)')
    .listen()
    .onChange((value) => audio.setBpm(value));

  const foldButton = transport.add(actions, 'fold').name('Fold away');

  // --------
  // Patterns
  // --------

  const patterns = gui.addFolder('Patterns');

  for (const preset of PRESETS) {
    const load = { run: () => loadPreset(audio, preset.name) };
    patterns.add(load, 'run').name(preset.name);
  }

  patterns
    .add({ run: () => { for (let i = 0; i < 4; i++) audio.clearLayer(i); } }, 'run')
    .name('Clear all layers');

  // ------
  // Camera
  // ------

  const camera = gui.addFolder('Camera');

  for (const shot of SHOTS) {
    const go = { run: () => cameraRig.goTo(shot.name) };
    camera.add(go, 'run').name(shot.name);
  }

  // ------
  // Master
  // ------


  /** 
    Six sliders mirroring the six physical knobs and they call interaction.setKnob,
    which turns the knob, redraws its printed collar, and emits knob:change,
    which main.js routes to the audio parameter. Going straight to the audio
    would leave the instrument pointing at the old value: correct sound, wrong
    object.
  */

  const KNOBS = [
    { key: 'volume', name: 'Volume', hint: 'Master level' },
    { key: 'tone', name: 'Tone', hint: 'Lowpass cutoff' },
    { key: 'resonance', name: 'Resonance', hint: 'Filter Q' },
    { key: 'drive', name: 'Drive', hint: 'Saturation' },
    { key: 'space', name: 'Space', hint: 'Delay send' },
    { key: 'swing', name: 'Swing', hint: 'Offbeat delay' },
  ];

  const master = gui.addFolder('Master');

  KNOBS.forEach((knob, index) => {
    master.add(view, knob.key, 0, 1, 0.01)
      .name(knob.name)
      .listen()
      .onChange((v) => interaction.setKnob(index, v));
  });

  // ----
  // Kits
  // ----

  const kits = gui.addFolder('Kit');

  for (const kit of KITS) {
    const load = {
      run: () => {
        onKitChange(kit.id);
        view.kit = kit.name;
      },
    };
    kits.add(load, 'run').name(kit.name);
  }

  kits.add(view, 'kit').name('Loaded').listen().disable();

  // ----------------------------------------------------------
  // Subscriptions: the bus writes the mirror, lil-gui reads it
  // ----------------------------------------------------------

  bus.on('transport:start', () => {
    view.playing = true;
    playButton.name('Stop');
  });

  bus.on('transport:stop', () => {
    view.playing = false;
    playButton.name('Play');
  });

  bus.on('transport:bpm', ({ bpm }) => { view.bpm = bpm; });

  bus.on('rig:fold', ({ open }) => {
    foldButton.name(open ? 'Fold away' : 'Unfold');
  });

  /**
    One handler for all six knobs
  */
  bus.on('knob:change', ({ index, value }) => {
    const knob = KNOBS[index];
    if (knob) view[knob.key] = value;
  });

  bus.on('kit:changed', ({ kit }) => { view.kit = kit.name; });

  return { gui, view, destroy: () => gui.destroy() };
}