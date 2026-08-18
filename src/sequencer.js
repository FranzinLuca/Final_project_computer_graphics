/**
 * sequencer.js — the step grid.
 *
 * Four layer rows by up to sixty-four step cells, with a moving playhead, a
 * record arm per row, and click-to-edit on every cell.
 *
 *
 * WHY THIS EXISTS, AND WHY IT IS THE FIX FOR FOUR SEPARATE COMPLAINTS
 *
 * The recording workflow was reported as four bugs. They were one bug: the
 * sequencer's state was entirely invisible, so every question a user has while
 * recording had no answer on screen.
 *
 *   "I don't know when recording starts or stops"  -> no interval was shown
 *   "I can't turn recording off"                   -> arm was a five-state cycle
 *   "I don't know which layers have anything in"   -> patterns were never drawn
 *   "I lost my recording behind a preset"          -> no undo, and no view of it
 *
 * Three of those four are display problems and the fourth is made survivable
 * by being visible. So the engine got a real record interval and an undo (in
 * audio.js), and this module draws everything the engine knows.
 *
 *
 * WHY DOM AND NOT lil-gui, AND NOT A TEXTURE IN THE SCENE
 *
 * lil-gui is a good control panel and a bad grid: it lays out one labelled row
 * per control, so a 4x64 matrix would be 256 rows. The panel keeps the things
 * it is good at — sliders, toggles, folders — and the matrix moves here.
 *
 * Drawing it into the scene, on the instrument's own display, was the more
 * elegant-sounding option and is worse. A grid is a precision pointing target:
 * a cell would be a few pixels across, on a surface seen in perspective, at an
 * angle the user is free to orbit away from, and hit-testing it would mean
 * raycasting into UV space and inverting the projection. The browser already
 * does pointer hit-testing on rectangles perfectly. The scene is for the
 * instrument; the grid is a tool for operating it, and tools are allowed to be
 * flat.
 *
 *
 * WHAT THIS MODULE MAY AND MAY NOT DO
 *
 * It holds NO pattern state. Every cell is drawn from `audio.layers` and every
 * edit is a call into audio.js; the grid is a view, exactly as ui.js is. If
 * this file kept its own copy of the pattern, a hit recorded from a key press
 * would not appear until something happened to refresh it, and the two copies
 * would drift — which is the same failure the panel was designed to avoid.
 *
 * The one piece of state it does own is which pad is SELECTED for drawing, and
 * that is genuinely a property of the editor rather than of the music.
 */

import { bus } from './events.js';
import { PADS, PAD_BY_ID } from './pads.js';

/** Every hit is drawn in its pad's own hue, so a row is readable as a kit. */
function hueCss(hue, lightness = 62) {
  return `hsl(${Math.round(hue * 360)}, 78%, ${lightness}%)`;
}

/**
 * @param {{ audio: any, container?: HTMLElement }} deps
 */
export function initSequencer({ audio, container = document.body }) {
  // -----------------------------------------------------------------------
  // Structure
  // -----------------------------------------------------------------------

  const root = document.createElement('div');
  root.id = 'seq';
  root.className = 'is-open';
  container.appendChild(root);

  root.innerHTML = `
    <div class="seq-bar">
      <button class="seq-btn" data-act="play">Play</button>
      <button class="seq-btn seq-rec" data-act="rec">Record</button>
      <span class="seq-state" data-role="state">Stopped</span>
      <span class="seq-spacer"></span>
      <label class="seq-field">Length
        <select data-act="length">
          <option value="16">1 bar</option>
          <option value="32">2 bars</option>
          <option value="64">4 bars</option>
        </select>
      </label>
      <label class="seq-field">Draw
        <select data-act="pad"></select>
      </label>
      <span class="seq-hint">left-click adds &middot; right-click removes</span>
      <button class="seq-btn" data-act="undo" disabled>Undo</button>
      <button class="seq-btn seq-collapse" data-act="collapse" title="Hide">–</button>
    </div>
    <div class="seq-grid" data-role="grid"></div>
  `;

  const grid = root.querySelector('[data-role="grid"]');
  const stateEl = root.querySelector('[data-role="state"]');
  const padSelect = root.querySelector('[data-act="pad"]');
  const lengthSelect = root.querySelector('[data-act="length"]');
  const undoButton = root.querySelector('[data-act="undo"]');
  const playButton = root.querySelector('[data-act="play"]');
  const recButton = root.querySelector('[data-act="rec"]');

  for (const pad of PADS) {
    const option = document.createElement('option');
    option.value = pad.id;
    option.textContent = pad.label;
    padSelect.appendChild(option);
  }

  /** The pad a click on an empty cell writes. Follows whatever you last played. */
  let selectedPad = PADS[0].id;

  /** Which row the Record button arms. Follows the last row you touched. */
  let selectedLayer = 0;

  /** @type {Array<{ row: HTMLElement, cells: HTMLElement[], arm: HTMLElement, dot: HTMLElement }>} */
  let rows = [];

  // -----------------------------------------------------------------------
  // Building the matrix
  //
  // Rebuilt only when the LENGTH changes, never on a content change. Cell
  // contents are updated in place by `paint()` below, because rebuilding 256
  // elements on every recorded hit would drop frames and would also destroy
  // the element the pointer is currently over, cancelling the click.
  // -----------------------------------------------------------------------

  function build() {
    const length = audio.getPatternLength();
    grid.innerHTML = '';
    rows = [];

    // A ruler, so the bar lines are legible without counting cells.
    const ruler = document.createElement('div');
    ruler.className = 'seq-row seq-ruler';
    ruler.innerHTML = '<div class="seq-head"></div>';
    const rulerCells = document.createElement('div');
    rulerCells.className = 'seq-cells';
    rulerCells.style.setProperty('--steps', length);

    for (let step = 0; step < length; step++) {
      const tick = document.createElement('div');
      tick.className = 'seq-tick';
      if (step % 16 === 0) {
        tick.classList.add('is-bar');
        tick.textContent = String(step / 16 + 1);
      } else if (step % 4 === 0) {
        tick.classList.add('is-beat');
      }
      rulerCells.appendChild(tick);
    }
    ruler.appendChild(rulerCells);
    grid.appendChild(ruler);

    audio.layers.forEach((layer, index) => {
      const row = document.createElement('div');
      row.className = 'seq-row';

      const head = document.createElement('div');
      head.className = 'seq-head';
      head.innerHTML = `
        <span class="seq-dot" data-role="dot"></span>
        <span class="seq-name">L${index + 1}</span>
        <button class="seq-mini seq-arm" data-act="arm" title="Arm this layer for recording">●</button>
        <button class="seq-mini" data-act="mute" title="Mute">M</button>
        <button class="seq-mini" data-act="solo" title="Solo">S</button>
        <button class="seq-mini" data-act="clear" title="Clear this layer">✕</button>
      `;
      row.appendChild(head);

      const cells = document.createElement('div');
      cells.className = 'seq-cells';
      cells.style.setProperty('--steps', length);

      const cellEls = [];
      for (let step = 0; step < length; step++) {
        const cell = document.createElement('button');
        cell.className = 'seq-cell';
        cell.dataset.step = String(step);
        cell.dataset.layer = String(index);
        if (step % 16 === 0) cell.classList.add('is-bar');
        else if (step % 4 === 0) cell.classList.add('is-beat');
        cells.appendChild(cell);
        cellEls.push(cell);
      }

      row.appendChild(cells);
      grid.appendChild(row);

      rows.push({
        row,
        cells: cellEls,
        arm: head.querySelector('[data-act="arm"]'),
        dot: head.querySelector('[data-role="dot"]'),
        head,
      });
    });

    paint();
  }

  // -----------------------------------------------------------------------
  // Painting
  //
  // Coalesced into one animation frame. `layers:changed` fires on gain, mute,
  // solo, clear, load and every edit — during a drag on a layer gain slider
  // that is sixty events a second, and repainting 256 cells on each would be
  // sixty pointless full passes. Setting a flag and repainting once before the
  // next paint is the standard fix and costs one boolean.
  // -----------------------------------------------------------------------

  let painting = false;

  function schedulePaint() {
    if (painting) return;
    painting = true;
    requestAnimationFrame(() => {
      painting = false;
      paint();
    });
  }

  function paint() {
    if (rows.length === 0) return;

    audio.layers.forEach((layer, index) => {
      const view = rows[index];
      if (!view) return;

      const pattern = layer.pattern;
      let filled = 0;

      view.cells.forEach((cell, step) => {
        const slot = pattern.steps[step] ?? [];
        const hit = slot[0];

        if (!hit) {
          cell.style.background = '';
          cell.classList.remove('is-on');
          cell.textContent = '';
          cell.title = '';
          return;
        }

        filled += 1;
        const pad = PAD_BY_ID.get(hit.padId);
        cell.classList.add('is-on');
        // Velocity drives lightness, so a ghost note is visibly a ghost note.
        // The pattern notation in presets.js encodes exactly three velocity
        // levels and this is the same information drawn instead of typed.
        cell.style.background = hueCss(pad?.hue ?? 0, 34 + hit.velocity * 34);
        // More than one pad on a step is common and legal — the grid shows the
        // first and counts the rest, rather than pretending a step holds one
        // note. Hovering names them all.
        cell.textContent = slot.length > 1 ? String(slot.length) : '';
        cell.title = slot.map((h) => PAD_BY_ID.get(h.padId)?.label ?? h.padId).join(', ');
      });

      // The "which layers have anything in them" readout, and the reason the
      // dot is on the row header rather than in a tooltip: it has to be
      // answerable at a glance, without hovering four things.
      view.dot.classList.toggle('is-filled', filled > 0);
      view.head.classList.toggle('is-muted', layer.muted);
      view.head.classList.toggle('is-solo', layer.solo);
      view.row.classList.toggle('is-selected', index === selectedLayer);
    });
  }

  // -----------------------------------------------------------------------
  // Editing
  // -----------------------------------------------------------------------

  /**
   * LEFT ADDS, RIGHT REMOVES.
   *
   * It was a toggle, and a toggle is the wrong verb for a grid where a cell
   * can hold more than one note. With one mouse button the only thing a click
   * can express is "flip whatever is under the pointer", so putting a snare on
   * a step that already has a kick, or taking the kick off and leaving the
   * snare, needed the pad selector changed first and then a click that might
   * do either thing depending on state you could not see.
   *
   * Two buttons is two verbs, and both become unconditional: left always
   * writes the selected pad, right always takes something away. Neither
   * depends on what is already there, which means neither can surprise you —
   * the same property that makes the arm toggle better than the five-state
   * cycle it replaced.
   */
  function editCell(cell, remove) {
    const layer = Number(cell.dataset.layer);
    const step = Number(cell.dataset.step);
    selectedLayer = layer;

    if (remove) {
      // Prefer the selected pad; fall back to the last note on the step, so a
      // right-click always does something visible even when the selector is
      // pointing at a pad that is not on this cell.
      if (!audio.removeStep(layer, step, selectedPad)) {
        audio.removeStep(layer, step);
      }
      return;
    }

    /**
     * Audition on write.
     *
     * Placing a note plays it, once, immediately. Drawing a pattern otherwise
     * means writing in silence and finding out what it sounds like a bar
     * later, which is the difference between composing and typing. It goes
     * through `audio.trigger`, so it is a live hit on the master bus and is
     * heard even if the layer being drawn into is muted.
     */
    if (audio.addStep(layer, step, selectedPad)) audio.trigger(selectedPad, 0.9);
  }

  grid.addEventListener('click', (event) => {
    const target = event.target;

    const cell = target.closest('.seq-cell');
    if (cell) {
      editCell(cell, false);
      return;
    }

    const action = target.dataset?.act;
    if (!action) return;

    const row = target.closest('.seq-row');
    const index = rows.findIndex((r) => r.row === row);
    if (index < 0) return;

    selectedLayer = index;

    if (action === 'arm') audio.toggleArm(index);
    else if (action === 'mute') audio.setMute(index, !audio.layers[index].muted);
    else if (action === 'solo') audio.setSolo(index, !audio.layers[index].solo);
    else if (action === 'clear') audio.clearLayer(index);

    schedulePaint();
  });

  // -----------------------------------------------------------------------
  // Transport bar
  // -----------------------------------------------------------------------

  /**
   * The right button, and the browser menu it would otherwise open.
   *
   * `contextmenu` rather than `mousedown` with `button === 2`, because
   * contextmenu is the event the platform actually fires for "the secondary
   * action" — it is what a two-finger tap on a trackpad and a long-press on
   * some touch devices produce, where a raw button check catches only a real
   * right mouse button.
   *
   * `preventDefault` only over a cell. Suppressing the menu across the whole
   * panel would take away copy, paste and inspect everywhere else in it for no
   * reason.
   */
  grid.addEventListener('contextmenu', (event) => {
    const cell = event.target.closest?.('.seq-cell');
    if (!cell) return;
    event.preventDefault();
    editCell(cell, true);
  });

  root.querySelector('.seq-bar').addEventListener('click', (event) => {
    const action = event.target.dataset?.act;
    if (action === 'play') bus.emit('transport:toggle', {});
    else if (action === 'rec') audio.toggleArm(selectedLayer);
    else if (action === 'undo') audio.undo();
    else if (action === 'collapse') root.classList.toggle('is-open');
  });

  padSelect.addEventListener('change', () => { selectedPad = padSelect.value; });

  lengthSelect.addEventListener('change', () => {
    audio.setPatternLength(Number(lengthSelect.value));
  });

  // -----------------------------------------------------------------------
  // The state line
  //
  // One sentence that always says what the machine is doing. It is the single
  // highest-value element here: "I don't know when it starts" and "I don't
  // know when to stop playing" are both answered by a line of text, and no
  // amount of grid design substitutes for saying it.
  // -----------------------------------------------------------------------

  function describe() {
    const state = audio.getRecordState();

    if (state.countingIn) {
      stateEl.textContent = `Count-in… recording into L${state.armed + 1} in ${state.countIn}`;
      stateEl.className = 'seq-state is-countin';
    } else if (state.capturing) {
      const bars = state.length / audio.STEPS_PER_BAR;
      stateEl.textContent =
        `Recording L${state.armed + 1} · bar ${(state.bar % bars) + 1} of ${bars}`;
      stateEl.className = 'seq-state is-rec';
    } else if (state.running) {
      stateEl.textContent = 'Playing';
      stateEl.className = 'seq-state is-play';
    } else {
      stateEl.textContent = 'Stopped';
      stateEl.className = 'seq-state';
    }

    playButton.textContent = state.running ? 'Stop' : 'Play';
    recButton.classList.toggle('is-active', state.armed !== null);
    recButton.textContent = state.armed === null ? 'Record' : `Rec L${state.armed + 1}`;

    rows.forEach((view, index) => {
      view.arm.classList.toggle('is-armed', state.armed === index);
    });
  }

  // -----------------------------------------------------------------------
  // Subscriptions
  // -----------------------------------------------------------------------

  let playhead = -1;

  bus.on('transport:step', ({ step }) => {
    // One class off, one class on. Touching two elements per step rather than
    // repainting the row is what keeps this free at 64 steps and 200 bpm.
    if (playhead >= 0) {
      for (const view of rows) view.cells[playhead]?.classList.remove('is-now');
    }
    playhead = step;
    for (const view of rows) view.cells[playhead]?.classList.add('is-now');

    // The bar counter moves, so the line is refreshed with it.
    describe();
  });

  bus.on('layers:changed', schedulePaint);
  bus.on('record:hit', schedulePaint);
  bus.on('transport:start', describe);
  bus.on('transport:stop', () => {
    if (playhead >= 0) {
      for (const view of rows) view.cells[playhead]?.classList.remove('is-now');
    }
    playhead = -1;
    describe();
  });
  bus.on('record:armed', () => { describe(); schedulePaint(); });
  bus.on('record:countin', describe);
  bus.on('record:start', describe);
  bus.on('record:stop', describe);

  bus.on('pattern:length', ({ length }) => {
    lengthSelect.value = String(length);
    build();
  });

  bus.on('history:changed', ({ canUndo }) => {
    undoButton.disabled = !canUndo;
  });

  /**
   * The draw-pad follows what you play.
   *
   * Playing a pad and then clicking cells is the workflow this supports: you
   * audition a sound on the instrument, then write it into the grid without
   * having to find it again in a dropdown. Only LIVE hits change it —
   * following the sequencer's own output would make the selection flicker
   * through the whole kit every bar.
   */
  bus.on('pad:hit', ({ padId, source }) => {
    if (source !== 'live') return;
    selectedPad = padId;
    padSelect.value = padId;
  });

  build();
  describe();

  return {
    root,
    refresh: () => { build(); describe(); },
    setLayer: (index) => { selectedLayer = index; paint(); },
    getLayer: () => selectedLayer,
    destroy: () => root.remove(),
  };
}