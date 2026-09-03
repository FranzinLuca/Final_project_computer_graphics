/**
 * presets.js — authored patterns, written in drum notation and compiled.
 *
 * This module imports nothing. It is pure data plus the function that turns
 * that data into the shape audio.js expects, which means it can be unit-tested
 * from the console with no context, no scene and no scheduler.
 *
 *
 * WHY THERE IS A COMPILER AND NOT JUST DATA
 *
 * A pattern, as audio.js stores it, is:
 *
 *   { length: 16, steps: [ [ {padId, velocity}, ... ] x16 ] }
 *
 * Four of those per preset is sixty-four arrays of objects. Written out
 * literally that is unreadable, unreviewable and — worse — unwritable: you
 * cannot see the groove. The one thing a drum pattern must be is legible as a
 * rhythm, and a nested array is legible as nothing.
 *
 * So patterns are authored in the notation every drum machine and every
 * sequencer has used since the 1980s — one row per voice, one character per
 * sixteenth — and compiled into the runtime shape:
 *
 *   kick_deep:  'X..x....X...x...'
 *   snare:      '....X.......X...'
 *   hat_closed: 'x.x.x.x.x.x.x.x.'
 *
 * The authoring format and the runtime format are deliberately different
 * things, and the compiler is the seam between them. That is not an extra
 * layer for its own sake: the phase 7 requirement is that authored patterns
 * arrive "in the same data shape a recording produces", and a compiler that
 * emits exactly what `emptyPattern()` builds is how that claim gets *proved*
 * rather than asserted. A recorded pattern and a compiled one are
 * indistinguishable downstream — the sequencer cannot tell which is which,
 * which is why a preset can be loaded, played, added to by recording, and
 * exported back out again with no special cases anywhere.
 *
 *
 * THE NOTATION
 *
 *   X   accent      velocity 1.00
 *   x   normal      velocity 0.75
 *   o   ghost       velocity 0.45
 *   .   rest        (also '-' and ' ')
 *
 * Three velocity levels rather than a number per step, because that is the
 * distinction a drummer actually makes and it keeps a row scannable. Ghost
 * notes are the reason the patterns below groove at all: a hi-hat line where
 * every stroke is identical reads as a machine, and one where the off-beats
 * drop to 0.45 reads as a hand.
 */

// ---------------------------------------------------------------------------
// Notation
// ---------------------------------------------------------------------------

export const PATTERN_LENGTH = 16;

const VELOCITY = {
  X: 1.00,
  x: 0.75,
  o: 0.45,
};

const REST = new Set(['.', '-', ' ', '_']);

// ---------------------------------------------------------------------------
// The compiler
// ---------------------------------------------------------------------------

/**
 * Compile one layer — an object of `padId -> notation row` — into a pattern.
 *
 * Validation is loud and happens at module load, not at playback.
 *
 * Authored data is the one place in a project where a typo is silent. A row
 * with fifteen characters instead of sixteen does not throw; it just makes the
 * groove subtly wrong in a way that is very hard to hear and nearly impossible
 * to find by reading, because the eye counts characters badly. Every row is
 * therefore length-checked and character-checked the moment this file is
 * imported, so a mistake surfaces as a console error on page load rather than
 * as a pattern that "feels a bit off" three days before the deadline.
 *
 * @param {Record<string, string>} rows
 * @param {string} label  used only in error messages
 * @returns {{ length: number, steps: Array<Array<{padId: string, velocity: number}>> }}
 */
export function compileLayer(rows, label = 'pattern') {
  // Built exactly as audio.js's emptyPattern() builds it. Same shape, same
  // construction — if that function changes, this one has to change with it,
  // and the phase 7 claim is that they never diverge.
  const steps = Array.from({ length: PATTERN_LENGTH }, () => []);

  for (const [padId, row] of Object.entries(rows)) {
    if (row.length !== PATTERN_LENGTH) {
      console.error(
        `[presets] ${label} / ${padId}: row is ${row.length} steps, expected ${PATTERN_LENGTH}`
      );
      continue;
    }

    for (let step = 0; step < PATTERN_LENGTH; step++) {
      const symbol = row[step];
      if (REST.has(symbol)) continue;

      const velocity = VELOCITY[symbol];
      if (velocity === undefined) {
        console.error(
          `[presets] ${label} / ${padId}: unknown symbol "${symbol}" at step ${step}`
        );
        continue;
      }

      steps[step].push({ padId, velocity });
    }
  }

  return { length: PATTERN_LENGTH, steps };
}

/** Compile a whole preset's four layers. */
function compile(preset) {
  return {
    name: preset.name,
    bpm: preset.bpm,
    description: preset.description,
    patterns: preset.layers.map((rows, i) =>
      compileLayer(rows, `${preset.name} L${i + 1}`)
    ),
  };
}

// ---------------------------------------------------------------------------
// The patterns
//
// Layer roles are consistent across all three presets, which is what makes the
// layer mute and solo buttons useful rather than arbitrary:
//
//   L1  foundation   kicks and sub
//   L2  backbeat     snare, clap, rim
//   L3  cymbals      hats and ride
//   L4  colour       percussion and effects
//
// Solo L1 and you hear the pulse; solo L3 and you hear the subdivision. That
// is a demonstrable thing at the oral, and it is a property of how the
// patterns were authored rather than of any code.
// ---------------------------------------------------------------------------

const AUTHORED = [
  {
    name: 'Boom Bap',
    bpm: 92,
    description: 'Ghosted hats, syncopated kick, snare on 2 and 4.',
    layers: [
      { kick_deep:  'X..x....X...x...' },
      { snare:      '....X.......X...',
        rim:        '..........o.....' },
      // The closed hat vacates steps 6 and 14 because the open hat lands
      // there. Both are in the 'hh' choke group, so writing them on the same
      // step means the open hat cuts a closed hat that started the same
      // instant — audible as a click, and a wasted voice. The choke exists to
      // model one pair of cymbals; the notation has to respect that a pair of
      // cymbals cannot be in two states at once.
      { hat_closed: 'x.o.x...x.o.x...',
        hat_open:   '......x.......x.' },
      { perc_click: '..o.......o..o..' },
    ],
  },
  {
    name: 'Four Four',
    bpm: 124,
    description: 'Kick on every beat, open hats on the off, clap on the backbeat.',
    layers: [
      { kick_tight: 'X...X...X...X...',
        sub_drop:   'X...............' },
      { clap:       '....X.......X...' },
      // Closed on the beat, open on the off — the standard house figure, and
      // the two never coincide, so the choke group is never asked to cut
      // something that has not yet rung.
      { hat_closed: 'x...x...x...x...',
        hat_open:   '..x...x...x...x.' },
      { cowbell:    '............o.o.',
        zap:        '...............x' },
    ],
  },
  {
    name: 'Dembow',
    bpm: 96,
    description: 'The reggaetón pattern: kick on the beat, snare on the "and-a".',
    layers: [
      // The dembow is defined by where the SNARE is, not the kick. The kick
      // holds a plain four while the backbeat lands on the third and fourth
      // sixteenth of alternate beats — the 3+3+2 feel underneath everything in
      // the genre.
      { kick_deep:  'X...X...X...X...' },
      { snare:      '...x..x....x..x.',
        clap:       '....X.......X...' },
      { hat_closed: 'x.o.x.o.x.o.x.o.' },
      { cowbell:    '..o...o...o...o.',
        perc_click: '......o.......o.' },
    ],
  },
  {
    name: 'Four Floor Techno',
    bpm: 132,
    description: 'Kick every beat, open hat on every off, clap on the backbeat.',
    layers: [
      { kick_deep:  'X...X...X...X...',
        sub_drop:   'X.......X.......' },
      { clap:       '....X.......X...',
        rim:        '..........o.....' },
      // Closed on the beat, open on the off. The two never coincide, so the
      // choke group is never asked to cut something that has not yet rung.
      { hat_closed: 'x...x...x...x...',
        hat_open:   '..x...x...x...x.' },
      { zap:        '...............x',
        ride:       '............o...' },
    ],
  },
  {
    name: 'Drill',
    bpm: 142,
    description: 'Sliding 808, sparse kick, hat triplets against the snare on 3.',
    layers: [
      // The 808 carries the bar and the kicks are transients on top of it,
      // which is why they do not land together: doubling them would stack two
      // low sweeps and lose both.
      { kick_deep:  'X.....x.........',
        sub_drop:   '..........X.....' },
      { snare:      '........X.......',
        clap:       '........o.......' },
      // The roll: three even hits inside one beat, then back to sixteenths.
      // Written at sixteenth resolution it is the nearest legal approximation,
      // which is worth being honest about — a true triplet needs a pattern
      // length divisible by three and this grid is not.
      { hat_closed: 'x.xxx.x.x.xxx.xx' },
      { perc_click: '....o.......o...',
        zap:        '..............x.' },
    ],
  },
  {
    name: 'Half Time',
    bpm: 76,
    description: 'Snare on 3 only, rolling hats, sub landing under the backbeat.',
    layers: [
      { kick_deep:  'X.....x...X.....',
        sub_drop:   '..........X.....' },
      { snare:      '........X.......' },
      { hat_closed: 'xxo.xx.oxxo.xx.x' },
      { crash:      'X...............',
        tom_low:    '..............o.' },
    ],
  },
];

/** The compiled presets, ready to hand to `audio.loadPattern`. */
export const PRESETS = AUTHORED.map(compile);

/** name -> compiled preset. */
export const PRESET_BY_NAME = new Map(PRESETS.map((p) => [p.name, p]));

/**
 * Load a preset into the four layers.
 *
 * Takes the audio module rather than importing it, for the same reason every
 * other module here does: this file should stay testable with a stub, and the
 * dependency direction stays one-way through main.js.
 *
 * Deep-copies on the way in. `PRESETS` is compiled once at load and would
 * otherwise be shared by reference with the live layers — record into a
 * preset, and the preset itself is permanently modified, so re-loading it
 * would not restore anything. Presets are a source; the layers are a working
 * copy.
 *
 * @param {{ loadPattern: Function, setBpm?: Function }} audio
 * @param {string} name
 * @param {{ withBpm?: boolean }} options
 */
export function loadPreset(audio, name, { withBpm = true } = {}) {
  const preset = PRESET_BY_NAME.get(name);
  if (!preset) {
    console.error(`[presets] no preset named "${name}"`);
    return false;
  }

  audio.snapshot()

  // The loop length has to move with the pattern, or a 16-step preset loaded
  // while the transport is set to four bars would play once and leave three
  // bars of silence behind it. The preset knows its own length; the engine is
  // told, rather than assuming.
  if (audio.setPatternLength) audio.setPatternLength(PATTERN_LENGTH);

  preset.patterns.forEach((pattern, index) => {
    audio.loadPattern(index, JSON.parse(JSON.stringify(pattern)));
  });

  if (withBpm && audio.setBpm) audio.setBpm(preset.bpm);
  return true;
}