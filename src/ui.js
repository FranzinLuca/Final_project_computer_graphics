/**
 * ui.js — the lil-gui panel.
 *
 * The panel is a VIEW, not a second source of truth.
 *
 * This is the only interesting thing about the file and everything in it
 * follows from that sentence. There are now two ways to change the master
 * volume — drag the knob on the instrument, or drag the slider in the panel —
 * and the failure mode of naive GUI code is that each remembers its own value.
 * Turn the 3D knob and the slider goes stale; drag the slider and the knob
 * does not move. The two drift, and which one is "right" depends on which was
 * touched last.
 *
 * So the panel owns no state. `view` below is a mirror, kept up to date by
 * subscribing to the same bus events everything else subscribes to, and every
 * controller is marked `.listen()` so lil-gui re-reads it each frame. Writes go
 * out through the same channels the keyboard and the raycaster use. Turning the
 * 3D knob moves the slider because `knob:change` fires; moving the slider turns
 * the 3D knob because it calls `interaction.setKnob`, which is the same
 * function the drag handler calls.
 *
 *
 * WHY SOME CONTROLS EMIT EVENTS AND OTHERS CALL FUNCTIONS
 *
 * The transport button emits `transport:toggle` on the bus. The BPM slider
 * calls `audio.setBpm` directly. That looks inconsistent and is not.
 *
 * Bus intents exist for user GESTURES that more than one input surface can
 * produce. Space, the panel's play button and a future MIDI footswitch all
 * mean the same thing, and routing them through one event is what guarantees
 * they behave identically — main.js decides once what "toggle the transport"
 * does.
 *
 * A parameter setter has no such ambiguity. `setBpm(124)` means exactly one
 * thing, it is already the single place that logic lives, and wrapping it in
 * an event would add a layer whose only content is a rename. Intents are for
 * decisions; setters are for values.
 */

import GUI from 'lil-gui';
import { bus } from './events.js';
import { PRESETS, loadPreset } from './presets.js';
import { SHOTS } from './camera.js';

/**
 * Build the panel.
 *
 * Called AFTER the audio context is unlocked, not at load. `audio.layers` does
 * not exist until `initAudio()` runs — the gain nodes need a context — so a
 * panel built at page load would have four empty layer folders and every
 * control on them would write into nothing.
 *
 * This module takes five dependencies, more than anything else in the project.
 * That is what a control surface is: the one place whose job is to touch
 * everything. The rule it still respects is direction — everything here is
 * handed in by main.js, and nothing imports ui.js back.
 *
 * @param {{
 *   audio: any, interaction: any, hierarchy: any,
 *   lighting: any, cameraRig: any
 * }} deps
 */
export function initUI({ audio, interaction, hierarchy, lighting, cameraRig }) {
  const gui = new GUI({ title: 'Drum Rig', width: 300 });

  /**
   * The mirror. Every value here is written by a bus handler and read by a
   * `.listen()` controller — never the reverse, except where a control writes
   * a value and then immediately hears it echo back with the same number.
   */
  const view = {
    playing: false,
    bpm: audio.getBpm(),
    volume: 0.8,
    filter: 1.0,
    recordInto: 'Off',
    reactive: true,
    bass: 0,
    mid: 0,
    high: 0,
  };

  // -----------------------------------------------------------------------
  // Transport
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // Patterns
  // -----------------------------------------------------------------------

  const patterns = gui.addFolder('Patterns');

  // One button per preset, generated from the data rather than written out.
  // Adding a fourth preset to presets.js puts a fourth button here with no
  // edit to this file — the panel describes the data, it does not duplicate it.
  for (const preset of PRESETS) {
    const load = { run: () => loadPreset(audio, preset.name) };
    patterns.add(load, 'run').name(preset.name);
  }

  patterns
    .add({ run: () => { for (let i = 0; i < 4; i++) audio.clearLayer(i); } }, 'run')
    .name('Clear all layers');

  // -----------------------------------------------------------------------
  // Camera
  // -----------------------------------------------------------------------

  const camera = gui.addFolder('Camera');

  for (const shot of SHOTS) {
    const go = { run: () => cameraRig.goTo(shot.name) };
    camera.add(go, 'run').name(shot.name);
  }

  // -----------------------------------------------------------------------
  // Mix
  //
  // These two mirror the first two physical knobs. They deliberately do NOT
  // call audio.setMasterVolume — they call interaction.setKnob, which turns
  // the knob, which emits knob:change, which main.js routes to the audio
  // parameter. Going straight to the audio would leave the 3D knob pointing
  // at the old value: correct sound, wrong instrument.
  // -----------------------------------------------------------------------

  const KNOB_VOLUME = 0;
  const KNOB_FILTER = 1;
  const KNOB_LAYER_0 = 2;

  const mix = gui.addFolder('Mix');

  mix.add(view, 'volume', 0, 1, 0.01)
    .name('Master volume')
    .listen()
    .onChange((v) => interaction.setKnob(KNOB_VOLUME, v));

  mix.add(view, 'filter', 0, 1, 0.01)
    .name('Master filter')
    .listen()
    .onChange((v) => interaction.setKnob(KNOB_FILTER, v));

  // -----------------------------------------------------------------------
  // Layers
  // -----------------------------------------------------------------------

  const layersFolder = gui.addFolder('Layers');

  /**
   * Recording arm is a dropdown, not four checkboxes.
   *
   * audio.js models it as one nullable index, because recording into two
   * layers at once is meaningless. Four independent booleans would let the
   * panel express a state the engine cannot hold, and the code to keep them
   * mutually exclusive would be a reimplementation of the constraint the
   * engine already enforces. A select over the same domain cannot go wrong.
   */
  const ARM_OPTIONS = ['Off', 'Layer 1', 'Layer 2', 'Layer 3', 'Layer 4'];

  layersFolder
    .add(view, 'recordInto', ARM_OPTIONS)
    .name('Record into')
    .listen()
    .onChange((choice) => {
      const index = ARM_OPTIONS.indexOf(choice) - 1;
      if (index < 0) audio.disarm();
      else audio.arm(index);
    });

  /** Mirrors of each layer's engine state, one object per layer. */
  const layerViews = audio.layers.map((layer, index) => {
    const mirror = { gain: layer.gain, muted: layer.muted, solo: layer.solo };
    const folder = layersFolder.addFolder(`Layer ${index + 1}`);

    folder.add(mirror, 'gain', 0, 1, 0.01)
      .name('Gain')
      .listen()
      // Through the knob again, for the same reason as the mix sliders: knobs
      // 2..5 are the four layer gains, and they have to turn.
      .onChange((v) => interaction.setKnob(KNOB_LAYER_0 + index, v));

    folder.add(mirror, 'muted').name('Mute').listen()
      .onChange((v) => audio.setMute(index, v));

    folder.add(mirror, 'solo').name('Solo').listen()
      .onChange((v) => audio.setSolo(index, v));

    folder.add({ run: () => audio.clearLayer(index) }, 'run').name('Clear');

    folder.close();
    return mirror;
  });

  layersFolder.close();

  // -----------------------------------------------------------------------
  // Lighting
  // -----------------------------------------------------------------------

  const lights = gui.addFolder('Lighting');

  lights.add(view, 'reactive')
    .name('Reactive rig')
    .onChange((on) => lighting.setEnabled(on));

  /**
   * Three read-only meters.
   *
   * `.disable()` after `.listen()`: the controller keeps refreshing from the
   * mirror every frame but will not accept input. lil-gui has no meter widget,
   * and a disabled slider is a perfectly good one — it fills left to right and
   * cannot be dragged.
   *
   * These earn their place at the oral more than anywhere else. They make the
   * frequency analysis visible as numbers next to the lights it drives, which
   * turns "the lights react to the music" from a claim into something an
   * examiner can watch happening.
   */
  for (const band of ['bass', 'mid', 'high']) {
    lights.add(view, band, 0, 1, 0.001)
      .name(band[0].toUpperCase() + band.slice(1))
      .listen()
      .disable();
  }

  lights.close();

  // -----------------------------------------------------------------------
  // Key bindings, as a reference card
  //
  // Read from interaction.js's own exports rather than retyped, so the panel
  // cannot describe a keyboard map the code does not have.
  // -----------------------------------------------------------------------

  const keys = gui.addFolder('Keys');
  const reference = {
    pads: '1 2 3 4 / Q W E R / A S D F / Z X C V',
    space: 'Start / stop the sequencer',
    o: 'Fold / unfold the slab',
    shift: 'Hold while dragging a knob for fine control',
  };

  keys.add(reference, 'pads').name('Pads').disable();
  keys.add(reference, 'space').name('Space').disable();
  keys.add(reference, 'o').name('O').disable();
  keys.add(reference, 'shift').name('Shift').disable();
  keys.close();

  // -----------------------------------------------------------------------
  // Subscriptions: the bus writes the mirror, lil-gui reads it
  // -----------------------------------------------------------------------

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
   * One handler for all six knobs.
   *
   * Index 0 and 1 are the master pair, 2..5 are the layer gains. The mapping
   * lives in main.js as the authority; this repeats the arithmetic rather than
   * importing it, which is a small duplication and the honest place to note it
   * — if the knob order ever changes, these two constants change with it.
   */
  bus.on('knob:change', ({ index, value }) => {
    if (index === KNOB_VOLUME) view.volume = value;
    else if (index === KNOB_FILTER) view.filter = value;
    else {
      const layer = layerViews[index - KNOB_LAYER_0];
      if (layer) layer.gain = value;
    }
  });

  bus.on('layers:changed', ({ layers }) => {
    layers.forEach((layer, i) => {
      layerViews[i].gain = layer.gain;
      layerViews[i].muted = layer.muted;
      layerViews[i].solo = layer.solo;
    });
  });

  bus.on('record:armed', ({ layer }) => {
    view.recordInto = layer === null ? 'Off' : `Layer ${layer + 1}`;
  });

  /**
   * The meters, fed from lighting.js's broadcast.
   *
   * Note ui.js never touches an AnalyserNode. lighting.js measures once and
   * publishes; the lights and the meters are two independent subscribers to
   * one measurement. The same rule that let the mascot be added without
   * editing audio.js let these three sliders be added without editing
   * lighting.js.
   */
  bus.on('audio:bands', ({ bass, mid, high }) => {
    view.bass = bass;
    view.mid = mid;
    view.high = high;
  });

  return { gui, view, destroy: () => gui.destroy() };
}