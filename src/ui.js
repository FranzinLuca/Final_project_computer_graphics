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
import { KITS } from './pads.js';
import { SHOTS } from './camera.js';

/**
 * Build the panel.
 *
 * Called AFTER the audio context is unlocked, not at load. `audio.layers` does
 * not exist until `initAudio()` runs — the gain nodes need a context — so a
 * panel built at page load would have four empty layer folders and every
 * control on them would write into nothing.
 *
 * This module took five dependencies and now takes four: `lighting` went with
 * the Lighting folder. That is worth noticing rather than glossing — removing
 * a section of a control panel removed a whole module from its dependency
 * list, which is the payoff for having handed dependencies in rather than
 * importing them. The rule it still respects is direction: everything here is
 * handed in by main.js, and nothing imports ui.js back.
 *
 * @param {{
 *   audio: any, interaction: any, hierarchy: any,
 *   cameraRig: any, onKitChange: (id: string) => void
 * }} deps
 */
export function initUI({ audio, interaction, hierarchy, cameraRig, onKitChange }) {
  const gui = new GUI({ title: 'Drum Rig', width: 300 });

  /**
   * The mirror. Every value here is written by a bus handler and read by a
   * `.listen()` controller — never the reverse, except where a control writes
   * a value and then immediately hears it echo back with the same number.
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
  // Master
  //
  // Six sliders mirroring the six physical knobs, and they deliberately do NOT
  // call audio.setMasterDrive and friends. They call interaction.setKnob,
  // which turns the knob, redraws its printed collar, and emits knob:change,
  // which main.js routes to the audio parameter. Going straight to the audio
  // would leave the instrument pointing at the old value: correct sound, wrong
  // object.
  //
  // The mapping from slider to knob index is the array below, and it is the
  // one duplication in this file — main.js owns the authority. It is written
  // as data rather than six copies of the same three lines so that adding a
  // seventh control is one row.
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // Layers — deliberately NOT here any more
  //
  // This folder used to hold a record-arm dropdown and four sub-folders of
  // gain, mute, solo and clear. All of it moved to sequencer.js, and the
  // duplication is the reason: two surfaces showing the same four layers meant
  // two places to look for "which layer am I recording into", and the panel's
  // version could only ever show the state, never the CONTENT. A grid that
  // draws the pattern answers both questions with one widget, so the panel
  // stops trying to answer either.
  //
  // What stayed here is what lil-gui is genuinely better at: single scalar
  // parameters with a labelled slider. What left is the matrix.
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Kits
  //
  // Replaces the Lighting and Keys folders, both removed.
  //
  // Lighting held a reactive on/off toggle and three read-only band meters.
  // The meters were a good demonstration of the analysis and they are now a
  // worse one than the thing they were describing: the cabinets carry a
  // seven-segment level meter each, in the scene, next to the lights they
  // drive. A number in a panel explaining an effect you can already watch is
  // a worse explanation than the effect.
  //
  // Keys held a four-line reference card. It was written before the hover
  // readout existed; now every pad states its own key when you point at it,
  // which is the same information delivered where the question is asked
  // rather than in a folder somebody has to think to open.
  //
  // Both are recorded as deletions rather than quietly dropped, because "we
  // removed a control panel section once the scene could answer the question
  // itself" is a better line in the report than either widget was.
  // -----------------------------------------------------------------------

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
   * One handler for all six knobs, indexing the same table the sliders were
   * built from. Turn a knob on the instrument and its slider follows; drag the
   * slider and the knob and its printed collar follow. Neither is the source
   * of truth — the value is, and both are views of it.
   */
  bus.on('knob:change', ({ index, value }) => {
    const knob = KNOBS[index];
    if (knob) view[knob.key] = value;
  });

  bus.on('kit:changed', ({ kit }) => { view.kit = kit.name; });

  return { gui, view, destroy: () => gui.destroy() };
}