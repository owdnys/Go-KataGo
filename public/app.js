/* ============================================================
   围棋 · KataGo 前端
   - 棋盘/规则/交互在本文件实现
   - 所有 AI 着法、形势判断均来自本机 KataGo 引擎（HTTP 桥接）
   ============================================================ */
'use strict';

/* ----------------------------- 常量 ----------------------------- */
const EMPTY = 0, BLACK = 1, WHITE = 2;
const GTP_LETTERS = 'ABCDEFGHJKLMNOPQRST';   // GTP 标准跳过 I
const COLORS = ['#7ee0ff', '#ffd166', '#b28dff', '#74e8a8', '#ff9fb1'];

const LEVELS = {
  1: { name: '快速', seconds: 1.0 },
  2: { name: '标准', seconds: 2.5 },
  3: { name: '强', seconds: 5.0 },
  4: { name: '最强', seconds: 12.0 },
};

const HANDICAP_POINTS = {
  9: [[2, 6], [6, 2], [6, 6], [2, 2], [4, 4]],
  13: [[3, 9], [9, 3], [9, 9], [3, 3], [6, 6]],
  19: [[3, 15], [15, 3], [15, 15], [3, 3], [9, 9], [3, 9], [15, 9], [9, 3], [9, 15]],
};

/* ----------------------------- 工具 ----------------------------- */
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function idxToGtp(idx, size) {
  if (idx < 0) return 'pass';
  const x = idx % size, y = Math.floor(idx / size);
  return GTP_LETTERS[x] + (size - y);
}

function gtpToIdx(str, size) {
  if (!str) return -1;
  const s = String(str).trim().toUpperCase();
  if (s === 'PASS' || s === 'RESIGN' || s === '') return -1;
  const x = GTP_LETTERS.indexOf(s[0]);
  const row = parseInt(s.slice(1), 10);
  if (x < 0 || !Number.isFinite(row)) return -1;
  const y = size - row;
  if (y < 0 || y >= size || x >= size) return -1;
  return y * size + x;
}

function boardKey(board) {
  let s = '';
  for (let i = 0; i < board.length; i++) s += String.fromCharCode(board[i]);
  return s;
}

function fmtNum(v, digits = 1) {
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

/* -------------------------- 棋盘规则引擎 -------------------------- */
class Position {
  constructor(size) {
    this.size = size;
    this.board = new Int8Array(size * size);
  }
  clone() {
    const p = new Position(this.size);
    p.board.set(this.board);
    return p;
  }
  neighbors(idx) {
    const size = this.size;
    const x = idx % size, y = (idx / size) | 0;
    const out = [];
    if (x > 0) out.push(idx - 1);
    if (x < size - 1) out.push(idx + 1);
    if (y > 0) out.push(idx - size);
    if (y < size - 1) out.push(idx + size);
    return out;
  }
  /** 返回该点所在棋串的棋子与气 */
  groupAt(idx) {
    const color = this.board[idx];
    const stones = [];
    const seen = new Set([idx]);
    const stack = [idx];
    const libs = new Set();
    while (stack.length) {
      const cur = stack.pop();
      stones.push(cur);
      for (const n of this.neighbors(cur)) {
        const v = this.board[n];
        if (v === EMPTY) libs.add(n);
        else if (v === color && !seen.has(n)) { seen.add(n); stack.push(n); }
      }
    }
    return { color, stones, liberties: libs.size };
  }
}

/** 尝试落子，返回 { pos, captured, key } 或 { error } */
function tryPlay(pos, color, idx, historyKeys) {
  if (idx < 0 || idx >= pos.board.length) return { error: '着法超出棋盘' };
  if (pos.board[idx] !== EMPTY) return { error: '该点已有棋子' };
  const next = pos.clone();
  next.board[idx] = color;
  const opp = color === BLACK ? WHITE : BLACK;
  const captured = [];
  for (const n of next.neighbors(idx)) {
    if (next.board[n] === opp) {
      const g = next.groupAt(n);
      if (g.liberties === 0) {
        for (const s of g.stones) { next.board[s] = EMPTY; captured.push(s); }
      }
    }
  }
  const own = next.groupAt(idx);
  if (own.liberties === 0 && captured.length === 0) return { error: '禁着点（自杀）' };
  const key = boardKey(next.board);
  if (historyKeys && historyKeys.has(key)) return { error: '打劫：不可立即回提' };
  return { pos: next, captured, key };
}

/** 不做合法性检查的落子（引擎着法容错用） */
function forcePlay(pos, color, idx) {
  if (idx < 0) return { pos: pos.clone(), captured: [], key: boardKey(pos.board) };
  const next = pos.clone();
  next.board[idx] = color;
  const opp = color === BLACK ? WHITE : BLACK;
  const captured = [];
  for (const n of next.neighbors(idx)) {
    if (next.board[n] === opp) {
      const g = next.groupAt(n);
      if (g.liberties === 0) {
        for (const s of g.stones) { next.board[s] = EMPTY; captured.push(s); }
      }
    }
  }
  // 自杀保护：若自身无气，移除自身棋串
  const own = next.groupAt(idx);
  if (own.liberties === 0 && captured.length === 0) {
    for (const s of own.stones) next.board[s] = EMPTY;
  }
  return { pos: next, captured, key: boardKey(next.board) };
}

/* ----------------------------- 状态 ----------------------------- */
const settings = loadSettings();

const state = {
  boardSize: settings.boardSize || 19,
  komi: settings.komi ?? 7.5,
  rules: settings.rules || 'chinese',
  handicap: settings.handicap || 0,
  humanColor: settings.humanColor === WHITE ? WHITE : BLACK,
  level: settings.level || 3,
  suggest: settings.suggest !== false,
  heat: !!settings.heat,
  coords: settings.coords !== false,
  sound: settings.sound !== false,
  blobs: settings.blobs !== false,
  blur: settings.blur !== false,
  theme: settings.theme || 'midnight',
  tab: settings.tab || 'analysis',
  engineBase: settings.engineBase || '',      // 引擎地址（空=同源）
  engineToken: settings.token || '',
  offline: false,                             // 未连接引擎时为 true（仍可当棋盘用）

  pos: new Position(settings.boardSize || 19),
  historyKeys: new Set(),
  moves: [],
  handicapStones: [],
  turn: BLACK,
  lastMoveIdx: -1,
  over: false,
  thinking: false,
  syncing: false,
  engineReady: false,

  analyzeTag: null,
  analysis: null,          // { winrate, scoreLead, visits, candidates, ownership, turnOf }
  hoverIdx: -1,
  layout: null,
};

state.historyKeys.add(boardKey(state.pos.board));

function loadSettings() {
  try { return JSON.parse(localStorage.getItem('go-katago-settings') || '{}'); } catch { return {}; }
}
function saveSettings() {
  const s = {
    boardSize: state.boardSize, komi: state.komi, rules: state.rules,
    handicap: state.handicap, humanColor: state.humanColor, level: state.level,
    suggest: state.suggest, heat: state.heat, coords: state.coords,
    sound: state.sound, blobs: state.blobs, blur: state.blur, theme: state.theme,
    tab: state.tab, engineBase: state.engineBase, token: state.engineToken,
  };
  try { localStorage.setItem('go-katago-settings', JSON.stringify(s)); } catch { /* 忽略 */ }
}

const aiColor = () => (state.humanColor === BLACK ? WHITE : BLACK);
const colorName = (c) => (c === BLACK ? 'B' : 'W');

/* ----------------------------- 网络 ----------------------------- */
// 引擎既可以和网页同源（本机直接打开），也可以是远端地址
// （部署到 Cloudflare Pages 后，页面在公网、引擎仍在你自己电脑上）
function enginePath(p) {
  const base = (state.engineBase || '').replace(/\/+$/, '');
  return base + p;
}

function authHeaders(extra) {
  const h = extra || {};
  if (state.engineToken) h['X-Go-Token'] = state.engineToken;
  return h;
}

async function api(path, body) {
  const res = await fetch(enginePath(path), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body || {}),
  });
  let data = {};
  try { data = await res.json(); } catch { /* 忽略 */ }
  if (!res.ok || data.ok === false) throw new Error(data.error || ('请求失败 HTTP ' + res.status));
  return data;
}

async function apiGet(path) {
  const res = await fetch(enginePath(path), { headers: authHeaders() });
  return res.json();
}

/** 探测某个引擎地址是否可用，可用则返回其 /api/status */
async function probeEngine(base, token) {
  const url = (base || '').replace(/\/+$/, '') + '/api/status';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const headers = token ? { 'X-Go-Token': token } : {};
    const res = await fetch(url, { headers, signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    return (data && typeof data.state === 'string') ? data : null;
  } catch {
    return null;
  }
}

/* ----------------------------- 音效 ----------------------------- */
let audioCtx = null;
function stoneSound(strong) {
  if (!state.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    const len = 0.07;
    const buf = audioCtx.createBuffer(1, Math.floor(audioCtx.sampleRate * len), audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 7);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const bp = audioCtx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = strong ? 1900 : 2600;
    bp.Q.value = 1.2;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.26, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + len);
    src.connect(bp); bp.connect(g); g.connect(audioCtx.destination);
    src.start(t);
  } catch { /* 忽略 */ }
}

/* ----------------------------- 画板 ----------------------------- */
const canvas = $('board');
const ctx = canvas.getContext('2d');

function computeLayout(width) {
  const size = state.boardSize;
  const pad = Math.max(16, width * 0.048);
  const usable = width - pad * 2;
  const cell = usable / (size - 1);
  return { width, size, pad, cell, stoneR: cell * 0.47 };
}

function resizeCanvas() {
  const wrap = $('boardWrap');
  const rect = wrap.getBoundingClientRect();
  const w = Math.max(200, Math.min(rect.width, rect.height || rect.width));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(w * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = w + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  state.layout = computeLayout(w);
  render();
}

function pointXY(idx) {
  const { pad, cell, size } = state.layout;
  const x = idx % size, y = (idx / size) | 0;
  return [pad + x * cell, pad + y * cell];
}

function idxFromClient(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const { pad, cell, size } = state.layout;
  const x = (clientX - rect.left - pad) / cell;
  const y = (clientY - rect.top - pad) / cell;
  const ix = Math.round(x), iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= size || iy >= size) return -1;
  // 距离交叉点太远则不响应
  if (Math.hypot(x - ix, y - iy) > 0.55) return -1;
  return iy * size + ix;
}

function render() {
  if (!state.layout) return;
  const { width, size, pad, cell, stoneR } = state.layout;
  ctx.clearRect(0, 0, width, width);

  // ---- 棋盘玻璃底 ----
  const grd = ctx.createLinearGradient(0, 0, width, width);
  grd.addColorStop(0, 'rgba(255,255,255,0.10)');
  grd.addColorStop(1, 'rgba(255,255,255,0.035)');
  roundRect(ctx, 0.5, 0.5, width - 1, width - 1, 14);
  ctx.fillStyle = grd;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.20)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // ---- 形势热图 ----
  if (state.heat && state.analysis && state.analysis.ownership && state.analysis.tag === state.analyzeTag) {
    const own = state.analysis.ownership;
    const r = cell * 0.5;
    for (let i = 0; i < Math.min(own.length, size * size); i++) {
      const v = own[i];
      if (!Number.isFinite(v) || Math.abs(v) < 0.12) continue;
      const [px, py] = pointXY(i);
      const a = Math.min(0.55, Math.abs(v) * 0.55);
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = v > 0 ? `rgba(20,22,32,${a})` : `rgba(255,255,255,${a})`;
      ctx.fill();
    }
  }

  // ---- 网格 ----
  const line = Math.max(1, cell * 0.028);
  ctx.strokeStyle = 'rgba(255,255,255,0.42)';
  ctx.lineWidth = line;
  const start = pad, end = pad + cell * (size - 1);
  for (let i = 0; i < size; i++) {
    const p = pad + i * cell;
    ctx.beginPath(); ctx.moveTo(start, p); ctx.lineTo(end, p); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p, start); ctx.lineTo(p, end); ctx.stroke();
  }
  // 外框稍粗
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = line * 1.6;
  ctx.strokeRect(start, start, end - start, end - start);

  // ---- 星位 ----
  const stars = starPoints(size);
  ctx.fillStyle = 'rgba(255,255,255,0.62)';
  for (const [sx, sy] of stars) {
    ctx.beginPath();
    ctx.arc(pad + sx * cell, pad + sy * cell, Math.max(2, cell * 0.09), 0, Math.PI * 2);
    ctx.fill();
  }

  // ---- 坐标 ----
  if (state.coords) {
    ctx.fillStyle = 'rgba(242,245,255,0.45)';
    ctx.font = `${Math.max(9, Math.min(13, cell * 0.42))}px "Cascadia Mono", Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < size; i++) {
      const p = pad + i * cell;
      ctx.fillText(GTP_LETTERS[i], p, pad * 0.5);
      ctx.fillText(GTP_LETTERS[i], p, end + pad * 0.5);
      ctx.fillText(String(size - i), start - pad * 0.5, p);
      ctx.fillText(String(size - i), end + pad * 0.5, p);
    }
  }

  // ---- 推荐点 ----
  if (state.suggest && state.analysis && state.analysis.tag === state.analyzeTag
      && state.analysis.candidates && !state.over) {
    const cands = state.analysis.candidates.filter((c) => c.move && !/pass/i.test(c.move)).slice(0, 5);
    cands.forEach((c, k) => {
      const idx = gtpToIdx(c.move, size);
      if (idx < 0) return;
      const [px, py] = pointXY(idx);
      const rr = cell * 0.30;
      ctx.beginPath();
      ctx.arc(px, py, rr, 0, Math.PI * 2);
      ctx.fillStyle = k === 0 ? 'rgba(126,224,255,0.85)' : 'rgba(255,255,255,0.28)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = k === 0 ? '#04121b' : 'rgba(10,14,28,0.85)';
      ctx.font = `bold ${Math.max(9, cell * 0.36)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('ABCDE'[k], px, py + 0.5);
    });
  }

  // ---- 棋子 ----
  const b = state.pos.board;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === EMPTY) continue;
    const [px, py] = pointXY(i);
    drawStone(px, py, stoneR, b[i] === BLACK);
  }

  // ---- 最后一手标记 ----
  if (state.lastMoveIdx >= 0 && b[state.lastMoveIdx] !== EMPTY) {
    const [px, py] = pointXY(state.lastMoveIdx);
    ctx.beginPath();
    ctx.arc(px, py, stoneR * 0.3, 0, Math.PI * 2);
    ctx.fillStyle = b[state.lastMoveIdx] === BLACK ? 'rgba(255,255,255,0.92)' : 'rgba(20,24,36,0.9)';
    ctx.fill();
  }

  // ---- 悬停预览 ----
  const canPlay = !state.over && !state.thinking && !state.syncing && state.turn === state.humanColor;
  if (canPlay && state.hoverIdx >= 0 && b[state.hoverIdx] === EMPTY) {
    const [px, py] = pointXY(state.hoverIdx);
    ctx.globalAlpha = 0.38;
    drawStone(px, py, stoneR, state.turn === BLACK);
    ctx.globalAlpha = 1;
  }
}

function drawStone(x, y, r, isBlack) {
  // 几何半径本来相同，但深色盘面上白子会"发胀"、黑子会"收缩"（辐射错觉）。
  // 这里给黑子略放大、白子略缩小做视觉补偿，让两者看起来一样大。
  const R = isBlack ? r * 1.055 : r * 0.955;

  // 投影
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y + R * 0.13, R * 0.97, 0, Math.PI * 2);
  ctx.fillStyle = isBlack ? 'rgba(0,0,0,0.34)' : 'rgba(0,0,0,0.26)';
  ctx.filter = 'blur(2px)';
  ctx.fill();
  ctx.restore();

  const g = ctx.createRadialGradient(x - R * 0.34, y - R * 0.38, R * 0.12, x, y, R * 1.05);
  if (isBlack) {
    g.addColorStop(0, 'rgba(158,168,188,0.96)');
    g.addColorStop(0.34, 'rgba(56,62,80,0.99)');
    g.addColorStop(0.86, 'rgba(14,17,28,1)');
    g.addColorStop(1, 'rgba(28,34,52,1)');   // 外圈比盘面略亮，轮廓不糊在背景里
  } else {
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.58, 'rgba(233,237,245,1)');
    g.addColorStop(1, 'rgba(170,179,196,1)');
  }
  ctx.beginPath();
  ctx.arc(x, y, R, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();

  ctx.strokeStyle = isBlack ? 'rgba(255,255,255,0.24)' : 'rgba(255,255,255,0.5)';
  ctx.lineWidth = Math.max(0.7, R * 0.05);
  ctx.stroke();

  // 高光
  ctx.beginPath();
  ctx.ellipse(x - R * 0.33, y - R * 0.37, R * 0.25, R * 0.17, -0.6, 0, Math.PI * 2);
  ctx.fillStyle = isBlack ? 'rgba(255,255,255,0.40)' : 'rgba(255,255,255,0.85)';
  ctx.fill();
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r);
  c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r);
  c.quadraticCurveTo(x, y, x + r, y);
  c.closePath();
}

function starPoints(size) {
  if (size === 19) {
    const p = [3, 9, 15];
    const out = [];
    for (const a of p) for (const b of p) out.push([a, b]);
    return out;
  }
  if (size === 13) return [[3, 3], [9, 3], [3, 9], [9, 9], [6, 6]];
  if (size === 9) return [[2, 2], [6, 2], [2, 6], [6, 6], [4, 4]];
  const c = (size - 1) / 2;
  return Number.isInteger(c) ? [[c, c]] : [];
}

/* ----------------------------- 提示 ----------------------------- */
function toast(msg, kind) {
  const host = $('toastHost');
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s ease, transform .3s ease';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 320);
  }, 2400);
}

function showFloating(text) {
  $('floatingText').textContent = text;
  $('boardFloating').classList.add('show');
}
function hideFloating() {
  $('boardFloating').classList.remove('show');
}

/* --------------------------- 对局流程 --------------------------- */
function rebuildPosition() {
  state.pos = new Position(state.boardSize);
  state.turn = BLACK;
  state.lastMoveIdx = -1;
  // 让子先摆回棋盘（否则悔棋后让子会丢）
  for (const st of state.handicapStones) {
    const idx = gtpToIdx(st, state.boardSize);
    if (idx >= 0) state.pos.board[idx] = BLACK;
  }
  state.historyKeys = new Set([boardKey(state.pos.board)]);
  for (const m of state.moves) {
    if (m.idx >= 0) {
      const res = forcePlay(state.pos, m.color, m.idx);
      state.pos = res.pos;
      state.historyKeys.add(res.key);
      state.lastMoveIdx = m.idx;
    } else {
      state.lastMoveIdx = -1;
    }
    state.turn = m.color === BLACK ? WHITE : BLACK;
  }
  // 让子棋：黑方已摆 N 子，由白方先走
  if (state.handicapStones.length && state.moves.length === 0) state.turn = WHITE;
  invalidateAnalysis();
}

async function syncEngine() {
  if (state.offline) return;
  state.syncing = true;
  render();
  try {
    await api('/api/sync', {
      boardSize: state.boardSize,
      komi: state.komi,
      rules: state.rules,
      moves: state.moves.map((m) => ({ color: colorName(m.color), move: m.gtp })),
      handicapStones: state.handicapStones,
    });
  } catch (e) {
    toast('与引擎同步失败：' + e.message, 'warn');
  } finally {
    state.syncing = false;
    render();
  }
}

function pushMove(color, idx, captured) {
  const gtp = idx < 0 ? 'pass' : idxToGtp(idx, state.boardSize);
  state.moves.push({ color, idx, gtp, captured: captured || [] });
}

/** 局面一变，之前那份分析就作废（否则旧胜率会被按新回合方向错误解读） */
function invalidateAnalysis() {
  state.analyzeTag = null;
  state.analysis = null;
}

function recordMove(color, idx, captured) {
  pushMove(color, idx, captured);
  state.lastMoveIdx = idx;
  state.turn = color === BLACK ? WHITE : BLACK;
  invalidateAnalysis();
}

/** 玩家落子 */
async function humanPlay(idx) {
  if (state.over) { toast('对局已结束，请开新局', 'warn'); return; }
  if (state.thinking || state.syncing) return;
  // 离线模式（公网页面未连引擎）当双人棋盘用，谁都能落子
  if (!state.offline && state.turn !== state.humanColor) return;

  const res = tryPlay(state.pos, state.turn, idx, state.historyKeys);
  if (res.error) { toast(res.error, 'warn'); return; }

  state.pos = res.pos;
  state.historyKeys.add(res.key);
  recordMove(state.turn, idx, res.captured);
  stoneSound(true);
  render();
  updatePanels();

  const mv = state.moves[state.moves.length - 1];
  if (!state.offline) {
    try {
      await api('/api/play', { color: colorName(mv.color), move: mv.gtp });
    } catch (e) {
      toast('引擎未接受这一手：' + e.message, 'warn');
    }
  }

  if (checkGameEnd()) return;
  await turnLoop();
}

/** 停一手 */
async function humanPass() {
  if (state.over) return;
  if (state.thinking || state.syncing) return;
  if (!state.offline && state.turn !== state.humanColor) { toast('还没轮到你', 'warn'); return; }
  recordMove(state.turn, -1, []);
  render(); updatePanels();
  if (!state.offline) {
    try { await api('/api/play', { color: colorName(state.moves[state.moves.length - 1].color), move: 'pass' }); } catch { /* 忽略 */ }
  }
  if (checkGameEnd()) return;
  await turnLoop();
}

/** 引擎走子 */
async function engineTurn() {
  if (state.over || state.offline) return;
  state.thinking = true;
  showFloating('KataGo 思考中…');
  render();

  const tag = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  state.analyzeTag = tag;
  const lv = LEVELS[state.level] || LEVELS[3];

  let move = 'pass';
  try {
    const r = await api('/api/genmove', { color: colorName(state.turn), seconds: lv.seconds, tag });
    move = r.move;
  } catch (e) {
    toast('引擎出错：' + e.message, 'warn');
    state.thinking = false;
    hideFloating();
    render();
    return;
  }

  state.thinking = false;
  hideFloating();

  if (/resign/i.test(move)) {
    finishGame(state.humanColor === BLACK ? 'B+R' : 'W+R', 'KataGo 认输');
    return;
  }
  if (/pass/i.test(move)) {
    recordMove(state.turn, -1, []);
    stoneSound(false);
    render(); updatePanels();
    if (checkGameEnd()) return;
    await turnLoop();
    return;
  }

  let idx = gtpToIdx(move, state.boardSize);
  let res = tryPlay(state.pos, state.turn, idx, state.historyKeys);
  if (res.error) {
    res = forcePlay(state.pos, state.turn, idx);
    if (!res) { toast('引擎给出无效着法：' + move, 'warn'); return; }
  }
  state.pos = res.pos;
  state.historyKeys.add(res.key);
  recordMove(state.turn, idx, res.captured);
  stoneSound(true);
  render(); updatePanels();

  if (checkGameEnd()) return;
  await turnLoop();
}

/** 轮流推进：轮到引擎就让它走，轮到人就启动分析 */
async function turnLoop() {
  if (state.over) return;
  updatePanels();
  if (state.offline) return;                 // 离线：只当棋盘用，不驱动引擎
  if (state.turn === aiColor()) {
    await engineTurn();
  } else {
    requestAnalysis();
  }
}

function checkGameEnd() {
  const n = state.moves.length;
  if (n >= 2 && state.moves[n - 1].idx < 0 && state.moves[n - 2].idx < 0) {
    endByScoring();
    return true;
  }
  return false;
}

async function endByScoring() {
  state.over = true;
  state.thinking = false;
  hideFloating();
  showFloating('正在数子…');
  let score = '';
  try {
    const r = await api('/api/score');
    score = r.score;
  } catch (e) {
    score = '';
  }
  hideFloating();
  render(); updatePanels();
  finishGame(score, '双方停一手，终局数子');
}

function finishGame(scoreStr, subText) {
  state.over = true;
  state.thinking = false;
  hideFloating();
  render(); updatePanels();

  const title = formatResult(scoreStr);
  $('resultTitle').textContent = title;
  $('resultSub').textContent = subText || '';
  $('resultOverlay').classList.add('show');
  toast(title, 'good');
}

function formatResult(s) {
  if (!s) return '对局结束';
  const m = /^([BW])\+(.+)$/i.exec(String(s).trim());
  if (!m) return '对局结束 · ' + s;
  const who = m[1].toUpperCase() === 'B' ? '黑棋' : '白棋';
  const val = m[2].trim();
  if (/^R$/i.test(val)) return who + '中盘胜';
  const num = parseFloat(val);
  const diff = Number.isFinite(num) ? `${num} 目` : val;
  const win = (m[1].toUpperCase() === 'B' ? BLACK : WHITE) === state.humanColor;
  return `${who}胜 ${diff}（${win ? '你赢了' : '你输了'}）`;
}

/* --------------------------- 分析请求 --------------------------- */
let analyzing = false;
async function requestAnalysis(opts = {}) {
  if (state.offline) { $('analyzeHint').textContent = '未连接引擎'; return; }
  if (state.over || state.thinking) return;
  if (analyzing && !opts.force) return;
  analyzing = true;
  const tag = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  state.analyzeTag = tag;
  $('analyzeHint').textContent = '分析中…';
  try {
    await api('/api/analyze', {
      color: colorName(state.turn),
      seconds: opts.seconds || 1.6,
      ownership: state.heat,
      tag,
    });
  } catch (e) {
    $('analyzeHint').textContent = '分析失败';
  } finally {
    analyzing = false;
  }
  if (state.analyzeTag !== tag) return;
  $('analyzeHint').textContent = '已更新';
}

/** SSE 推送的实时分析数据 */
function onEngineInfo(data) {
  if (!state.analyzeTag || data.tag !== state.analyzeTag) return;
  if (!data.candidates || !data.candidates.length) {
    state.analysis = {
      ...(state.analysis || {}),
      tag: data.tag,
      ownership: data.ownership || (state.analysis && state.analysis.ownership) || null,
      visits: data.visits || 0,
    };
    updatePanels();
    return;
  }
  const rank = rankCandidates(data.candidates);
  state.analysis = {
    tag: data.tag,
    winrate: rank.winrate,          // 当前行棋方胜率
    scoreLead: rank.scoreLead,      // 当前行棋方目差
    visits: data.visits,
    candidates: rank.list,
    ownership: data.ownership || null,
  };
  updatePanels();
  render();
}

function rankCandidates(list) {
  const sorted = list
    .filter((c) => c.move)
    .slice()
    .sort((a, b) => (b.visits || 0) - (a.visits || 0));
  const top = sorted[0] || {};
  return { winrate: top.winrate, scoreLead: top.scoreLead, list: sorted };
}

/* --------------------------- 面板刷新 --------------------------- */
/* --------------------------- 功能区切换 --------------------------- */
function activeTabEl() {
  const bar = $('sideTabs');
  return bar.querySelector('.tab.active') || bar.querySelector('.tab');
}

function moveTabSlider(tab) {
  const slider = $('tabSlider');
  const bar = $('sideTabs');
  if (!slider || !bar) return;
  const el = tab || activeTabEl();
  if (!el) return;
  const first = !slider.classList.contains('ready');
  if (first) slider.style.transition = 'none';   // 首次定位不要从左边滑过来
  slider.style.width = el.offsetWidth + 'px';
  slider.style.transform = `translateX(${el.offsetLeft - bar.scrollLeft - 5}px)`;
  slider.classList.add('ready');
  if (first) requestAnimationFrame(() => { slider.style.transition = ''; });
}

/** 切换右侧功能区（形势 / 对局 / 设置 / 棋谱） */
function setTab(name) {
  const tabs = [...$('sideTabs').querySelectorAll('.tab')];
  const target = tabs.find((t) => t.dataset.tab === name) || tabs[0];
  if (!target) return;
  tabs.forEach((t) => t.classList.toggle('active', t === target));
  document.querySelectorAll('.pane').forEach((p) => {
    p.classList.toggle('active', p.dataset.pane === target.dataset.tab);
  });
  state.tab = target.dataset.tab;
  // 只滚动标签栏自身，绝不触碰页面或面板的滚动位置
  const bar = $('sideTabs');
  bar.scrollLeft = Math.max(0, target.offsetLeft - (bar.clientWidth - target.offsetWidth) / 2);
  moveTabSlider(target);
  saveSettings();
}

/* --------------------------- 面板刷新 --------------------------- */
// 用签名比对避免每 0.2 秒重建 DOM（否则列表会闪烁、滚动位置被打断）
let lastCandSig = '';
let lastMovesSig = '';
let lastWinrateText = '';

function updatePanels() {
  // 回合
  const humanTurn = state.turn === state.humanColor;
  $('turnIcon').className = 'stone-icon ' + (state.turn === BLACK ? 'black' : 'white');
  let turnLabel;
  if (state.over) turnLabel = '对局结束';
  else if (state.thinking) turnLabel = 'KataGo 思考中…';
  else if (humanTurn) turnLabel = (state.turn === BLACK ? '黑棋' : '白棋') + ' · 轮到你';
  else turnLabel = (state.turn === BLACK ? '黑棋' : '白棋') + ' · 引擎';
  $('turnText').textContent = turnLabel;
  $('moveCount').textContent = `第 ${state.moves.length} 手`;

  // 胜率（统一转成黑方视角）
  const a = state.analysis && state.analysis.tag === state.analyzeTag ? state.analysis : null;
  if (a && Number.isFinite(a.winrate)) {
    const moverIsBlack = state.turn === BLACK;
    const blackWr = moverIsBlack ? a.winrate : 1 - a.winrate;
    const wrText = (blackWr * 100).toFixed(1);
    if (wrText !== lastWinrateText) {
      lastWinrateText = wrText;
      $('blackWinrate').innerHTML = wrText + '<small>%</small>';
      $('barBlack').style.width = wrText + '%';
    }
    const lead = moverIsBlack ? a.scoreLead : -a.scoreLead;
    const leadEl = $('scoreLead');
    if (Number.isFinite(lead)) {
      leadEl.textContent = (lead >= 0 ? '黑领先 ' : '白领先 ') + Math.abs(lead).toFixed(1) + ' 目';
      leadEl.className = lead >= 0 ? 'lead-black' : 'lead-white';
    } else {
      leadEl.textContent = '—';
    }
    $('visitsText').textContent = a.visits ? a.visits.toLocaleString() : '0';
    $('engineStats').textContent = a.visits ? `${a.visits.toLocaleString()} visits 已搜索` : '—';
  } else {
    if (lastWinrateText !== '--') {
      lastWinrateText = '--';
      $('blackWinrate').innerHTML = '--<small>%</small>';
      $('barBlack').style.width = '50%';
    }
    $('scoreLead').textContent = '—';
  }

  // 候选点（签名不变就不重建，避免闪烁、也不再打断滚动）
  const list = $('candList');
  const shown = (a && a.candidates)
    ? a.candidates.filter((c) => !/pass/i.test(c.move || '')).slice(0, 5)
    : [];
  const candSig = shown.map((c) =>
    `${c.move}|${Number.isFinite(c.winrate) ? c.winrate.toFixed(4) : ''}|${Number.isFinite(c.scoreLead) ? c.scoreLead.toFixed(2) : ''}|${(c.pv || []).slice(1, 7).join(',')}`,
  ).join(';') + '|turn' + state.turn;

  if (candSig !== lastCandSig) {
    lastCandSig = candSig;
    if (shown.length) {
      const moverIsBlack = state.turn === BLACK;
      list.innerHTML = '';
      shown.forEach((c, k) => {
        const div = document.createElement('div');
        div.className = 'cand';
        const wr = Number.isFinite(c.winrate) ? (moverIsBlack ? c.winrate : 1 - c.winrate) : NaN;
        const lead = Number.isFinite(c.scoreLead) ? (moverIsBlack ? c.scoreLead : -c.scoreLead) : NaN;
        const pv = (c.pv || []).slice(1, 7).join(' ');
        div.innerHTML =
          `<span class="tag">${'ABCDE'[k]}</span>` +
          `<span class="coord">${c.move}</span>` +
          `<span class="wr">${Number.isFinite(wr) ? (wr * 100).toFixed(1) + '%' : ''}` +
          `${Number.isFinite(lead) ? ` · ${lead >= 0 ? '+' : ''}${lead.toFixed(1)}` : ''}</span>` +
          `${pv ? `<span class="pv">${pv}</span>` : ''}`;
        div.title = '点击可在棋盘上高亮此点';
        div.onclick = () => {
          state.hoverIdx = gtpToIdx(c.move, state.boardSize);
          render();
          toast('推荐点 ' + c.move);
        };
        list.appendChild(div);
      });
    } else {
      list.innerHTML = '<div class="cand empty">暂无分析数据</div>';
    }
  }

  // 棋谱（同样只在变化时重建；滚动只作用于棋谱列表自身）
  const ml = $('movesList');
  const lastMove = state.moves[state.moves.length - 1];
  const movesSig = state.moves.length + '|' + (lastMove ? lastMove.color + lastMove.gtp : '');
  if (movesSig !== lastMovesSig) {
    lastMovesSig = movesSig;
    ml.innerHTML = '';
    state.moves.forEach((m, i) => {
      const el = document.createElement('span');
      el.className = 'move-item' + (i === state.moves.length - 1 ? ' last' : '');
      el.innerHTML = `<span class="n">${i + 1}.</span>${m.color === BLACK ? '●' : '○'} ${m.gtp}`;
      ml.appendChild(el);
    });
    ml.scrollTop = ml.scrollHeight;
  }
  $('movesHint').textContent = state.moves.length + ' 手';

  // 按钮状态
  const busy = state.thinking || state.syncing;
  $('btnUndo').disabled = state.moves.length === 0 || busy;
  $('btnPass').disabled = state.over || busy || (!state.offline && state.turn !== state.humanColor);
  $('btnResign').disabled = state.offline || state.over || state.moves.length === 0;
  $('btnScore').disabled = state.offline || busy || state.moves.length === 0;
}

/* --------------------------- 引擎状态 --------------------------- */
function onEngineStatus(s) {
  state.engineReady = s.state === 'ready';
  const dot = $('engineDot');
  dot.className = 'dot ' + (s.state === 'ready' ? 'ready' : s.state === 'starting' ? 'starting' : 'error');

  let text = '未知状态';
  if (s.state === 'ready') text = 'KataGo 就绪 · ' + (s.model ? s.model.split(/[\\/]/).pop() : '');
  else if (s.state === 'starting') text = 'KataGo 启动中…';
  else if (s.state === 'error') text = '引擎不可用';
  $('engineText').textContent = text;

  const note = $('engineNote');
  if (s.state === 'error') {
    note.classList.remove('hidden');
    note.innerHTML =
      `<b>KataGo 未能启动</b><br>${s.error || ''}<br>` +
      `引擎：<code>${s.katago || '未找到'}</code><br>` +
      `模型：<code>${s.model || '未找到'}</code><br>` +
      `<button class="small" style="margin-top:8px" onclick="restartEngine()">重试启动引擎</button>`;
  } else {
    note.classList.add('hidden');
  }
  updatePanels();
}

window.restartEngine = async function () {
  toast('正在重启引擎…');
  try { await api('/api/restart'); } catch (e) { toast('重启失败：' + e.message, 'warn'); }
};

let sse = null;
function connectSSE() {
  if (sse) { try { sse.close(); } catch { /* 忽略 */ } sse = null; }
  const url = enginePath('/api/events') + (state.engineToken ? ('?token=' + encodeURIComponent(state.engineToken)) : '');
  const es = new EventSource(url);
  sse = es;
  es.addEventListener('status', (e) => {
    try { onEngineStatus(JSON.parse(e.data)); } catch { /* 忽略 */ }
  });
  es.addEventListener('info', (e) => {
    try { onEngineInfo(JSON.parse(e.data)); } catch { /* 忽略 */ }
  });
  es.onerror = () => {
    if (state.offline) return;
    $('engineDot').className = 'dot error';
    $('engineText').textContent = '引擎连接中断，正在重连…';
  };
}

/* --------------------------- 悔棋 / 新局 --------------------------- */
async function undo() {
  if (!state.moves.length || state.thinking || state.syncing) return;
  // 通常退两手：引擎一手 + 自己一手
  let count = 0;
  while (state.moves.length && count < 2) {
    const m = state.moves[state.moves.length - 1];
    state.moves.pop();
    count++;
    if (m.color === state.humanColor) break;
  }
  state.over = false;
  $('resultOverlay').classList.remove('show');
  rebuildPosition();
  render(); updatePanels();
  await syncEngine();
  updatePanels();
  // 悔棋后若轮到引擎（例如让子局），让它接着走
  await turnLoop();
  toast('已悔棋');
}

async function newGame(opts = {}) {
  const size = opts.boardSize ?? state.boardSize;
  const handicap = opts.handicap ?? state.handicap;

  state.boardSize = size;
  state.handicap = handicap;
  if (handicap > 0) {
    state.humanColor = BLACK;              // 让子棋：被让方执黑先行
    if (state.komi > 1) state.komi = 0.5;  // 让子棋不贴目（KataGo 会按规则给白方还子补偿）
  }
  // 同步"我执"与"贴目"选择器（让子会自动把执黑锁上、贴目归零）
  [...$('segColor').children].forEach((x) => x.classList.toggle('active', (x.dataset.color === 'W' ? WHITE : BLACK) === state.humanColor));
  $('valColor').textContent = state.humanColor === BLACK ? '黑棋' : '白棋';
  [...$('segKomi').children].forEach((x) => x.classList.toggle('active', Number(x.dataset.komi) === state.komi));
  $('valKomi').textContent = String(state.komi);
  state.moves = [];
  state.handicapStones = [];
  state.over = false;
  state.thinking = false;
  state.analysis = null;
  state.analyzeTag = null;
  $('resultOverlay').classList.remove('show');
  hideFloating();
  saveSettings();

  state.pos = new Position(size);
  state.historyKeys = new Set([boardKey(state.pos.board)]);
  state.turn = BLACK;
  state.lastMoveIdx = -1;

  resizeCanvas();

  if (state.offline) {
    // 离线（未连接引擎）：用本地星位表摆让子，纯棋盘对弈
    if (handicap > 0) {
      const pts = (HANDICAP_POINTS[size] || []).slice(0, handicap);
      state.handicapStones = pts.map(([x, y]) => idxToGtp(y * size + x, size));
      for (const st of state.handicapStones) {
        const idx = gtpToIdx(st, size);
        if (idx >= 0) state.pos.board[idx] = BLACK;
      }
      state.turn = WHITE;
    }
    render(); updatePanels();
    return;
  }

  try {
    const r = await api('/api/newgame', {
      boardSize: size, komi: state.komi, rules: state.rules, handicap,
    });
    state.handicapStones = r.handicapStones || [];
    if (state.handicapStones.length) {
      for (const st of state.handicapStones) {
        const idx = gtpToIdx(st, size);
        if (idx >= 0) state.pos.board[idx] = BLACK;
      }
      state.turn = WHITE;
      toast(`已摆 ${state.handicapStones.length} 个让子`);
    }
  } catch (e) {
    toast('新局失败：' + e.message, 'warn');
  }

  render(); updatePanels();
  await turnLoop();
}

/* --------------------------- 结算 / SGF --------------------------- */
async function deepAnalyze() {
  if (state.offline) { toast('未连接引擎，无法做形势判断', 'warn'); return; }
  if (state.thinking) return;
  toast('KataGo 深度分析中（约 10 秒）…');
  const wasHeat = state.heat;
  state.heat = true;
  setSwitch($('swHeat'), true);
  await requestAnalysis({ seconds: 10, force: true });
  render();
  if (!wasHeat) toast('已开启形势热图');
}

function exportSgf() {
  const size = state.boardSize;
  const letters = 'abcdefghijklmnopqrs';
  let s = `(;GM[1]FF[4]CA[UTF-8]AP[Go-KataGo-Web:1.0]SZ[${size}]KM[${state.komi}]RU[${state.rules}]`;
  if (state.handicapStones.length) {
    s += `HA[${state.handicapStones.length}]AB` + state.handicapStones
      .map((g) => { const i = gtpToIdx(g, size); return `[${letters[i % size]}${letters[(i / size) | 0]}]`; }).join('');
  }
  for (const m of state.moves) {
    s += `;${m.color === BLACK ? 'B' : 'W'}`;
    if (m.idx >= 0) s += `[${letters[m.idx % size]}${letters[(m.idx / size) | 0]}]`;
    else s += '[]';
  }
  s += ')';
  const blob = new Blob([s], { type: 'application/x-go-sgf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `kataGo-${size}x${size}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.sgf`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  toast('已导出 SGF');
}

/* --------------------------- UI 绑定 --------------------------- */
function setSwitch(el, on) { el.classList.toggle('on', !!on); }

function bindUI() {
  // 棋盘交互
  canvas.addEventListener('mousemove', (e) => {
    const idx = idxFromClient(e.clientX, e.clientY);
    if (idx !== state.hoverIdx) { state.hoverIdx = idx; render(); }
  });
  canvas.addEventListener('mouseleave', () => { state.hoverIdx = -1; render(); });
  canvas.addEventListener('click', (e) => {
    const idx = idxFromClient(e.clientX, e.clientY);
    if (idx >= 0) humanPlay(idx);
  });

  // 棋盘大小
  $('segSize').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const size = Number(b.dataset.size);
    if (size === state.boardSize) return;
    [...$('segSize').children].forEach((x) => x.classList.toggle('active', x === b));
    $('valSize').textContent = size + ' 路';
    newGame({ boardSize: size });
  });

  // 棋力
  $('segLevel').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.level = Number(b.dataset.level);
    [...$('segLevel').children].forEach((x) => x.classList.toggle('active', x === b));
    const lv = LEVELS[state.level];
    $('valLevel').textContent = `${lv.name} · ${lv.seconds} 秒`;
    saveSettings();
  });

  // 执子
  $('segColor').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (state.handicap > 0) { toast('让子棋由被让方执黑', 'warn'); return; }
    state.humanColor = b.dataset.color === 'W' ? WHITE : BLACK;
    [...$('segColor').children].forEach((x) => x.classList.toggle('active', x === b));
    $('valColor').textContent = state.humanColor === BLACK ? '黑棋' : '白棋';
    saveSettings();
    newGame({});
  });

  // 贴目
  $('segKomi').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.komi = Number(b.dataset.komi);
    [...$('segKomi').children].forEach((x) => x.classList.toggle('active', x === b));
    $('valKomi').textContent = String(state.komi);
    saveSettings();
    toast('贴目已设为 ' + state.komi + '，建议开新局');
  });

  // 让子
  $('segHandicap').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const h = Number(b.dataset.handicap);
    [...$('segHandicap').children].forEach((x) => x.classList.toggle('active', x === b));
    $('valHandicap').textContent = h === 0 ? '不让子' : h + ' 子';
    newGame({ handicap: h });
  });

  // 开关
  $('swSuggest').onclick = () => { state.suggest = !state.suggest; setSwitch($('swSuggest'), state.suggest); saveSettings(); render(); };
  $('swHeat').onclick = () => { state.heat = !state.heat; setSwitch($('swHeat'), state.heat); saveSettings(); render(); requestAnalysis({ force: true }); };
  $('swCoords').onclick = () => { state.coords = !state.coords; setSwitch($('swCoords'), state.coords); saveSettings(); render(); };
  $('swSound').onclick = () => { state.sound = !state.sound; setSwitch($('swSound'), state.sound); saveSettings(); if (state.sound) stoneSound(false); };
  $('swBlobs').onclick = () => {
    state.blobs = !state.blobs; setSwitch($('swBlobs'), state.blobs); saveSettings();
    document.body.dataset.blobs = state.blobs ? 'on' : 'off';
  };
  $('swBlur').onclick = () => {
    state.blur = !state.blur; setSwitch($('swBlur'), state.blur); saveSettings();
    document.body.dataset.blur = state.blur ? 'on' : 'off';
  };

  // 主题
  const themes = ['midnight', 'violet', 'pine', 'sunset'];
  $('btnTheme').onclick = () => {
    const i = themes.indexOf(state.theme);
    state.theme = themes[(i + 1) % themes.length];
    document.body.dataset.theme = state.theme;
    saveSettings();
    toast('主题：' + ({ midnight: '深夜蓝', violet: '暮光紫', pine: '松林绿', sunset: '暖霞橙' })[state.theme]);
  };

  // 按钮
  $('btnNew').onclick = () => newGame({});
  $('btnUndo').onclick = () => undo();
  $('btnPass').onclick = () => humanPass();
  $('btnResign').onclick = () => {
    if (state.over) return;
    finishGame(aiColor() === BLACK ? 'B+R' : 'W+R', '你认输了');
  };
  $('btnScore').onclick = () => deepAnalyze();
  $('btnSgf').onclick = () => exportSgf();
  $('btnResultNew').onclick = () => newGame({});
  $('btnResultClose').onclick = () => $('resultOverlay').classList.remove('show');

  // 引擎连接设置
  $('enginePill').onclick = () => openEngineModal(false);
  $('btnEngineConnect').onclick = () => connectEngine($('inpEngineBase').value, $('inpEngineToken').value);
  $('btnEngineLocal').onclick = () => { $('inpEngineBase').value = ''; connectEngine('', $('inpEngineToken').value); };
  $('btnEngineClose').onclick = () => closeEngineModal();
  $('engineModal').addEventListener('click', (e) => { if (e.target === $('engineModal')) closeEngineModal(); });
  $('inpEngineToken').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnEngineConnect').click(); });
  $('inpEngineBase').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnEngineConnect').click(); });

  // 功能区切换（横向玻璃条）
  $('sideTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (b) setTab(b.dataset.tab);
  });
  $('sideTabs').addEventListener('scroll', () => moveTabSlider(), { passive: true });

  // 快捷键
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (k === 'u') undo();
    else if (k === 'p') humanPass();
    else if (k === 'n') newGame({});
  });

  // 光斑跟随鼠标
  let raf = 0;
  window.addEventListener('pointermove', (e) => {
    if (!state.blobs) return;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const dx = (e.clientX / window.innerWidth - 0.5) * 30;
      const dy = (e.clientY / window.innerHeight - 0.5) * 30;
      document.body.style.setProperty('--mx', dx.toFixed(1));
      document.body.style.setProperty('--my', dy.toFixed(1));
    });
  });

  // 尺寸
  const ro = new ResizeObserver(() => resizeCanvas());
  ro.observe($('boardWrap'));
  window.addEventListener('resize', () => { resizeCanvas(); moveTabSlider(); });
}

/* ----------------------------- 初始化 ----------------------------- */
/* --------------------------- 引擎连接设置 --------------------------- */
function openEngineModal(firstTime) {
  $('inpEngineBase').value = state.engineBase || '';
  $('inpEngineToken').value = state.engineToken || '';
  $('engineModalHint').textContent = firstTime
    ? '如果你就是在这台电脑上打开本页面，本机引擎通常会自动连上，不需要填写。'
    : '';
  $('engineModal').classList.add('show');
  setTimeout(() => { try { $('inpEngineBase').focus(); } catch { /* 忽略 */ } }, 60);
}

function closeEngineModal() {
  $('engineModal').classList.remove('show');
}

async function connectEngine(base, token) {
  const hint = $('engineModalHint');
  const cleanBase = (base || '').trim();
  const cleanToken = (token || '').trim();
  hint.textContent = '正在连接…';
  const st = await probeEngine(cleanBase, cleanToken);
  if (!st) {
    hint.textContent = '连不上 ' + (cleanBase || '（当前站点同源地址）')
      + '。请确认：引擎已启动 · 地址端口正确 · 令牌无误 · 若走隧道需用 https 地址。';
    return false;
  }
  state.engineBase = cleanBase;
  state.engineToken = cleanToken;
  state.offline = false;
  saveSettings();
  onEngineStatus(st);
  $('enginePill').classList.remove('clickable');
  $('engineNote').classList.add('hidden');
  closeEngineModal();
  connectSSE();
  toast('已连接 KataGo 引擎', 'good');
  await newGame({});
  return true;
}

async function boot() {
  document.body.dataset.theme = state.theme;
  document.body.dataset.blobs = state.blobs ? 'on' : 'off';
  document.body.dataset.blur = state.blur ? 'on' : 'off';

  // 回填 UI
  [...$('segSize').children].forEach((x) => x.classList.toggle('active', Number(x.dataset.size) === state.boardSize));
  $('valSize').textContent = state.boardSize + ' 路';
  [...$('segLevel').children].forEach((x) => x.classList.toggle('active', Number(x.dataset.level) === state.level));
  $('valLevel').textContent = `${LEVELS[state.level].name} · ${LEVELS[state.level].seconds} 秒`;
  [...$('segColor').children].forEach((x) => x.classList.toggle('active', (x.dataset.color === 'W' ? WHITE : BLACK) === state.humanColor));
  $('valColor').textContent = state.humanColor === BLACK ? '黑棋' : '白棋';
  [...$('segKomi').children].forEach((x) => x.classList.toggle('active', Number(x.dataset.komi) === state.komi));
  $('valKomi').textContent = String(state.komi);
  [...$('segHandicap').children].forEach((x) => x.classList.toggle('active', Number(x.dataset.handicap) === state.handicap));
  $('valHandicap').textContent = state.handicap === 0 ? '不让子' : state.handicap + ' 子';
  setSwitch($('swSuggest'), state.suggest);
  setSwitch($('swHeat'), state.heat);
  setSwitch($('swCoords'), state.coords);
  setSwitch($('swSound'), state.sound);
  setSwitch($('swBlobs'), state.blobs);
  setSwitch($('swBlur'), state.blur);

  bindUI();
  resizeCanvas();
  setTab(state.tab || 'analysis');            // 恢复上次停留的功能区
  requestAnimationFrame(() => moveTabSlider());
  setTimeout(() => moveTabSlider(), 350);     // 字体/布局稳定后再校正一次滑块

  // ---- 找引擎：同源 → 本机常用端口（公网页面也能连回这台电脑）→ 上次保存的远端地址 ----
  // http://127.0.0.1 属于"安全上下文"，https 页面请求它不会被浏览器的混合内容策略拦掉
  const candidates = ['', 'http://127.0.0.1:3210', 'http://127.0.0.1:3211', 'http://localhost:3210'];
  if (state.engineBase) candidates.push(state.engineBase);

  const probes = await Promise.all(candidates.map(async (base) => ({
    base, status: await probeEngine(base, state.engineToken),
  })));
  const hit = probes.find((p) => p.status);

  if (!hit) { enterOfflineMode(); return; }

  state.engineBase = hit.base;
  state.offline = false;
  onEngineStatus(hit.status);
  connectSSE();
  await newGame({});
}

/** 没连上引擎：页面仍可当棋盘用（双人对弈），并引导用户填引擎地址 */
function enterOfflineMode() {
  state.offline = true;
  state.engineReady = false;
  $('engineDot').className = 'dot error';
  $('engineText').textContent = '未连接引擎 · 点此设置';
  $('enginePill').classList.add('clickable');
  $('analyzeHint').textContent = '未连接引擎';
  $('candList').innerHTML = '<div class="cand empty">未连接 KataGo 引擎</div>';
  $('engineNote').classList.remove('hidden');
  $('engineNote').innerHTML =
    '<b>未连接 KataGo 引擎</b><br>' +
    '这个页面本身只是棋盘，AI 由你电脑上的 <code>katago.exe</code> 提供。<br>' +
    '① 确认本机引擎在跑：双击桌面的「围棋（KataGo）」图标<br>' +
    '② <b>浏览器弹出「是否允许访问本地网络设备」时请点“允许”</b>，公网页面才能连上你电脑的引擎<br>' +
    '③ 也可以点顶部状态条，手动填写引擎地址';
  newGame({});
  openEngineModal(true);
}

boot();

/* 供调试/自动化测试使用的钩子（不影响正常使用） */
window.__go = {
  state, newGame, undo, humanPass, humanPlay, requestAnalysis, exportSgf,
  connectEngine, probeEngine, openEngineModal, enterOfflineMode,
  get snapshot() {
    return {
      boardSize: state.boardSize, turn: state.turn, humanColor: state.humanColor,
      moves: state.moves.map((m) => colorName(m.color) + ':' + m.gtp),
      handicapStones: state.handicapStones, over: state.over, thinking: state.thinking,
      analysis: state.analysis ? { visits: state.analysis.visits, winrate: state.analysis.winrate, scoreLead: state.analysis.scoreLead, cands: state.analysis.candidates.length } : null,
    };
  },
};
