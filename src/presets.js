/**
  presets.js — patterns, written in drum notation and compiled.
  
  Patterns are made in the notation every drum machine and every
  sequencer has used since the 1980s, one row per voice, one character per
  sixteenth
 
    kick_deep:  'X..x....X...x...'
    snare:      '....X.......X...'
    hat_closed: 'x.x.x.x.x.x.x.x.'
  
  THE NOTATION
 
    X   accent      velocity 1.00
    x   normal      velocity 0.75
    o   ghost       velocity 0.45
    .   rest        (also '-' and ' ')
*/

// --------
// Notation
// --------

export const PATTERN_LENGTH = 16;

const VELOCITY = {
  X: 1.00,
  x: 0.75,
  o: 0.45,
};

const REST = new Set(['.', '-', ' ', '_']);

// ------------
// The compiler
// ------------

/**
  Compile one layer into a pattern.
 
  @param {Record<string, string>} rows
  @param {string} label  used only in error messages
  @returns {{ length: number, steps: Array<Array<{padId: string, velocity: number}>> }}
*/
export function compileLayer(rows, label = 'pattern') {
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

// ------------
// The patterns
// ------------

/** 
  Layer roles are consistent across all three presets:

   L1  foundation   kicks and sub
   L2  backbeat     snare, clap, rim
   L3  cymbals      hats and ride
   L4  colour       percussion and effects
*/

const AUTHORED = [
  {
    name: 'Boom Bap',
    bpm: 92,
    description: 'Ghosted hats, syncopated kick, snare on 2 and 4.',
    layers: [
      { kick_deep:  'X..x....X...x...' },
      { snare:      '....X.......X...',
        rim:        '..........o.....' },
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
      { kick_deep:  'X.....x.........',
        sub_drop:   '..........X.....' },
      { snare:      '........X.......',
        clap:       '........o.......' },
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
  Load a preset into the four layers
  
  @param {{ loadPattern: Function, setBpm?: Function }} audio
  @param {string} name
  @param {{ withBpm?: boolean }} options
*/
export function loadPreset(audio, name, { withBpm = true } = {}) {
  const preset = PRESET_BY_NAME.get(name);
  if (!preset) {
    console.error(`[presets] no preset named "${name}"`);
    return false;
  }

  audio.snapshot()

  if (audio.setPatternLength) audio.setPatternLength(PATTERN_LENGTH);

  preset.patterns.forEach((pattern, index) => {
    audio.loadPattern(index, JSON.parse(JSON.stringify(pattern)));
  });

  if (withBpm && audio.setBpm) audio.setBpm(preset.bpm);
  return true;
}