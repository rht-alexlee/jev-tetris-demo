// Tetris engine with a gravity-driven active piece. No hard drops: the current
// piece is oriented and steered to a landing column by the decision layer, then
// descends one row per gravity tick (that fall is the visible motion). Pure
// logic, no DOM.

export const COLS = 10;
export const ROWS = 20;

// Each piece is a list of rotation states; a rotation is a list of [x, y]
// cells relative to the piece origin. Index 1..7 maps to a colour.
const SHAPES = {
  I: [
    [[0, 1], [1, 1], [2, 1], [3, 1]],
    [[2, 0], [2, 1], [2, 2], [2, 3]],
  ],
  O: [[[1, 0], [2, 0], [1, 1], [2, 1]]],
  T: [
    [[1, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [2, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [1, 2]],
    [[1, 0], [0, 1], [1, 1], [1, 2]],
  ],
  S: [
    [[1, 0], [2, 0], [0, 1], [1, 1]],
    [[1, 0], [1, 1], [2, 1], [2, 2]],
  ],
  Z: [
    [[0, 0], [1, 0], [1, 1], [2, 1]],
    [[2, 0], [1, 1], [2, 1], [1, 2]],
  ],
  J: [
    [[0, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [2, 2]],
    [[1, 0], [1, 1], [0, 2], [1, 2]],
  ],
  L: [
    [[2, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [1, 2], [2, 2]],
    [[0, 1], [1, 1], [2, 1], [0, 2]],
    [[0, 0], [1, 0], [1, 1], [1, 2]],
  ],
};

export const PIECES = Object.keys(SHAPES);
export const COLOR_OF = { I: 1, O: 2, T: 3, S: 4, Z: 5, J: 6, L: 7 };

const LINE_SCORE = [0, 100, 300, 500, 800];

export function cellsFor(type, rotation) {
  const states = SHAPES[type];
  return states[((rotation % states.length) + states.length) % states.length];
}

export function rotationCount(type) {
  return SHAPES[type].length;
}

export function emptyBoard() {
  return Array.from({ length: ROWS }, () => new Array(COLS).fill(0));
}

// --- geometry helpers -------------------------------------------------------

function fits(board, cells, ox, oy) {
  for (const [dx, dy] of cells) {
    const x = ox + dx;
    const y = oy + dy;
    if (x < 0 || x >= COLS || y >= ROWS) return false;
    if (y >= 0 && board[y][x]) return false;
  }
  return true;
}

function dropY(board, cells, ox) {
  let y = -2;
  while (fits(board, cells, ox, y + 1)) y++;
  return y;
}

function placeOnBoard(board, cells, ox, oy, color) {
  const next = board.map((row) => row.slice());
  for (const [dx, dy] of cells) {
    const x = ox + dx;
    const y = oy + dy;
    if (y >= 0) next[y][x] = color;
  }
  return next;
}

export function clearLines(board) {
  const kept = board.filter((row) => row.some((v) => !v));
  const cleared = ROWS - kept.length;
  while (kept.length < ROWS) kept.unshift(new Array(COLS).fill(0));
  return { board: kept, cleared };
}

// --- board feature analysis -------------------------------------------------

function columnHeights(board) {
  const heights = new Array(COLS).fill(0);
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (board[r][c]) {
        heights[c] = ROWS - r;
        break;
      }
    }
  }
  return heights;
}

export function analyzeBoard(board) {
  const heights = columnHeights(board);
  let holes = 0;
  for (let c = 0; c < COLS; c++) {
    let seen = false;
    for (let r = 0; r < ROWS; r++) {
      if (board[r][c]) seen = true;
      else if (seen) holes++;
    }
  }
  let bumpiness = 0;
  for (let c = 0; c < COLS - 1; c++) {
    bumpiness += Math.abs(heights[c] - heights[c + 1]);
  }
  const aggregate = heights.reduce((a, b) => a + b, 0);
  return { heights, holes, bumpiness, aggregate, maxHeight: Math.max(0, ...heights) };
}

// El-Tetris style linear evaluation: higher is better.
export function heuristicScore(f) {
  return 0.76 * f.lines - 0.51 * f.aggregate - 0.36 * f.holes - 0.18 * f.bumpiness;
}

// Resulting features if `type` at `rotation` is dropped so its leftmost cell
// sits at column `left`. null if that column is unreachable.
function landingAt(board, type, rotation, left) {
  const cells = cellsFor(type, rotation);
  const minX = Math.min(...cells.map((c) => c[0]));
  const ox = left - minX;
  const oy = dropY(board, cells, ox);
  if (!fits(board, cells, ox, oy)) return null;
  const landed = placeOnBoard(board, cells, ox, oy, COLOR_OF[type]);
  const { board: after, cleared } = clearLines(landed);
  const features = { ...analyzeBoard(after), lines: cleared };
  return { left, ox, oy, rotation, cells, features, score: heuristicScore(features) };
}

function pieceWidth(type, rotation) {
  const xs = cellsFor(type, rotation).map((c) => c[0]);
  return Math.max(...xs) - Math.min(...xs) + 1;
}

// --- 7-bag randomiser -------------------------------------------------------

export class Bag {
  constructor() {
    this.queue = [];
  }
  _refill() {
    const bag = PIECES.slice();
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    this.queue.push(...bag);
  }
  next() {
    if (this.queue.length === 0) this._refill();
    return this.queue.shift();
  }
  peek(n = 1) {
    while (this.queue.length < n) this._refill();
    return this.queue.slice(0, n);
  }
}

// --- game state -------------------------------------------------------------

export class Game {
  constructor() {
    this.reset();
  }

  reset() {
    this.board = emptyBoard();
    this.bag = new Bag();
    this.score = 0;
    this.lines = 0;
    this.pieces = 0;
    this.over = false;
    this.spawn();
  }

  get level() {
    return Math.floor(this.lines / 10) + 1;
  }

  nextPieces(n) {
    return this.bag.peek(n);
  }

  // Bring in the next piece at the top, orientation 0, horizontally centred.
  spawn() {
    this.current = this.bag.next();
    this.rotation = 0;
    const w = pieceWidth(this.current, 0);
    const minX = Math.min(...cellsFor(this.current, 0).map((c) => c[0]));
    this.px = Math.floor((COLS - w) / 2) - minX;
    this.py = 0;
    if (!fits(this.board, cellsFor(this.current, 0), this.px, this.py)) {
      this.over = true;
    }
  }

  activeCells() {
    return cellsFor(this.current, this.rotation).map(([dx, dy]) => [
      this.px + dx,
      this.py + dy,
    ]);
  }

  // Where the active piece would come to rest right now (for the ghost).
  ghostCells() {
    const cells = cellsFor(this.current, this.rotation);
    const oy = dropY(this.board, cells, this.px);
    return cells.map(([dx, dy]) => [this.px + dx, oy + dy]);
  }

  // Distinct orientations of the current piece, each with the best landing it
  // could reach -- used to describe the orientation decision.
  orientationOptions() {
    const out = [];
    for (let rot = 0; rot < rotationCount(this.current); rot++) {
      const cols = this.columnOptions(rot);
      if (cols.length === 0) continue;
      const best = cols.reduce((a, b) => (b.score > a.score ? b : a));
      out.push({ rotation: rot, best, columns: cols });
    }
    return out;
  }

  // Reachable landing columns for a given orientation, left-to-right.
  columnOptions(rotation) {
    const w = pieceWidth(this.current, rotation);
    const out = [];
    for (let left = 0; left <= COLS - w; left++) {
      const place = landingAt(this.board, this.current, rotation, left);
      if (place) out.push(place);
    }
    return out;
  }

  // Commit the two decisions: orient the piece and steer it to a column. The
  // piece stays at the top and then descends under gravity.
  applyDecision(rotation, ox) {
    this.rotation = rotation;
    this.px = ox;
    this.py = 0;
    if (!fits(this.board, cellsFor(this.current, rotation), ox, 0)) {
      // Top is blocked in that column: rest it immediately.
      this.py = dropY(this.board, cellsFor(this.current, rotation), ox);
    }
  }

  // One gravity tick. Returns "fall" if it moved down, "locked" if it settled.
  gravityStep() {
    const cells = cellsFor(this.current, this.rotation);
    if (fits(this.board, cells, this.px, this.py + 1)) {
      this.py += 1;
      return "fall";
    }
    this._lock();
    return "locked";
  }

  _lock() {
    const cells = cellsFor(this.current, this.rotation);
    const toppedOut = cells.some(([, dy]) => this.py + dy < 0);
    const landed = placeOnBoard(this.board, cells, this.px, this.py, COLOR_OF[this.current]);
    const { board, cleared } = clearLines(landed);
    this.board = board;
    this.lines += cleared;
    this.score += LINE_SCORE[cleared] * this.level;
    this.pieces += 1;
    this.lastCleared = cleared;
    if (toppedOut) this.over = true;
    else this.spawn();
  }
}
