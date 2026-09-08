
/**
  sequencer.js — the step grid.
  
  Four layer rows by up to sixty-four step cells, with a moving playhead, a
  record arm per row, and click-to-edit on every cell.
*/

import { bus } from './events.js';
import { PADS, PAD_BY_ID } from './pads.js';

/** Every hit is drawn in its pad's own hue, so a row is readable as a kit. */
function hueCss(hue, lightness = 62) {
  return `hsl(${Math.round(hue * 360)}, 78%, ${lightness}%)`;
}

/**
  @param {{ audio: any, container?: HTMLElement }} deps
 */
export function initSequencer({ audio, container = document.body }) {
  // ---------
  // Structure
  // ---------

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

  // -------------------
  // Building the matrix
  // -------------------

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

  // --------
  // Painting
  // --------

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
        cell.style.background = hueCss(pad?.hue ?? 0, 34 + hit.velocity * 34);
        cell.textContent = slot.length > 1 ? String(slot.length) : '';
        cell.title = slot.map((h) => PAD_BY_ID.get(h.padId)?.label ?? h.padId).join(', ');
      });

      view.dot.classList.toggle('is-filled', filled > 0);
      view.head.classList.toggle('is-muted', layer.muted);
      view.head.classList.toggle('is-solo', layer.solo);
      view.row.classList.toggle('is-selected', index === selectedLayer);
    });
  }

  // -------
  // Editing
  // -------

  function editCell(cell, remove) {
    const layer = Number(cell.dataset.layer);
    const step = Number(cell.dataset.step);
    selectedLayer = layer;

    if (remove) {
      if (!audio.removeStep(layer, step, selectedPad)) {
        audio.removeStep(layer, step);
      }
      return;
    }

    if (audio.addStep(layer, step, selectedPad)) audio.audition(selectedPad, 0.9);
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

  // -------------
  // Transport bar
  // -------------

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

  // --------------
  // The state line
  // --------------

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

  // -------------
  // Subscriptions
  // -------------

  let playhead = -1;

  bus.on('transport:step', ({ step }) => {
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
    The draw-pad follows what you play.
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