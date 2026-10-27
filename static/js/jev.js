// Decision layer + UI. Each piece triggers two structured /v1/systemone
// "choice" decisions -- first an orientation (Keep / Rotate N times), then a
// landing column (move N) -- after which the piece falls naturally under
// gravity. A reachable decision-model endpoint is required: if none is set or
// a call fails, the run stops and surfaces the error (no local fallback).

import { Game, COLS, ROWS, COLOR_OF, rotationCount } from "./tetris.js";

const COLORS = {
  0: "#0d1424",
  1: "#22d3ee", // I
  2: "#facc15", // O
  3: "#a855f7", // T
  4: "#4ade80", // S
  5: "#f87171", // Z
  6: "#60a5fa", // J
  7: "#fb923c", // L
};
const CELL_PREVIEW = {
  I: [[0, 1], [1, 1], [2, 1], [3, 1]],
  O: [[1, 0], [2, 0], [1, 1], [2, 1]],
  T: [[1, 0], [0, 1], [1, 1], [2, 1]],
  S: [[1, 0], [2, 0], [0, 1], [1, 1]],
  Z: [[0, 0], [1, 0], [1, 1], [2, 1]],
  J: [[0, 0], [0, 1], [1, 1], [2, 1]],
  L: [[2, 0], [0, 1], [1, 1], [2, 1]],
};

const BOARD_CELL = 26; // px per cell on the board and the next-piece previews
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function orientLabel(rot) {
  return rot === 0 ? "Keep orientation" : `Rotate ${rot} time${rot > 1 ? "s" : ""}`;
}
function columnLabel(left) {
  return `move ${left}`;
}
function feat(f) {
  const l = f.lines > 0 ? `clears ${f.lines} line${f.lines > 1 ? "s" : ""}, ` : "clears 0 lines, ";
  return `${l}${f.holes} holes, max height ${f.maxHeight}, bumpiness ${f.bumpiness}`;
}

// --- decision request/response ---------------------------------------------

function boardRows(board) {
  return board.map((row) => row.map((v) => (v ? "#" : ".")).join(""));
}

// options: [{ key, label, desc, features }]
// The /v1/systemone body only accepts state / questions / images / videos /
// states / options -- any other top-level field (e.g. seed) is a 400.
function buildRequest(game, stage, qid, instructions, options) {
  const criteria = {};
  for (const o of options) criteria[o.key] = o.desc;
  return {
    model: "jev-latest",
    state: {
      stage,
      piece: game.current,
      next: game.nextPieces(3),
      board_rows: boardRows(game.board),
    },
    questions: { [qid]: { type: "choice", instructions, criteria } },
  };
}

async function liveDecision(cfg, body, qid, options) {
  const resp = await fetch("/api/decide", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      endpoint: cfg.endpoint,
      model: cfg.model,
      apiKey: cfg.apiKey,
      body,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.detail ? `${data.error} - ${data.detail}` : data.error || `HTTP ${resp.status}`);
  }
  const answer = data.response?.answers?.[qid];
  if (!answer || !answer.probabilities) {
    throw new Error(`endpoint response missing answers.${qid}.probabilities`);
  }
  const probabilities = {};
  for (const o of options) probabilities[o.key] = answer.probabilities[o.key] ?? 0;
  return {
    latency_ms: data.response?.diagnostics?.timing?.total_ms ?? data.latency_ms,
    choiceKey: answer.choice,
    probabilities,
    confidence: answer.confidence,
    request: body,
    response: data.response,
  };
}

// A reachable decision-model endpoint is required; failures propagate so the
// run stops and surfaces the error (no local fallback).
async function decide(cfg, body, qid, options) {
  if (!cfg.endpoint) throw new Error("no decision-model endpoint configured");
  return liveDecision(cfg, body, qid, options);
}

// --- rendering --------------------------------------------------------------

class Renderer {
  constructor(canvas, cell) {
    this.ctx = canvas.getContext("2d");
    this.cell = cell;
    canvas.width = COLS * cell;
    canvas.height = ROWS * cell;
  }
  draw(board, active, activeColor, ghost) {
    const { ctx, cell } = this;
    ctx.clearRect(0, 0, COLS * cell, ROWS * cell);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        ctx.fillStyle = COLORS[0];
        ctx.fillRect(c * cell + 1, r * cell + 1, cell - 2, cell - 2);
      }
    }
    if (ghost) {
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = COLORS[activeColor];
      for (const [x, y] of ghost) {
        if (y >= 0) ctx.fillRect(x * cell + 1, y * cell + 1, cell - 2, cell - 2);
      }
      ctx.globalAlpha = 1;
    }
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (board[r][c]) this._block(c, r, COLORS[board[r][c]]);
      }
    }
    if (active) {
      for (const [x, y] of active) {
        if (y >= 0) this._block(x, y, COLORS[activeColor]);
      }
    }
  }
  _block(c, r, color) {
    const { ctx, cell } = this;
    ctx.fillStyle = color;
    ctx.fillRect(c * cell + 1, r * cell + 1, cell - 2, cell - 2);
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(c * cell + 1, r * cell + 1, cell - 2, 3);
  }
}

// Blocks are drawn at the same cell size as the board, and the canvas is sized
// tightly to the piece so the preview takes no more room than the piece itself.
function drawPreview(canvas, type) {
  const ctx = canvas.getContext("2d");
  const cell = BOARD_CELL;
  if (!type) {
    canvas.width = cell;
    canvas.height = cell;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const cells = CELL_PREVIEW[type];
  const xs = cells.map((c) => c[0]);
  const ys = cells.map((c) => c[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const w = Math.max(...xs) - minX + 1;
  const h = Math.max(...ys) - minY + 1;
  canvas.width = w * cell;
  canvas.height = h * cell;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = COLORS[COLOR_OF[type]];
  for (const [x, y] of cells) {
    const cx = (x - minX) * cell;
    const cy = (y - minY) * cell;
    ctx.fillRect(cx + 1, cy + 1, cell - 2, cell - 2);
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(cx + 1, cy + 1, cell - 2, 3);
    ctx.fillStyle = COLORS[COLOR_OF[type]];
  }
}

function renderDecision(stage, options, decision) {
  $("decision-stage").textContent =
    stage === "orientation" ? "Orientation" : "Landing column";
  const chosen = options.find((o) => o.key === decision.choiceKey) || options[0];
  $("chosen-move").textContent = chosen.label;
  $("decision-desc").textContent =
    stage === "orientation"
      ? `Set ${orientLabel(chosen.key === "0" ? 0 : Number(chosen.key)).toLowerCase()}; then choose a landing column next.`
      : `Move horizontally to column ${chosen.key}; continue falling naturally. If it lands here, ${feat(chosen.features)}.`;

  const list = $("prob-list");
  list.innerHTML = "";
  const rows = options
    .map((o) => ({ o, prob: decision.probabilities[o.key] ?? 0 }))
    .sort((a, b) => b.prob - a.prob);
  for (const { o, prob } of rows) {
    const row = document.createElement("div");
    row.className = "prob-row" + (o.key === decision.choiceKey ? " chosen" : "");
    row.innerHTML = `
      <span class="prob-label">${o.label}</span>
      <div class="prob-track"><div class="prob-fill" style="width:${(prob * 100).toFixed(1)}%"></div></div>
      <span class="prob-pct">${(prob * 100).toFixed(1)}%</span>`;
    list.appendChild(row);
  }

  $("confidence").textContent = `${(decision.confidence * 100).toFixed(1)}%`;
  $("note").style.display = "none";
  $("raw-json").textContent = JSON.stringify(
    { request: decision.request, response: decision.response },
    null,
    2
  );
}

// --- controller -------------------------------------------------------------

class Controller {
  constructor() {
    this.game = new Game();
    this.renderer = new Renderer($("board"), BOARD_CELL);
    this.running = false;
    this.looping = false;
    this.decided = false;
    this.decisions = 0;
    this.latencies = [];
    this.render();
    this.updateStats();
    this.updateSpeedReadout();
  }

  config() {
    return {
      endpoint: $("endpoint").value.trim(),
      model: $("model").value.trim(),
      apiKey: $("apikey").value.trim(),
    };
  }

  dropIntervalMs() {
    const base = Number($("speed").value); // ms per row at 1x
    // Ramp up quickly with pieces played (and faster still as lines clear).
    const mult = Math.min(10, 1 + this.game.pieces * 0.12 + this.game.lines * 0.25);
    return { ms: Math.max(12, base / mult), mult };
  }

  updateSpeedReadout() {
    const { ms, mult } = this.dropIntervalMs();
    $("speed-readout").textContent = `${mult.toFixed(2)}x drop speed - ${ms.toFixed(0)} ms / row`;
  }

  render() {
    const g = this.game;
    const active = g.over ? null : g.activeCells();
    const ghost = g.over ? null : g.ghostCells();
    this.renderer.draw(g.board, active, COLOR_OF[g.current], ghost);
    const nx = g.nextPieces(3);
    drawPreview($("next0"), nx[0]);
    drawPreview($("next1"), nx[1]);
    drawPreview($("next2"), nx[2]);
  }

  updateStats() {
    $("score").textContent = this.game.score;
    $("lines").textContent = this.game.lines;
    $("pieces").textContent = this.game.pieces;
    $("decisions").textContent = this.decisions;
  }

  recordLatency(ms) {
    this.latencies.push(ms);
    if (this.latencies.length > 50) this.latencies.shift();
    const avg = this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length;
    $("latency").textContent = `${ms.toFixed(0)} ms`;
    $("latency-avg").textContent = `${avg.toFixed(0)} ms`;
    $("calls").textContent = `${this.decisions} calls`;
  }

  setStatus(text) {
    $("status").textContent = text;
  }

  // Run one decision stage. A `choice` needs >= 2 options, so when only one
  // placement is possible we pick it directly instead of asking the model
  // (a single-option choice is rejected as malformed).
  async runStage(stage, qid, instructions, choices) {
    if (choices.length === 1) {
      const only = choices[0];
      const decision = {
        choiceKey: only.key,
        probabilities: { [only.key]: 1 },
        confidence: 1,
        latency_ms: 0,
        request: null,
        response: { auto_selected: "only one option available" },
      };
      renderDecision(stage, choices, decision);
      return only;
    }
    const body = buildRequest(this.game, stage, qid, instructions, choices);
    const decision = await decide(this.config(), body, qid, choices);
    this.decisions += 1;
    this.recordLatency(decision.latency_ms);
    renderDecision(stage, choices, decision);
    return choices.find((c) => c.key === decision.choiceKey) || choices[0];
  }

  // Two structured decisions, then steer the piece into position.
  async decidePiece() {
    const g = this.game;

    // 1. orientation
    const oriOpts = g.orientationOptions();
    if (oriOpts.length === 0) {
      g.over = true;
      return;
    }
    const orientChoices = oriOpts.map((o) => ({
      key: String(o.rotation),
      label: orientLabel(o.rotation),
      features: o.best.features,
      desc: `${orientLabel(o.rotation)}: best landing ${feat(o.best.features)}.`,
    }));
    this.setStatus(`Asking JEV how to orient ${g.current}...`);
    const oriPick = await this.runStage(
      "orientation",
      "rotate",
      "You are playing Tetris. Choose how to orient the current piece before it " +
        "falls. The landing column is chosen in the next decision.",
      orientChoices
    );
    let rot = Number(oriPick.key);
    if (!Number.isInteger(rot) || rot < 0 || rot >= rotationCount(g.current)) {
      rot = oriOpts[0].rotation;
    }
    g.rotation = rot; // preview the orientation at the top
    this.render();
    await sleep(260);

    // 2. landing column
    const colChoices = g.columnOptions(rot).map((p) => ({
      key: String(p.left),
      label: columnLabel(p.left),
      features: p.features,
      desc: `move ${p.left}: ${feat(p.features)}.`,
      ox: p.ox,
    }));
    if (colChoices.length === 0) {
      g.over = true;
      return;
    }
    this.setStatus(`Asking JEV which column to drop ${g.current} into...`);
    const pick = await this.runStage(
      "column",
      "move",
      "Choose the landing column for the current piece. After this it falls " +
        "naturally under gravity (no hard drop). Prefer clearing lines, then a " +
        "low flat stack with the fewest holes.",
      colChoices
    );
    g.applyDecision(rot, pick.ox);
    this.decided = true;
    this.updateStats();
    this.render();
    this.setStatus(`JEV chose ${orientLabel(rot)} + ${pick.label}`);
    await sleep(180);
  }

  showError(msg) {
    const n = $("note");
    n.textContent = msg;
    n.className = "note error";
    n.style.display = "block";
    this.setStatus(`Stopped: ${msg}`);
  }

  clearError() {
    const n = $("note");
    n.className = "note";
    n.style.display = "none";
  }

  async runLoop() {
    if (this.looping) return;
    this.looping = true;
    const g = this.game;
    while (this.running && !g.over) {
      if (!this.decided) {
        try {
          await this.decidePiece();
        } catch (err) {
          this.showError(`model call failed - ${err.message}`);
          this.running = false;
          break;
        }
        if (g.over || !this.running) break;
      }
      const { ms } = this.dropIntervalMs();
      await sleep(ms);
      if (!this.running) break;
      const result = g.gravityStep();
      this.render();
      this.updateSpeedReadout();
      if (result === "locked") {
        this.decided = false;
        this.updateStats();
        if (g.lastCleared) {
          this.setStatus(`Cleared ${g.lastCleared} line${g.lastCleared > 1 ? "s" : ""}!`);
        }
        if (g.over) break;
        await sleep(120);
      }
    }
    this.looping = false;
    if (g.over) {
      this.running = false;
      this.setStatus("Game over.");
      this.render();
    }
    if (!this.running) $("start").textContent = "Start";
  }

  start() {
    if (this.running || this.game.over) return;
    if (!this.config().endpoint) {
      this.showError("Enter a decision-model endpoint URL to run the demo.");
      return;
    }
    this.clearError();
    this.running = true;
    $("start").textContent = "Pause";
    this.setStatus("Running...");
    this.runLoop();
  }

  stop() {
    this.running = false;
    $("start").textContent = "Start";
    this.setStatus("Paused.");
  }

  toggle() {
    this.running ? this.stop() : this.start();
  }

  reset() {
    this.running = false;
    $("start").textContent = "Start";
    // let any in-flight loop observe running=false before rebuilding state
    setTimeout(() => {
      this.game.reset();
      this.decided = false;
      this.decisions = 0;
      this.latencies = [];
      this.updateStats();
      this.updateSpeedReadout();
      this.render();
      $("prob-list").innerHTML = "";
      $("chosen-move").textContent = "-";
      $("decision-desc").textContent = "";
      this.setStatus("Ready.");
    }, 60);
  }
}

// --- wire up ----------------------------------------------------------------

function restoreConfig() {
  const saved = JSON.parse(localStorage.getItem("jev-cfg") || "{}");
  if (saved.endpoint) $("endpoint").value = saved.endpoint;
  if (saved.model) $("model").value = saved.model;
}
function persistConfig() {
  localStorage.setItem(
    "jev-cfg",
    JSON.stringify({ endpoint: $("endpoint").value.trim(), model: $("model").value.trim() })
  );
}

window.addEventListener("DOMContentLoaded", () => {
  restoreConfig();
  const ctrl = new Controller();
  $("start").addEventListener("click", () => ctrl.toggle());
  $("reset").addEventListener("click", () => ctrl.reset());
  $("speed").addEventListener("input", () => ctrl.updateSpeedReadout());
  for (const id of ["endpoint", "model"]) $(id).addEventListener("change", persistConfig);
  $("toggle-raw").addEventListener("click", () => {
    const el = $("raw-wrap");
    el.style.display = el.style.display === "none" ? "block" : "none";
  });
});
