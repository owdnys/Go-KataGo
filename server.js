/*
 * 围棋 · KataGo 桥接服务
 * ---------------------------------------------------------------
 * 浏览器不能直接启动本机进程，所以这里用 Node 起一个本地服务：
 *   网页  ──HTTP/SSE──▶  本服务  ──GTP(stdio)──▶  katago.exe
 * AI 的每一手都来自 KataGo 的真实神经网络搜索，不含任何手写算法。
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'engine.json');
const LOG_FILE = path.join(ROOT, 'logs', 'server.log');

// 引擎的工作目录放在用户数据目录下，**故意不放在工程目录里**：
// Windows 上只要某个进程把文件夹当作工作目录，整个文件夹就会被锁住（无法移动/改名）。
// 放到 %LOCALAPPDATA%\go-katago-web 后，服务运行中也能随意移动工程文件夹。
const DATA_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'go-katago-web');
const RUN_DIR = path.join(DATA_DIR, 'engine-run');

fs.mkdirSync(RUN_DIR, { recursive: true });
fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });

/* ============================ 日志 ============================ */
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* 忽略 */ }
}

/* ========================= 引擎配置 ========================= */
function firstExisting(list) {
  for (const p of list) {
    if (p && typeof p === 'string' && fs.existsSync(p)) return p;
  }
  return null;
}

function findModelUnder(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const stack = [dir];
  const found = [];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) stack.push(fp);
      else if (/\.(txt|bin)\.gz$|\.(txt|bin)$/i.test(e.name)) found.push(fp);
    }
  }
  // 优先 *.txt.gz，其次 bin.gz / bin
  found.sort((a, b) => {
    const rank = (p) => (/\.txt\.gz$/i.test(p) ? 0 : /\.bin\.gz$/i.test(p) ? 1 : 2);
    return rank(a) - rank(b);
  });
  return found[0] || null;
}

function resolveEngineConfig() {
  let user = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try { user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {
      log('engine.json 解析失败，使用默认探测：' + e.message);
    }
  }
  const home = process.env.USERPROFILE || 'C:\\Users\\' + (process.env.USERNAME || '');
  const searchDirs = [
    ...(Array.isArray(user['_探测候选目录']) ? user['_探测候选目录'] : []),
    path.join(home, '围棋AI'),
    path.join(home, 'Desktop', '围棋AI'),
    path.join(home, 'Documents', '围棋AI'),
  ];

  const katagoCandidates = [user.katago];
  for (const d of searchDirs) {
    katagoCandidates.push(path.join(d, 'katago', 'katago.exe'));
    katagoCandidates.push(path.join(d, 'katago.exe'));
  }
  const katago = firstExisting(katagoCandidates);

  let model = user.model && fs.existsSync(user.model) ? user.model : null;
  let config = user.config && fs.existsSync(user.config) ? user.config : null;
  if (katago) {
    const kdir = path.dirname(katago);
    if (!model) model = findModelUnder(path.join(kdir, 'models')) || findModelUnder(path.join(kdir, '..', 'models'));
    if (!config) config = firstExisting([path.join(kdir, 'default_gtp.cfg'), path.join(kdir, 'gtp.cfg')]);
  }

  return {
    katago,
    model,
    config,
    port: Number(user.port) || 3210,
    host: typeof user.host === 'string' && user.host ? user.host : '127.0.0.1',
    token: typeof user.token === 'string' ? user.token.trim() : '',
    numSearchThreads: Number(user.numSearchThreads) || 6,
    startupTimeoutMs: Number(user.startupTimeoutMs) || 120000,
  };
}

/* ========================== SSE 总线 ========================== */
const sseClients = new Set();

function sseSend(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

/* ======================= info 行解析器 ======================= */
const NUMERIC_KEYS = new Set([
  'visits', 'edgeVisits', 'utility', 'winrate', 'scoreMean', 'scoreStdev',
  'scoreLead', 'scoreSelfplay', 'prior', 'lcb', 'utilityLcb', 'weight', 'order',
]);
const STRING_KEYS = new Set(['isSymmetryOf']);

function parseInfoLine(line) {
  const tokens = line.trim().split(/\s+/);
  const result = { visits: 0, candidates: [], ownership: null };
  let cur = null;
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === 'move') {
      cur = { move: tokens[i + 1] };
      result.candidates.push(cur);
      i += 2;
      continue;
    }
    if (t === 'ownership') {
      result.ownership = tokens.slice(i + 1).map(Number);
      break;
    }
    if (t === 'pv' && cur) {
      const pv = [];
      i += 1;
      while (i < tokens.length && !NUMERIC_KEYS.has(tokens[i]) && tokens[i] !== 'move'
        && tokens[i] !== 'info' && tokens[i] !== 'ownership' && !STRING_KEYS.has(tokens[i])) {
        pv.push(tokens[i]);
        i += 1;
      }
      cur.pv = pv;
      continue;
    }
    if (NUMERIC_KEYS.has(t) && cur) {
      const v = Number(tokens[i + 1]);
      if (Number.isFinite(v)) cur[t] = v;
      i += 2;
      continue;
    }
    if (STRING_KEYS.has(t) && cur) {
      cur[t] = tokens[i + 1];
      i += 2;
      continue;
    }
    i += 1;
  }
  if (result.candidates.length) {
    result.visits = result.candidates.reduce((m, c) => Math.max(m, c.visits || 0), 0);
    result.candidates.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  }
  return result;
}

/* ========================== 引擎封装 ========================== */
class KataGoEngine {
  constructor(cfg) {
    this.cfg = cfg;
    this.proc = null;
    this.state = 'idle';       // idle | starting | ready | error
    this.error = null;
    this.info = null;
    this.buf = '';
    this.queue = [];
    this.cur = null;
    this.restarts = 0;
    this.session = 0;
    this.stderrTail = [];
  }

  status() {
    return {
      state: this.state,
      error: this.error,
      katago: this.cfg.katago,
      model: this.cfg.model,
      config: this.cfg.config,
      numSearchThreads: this.cfg.numSearchThreads,
      queued: this.queue.length,
      pending: this.cur ? this.cur.command : null,
      info: this.info,
      stderr: this.stderrTail.slice(-6),
    };
  }

  pushStatus() { sseSend('status', this.status()); }

  async start() {
    if (this.proc) return;
    if (!this.cfg.katago) {
      this.state = 'error';
      this.error = '未找到 katago.exe，请在 engine.json 里填写路径';
      this.pushStatus();
      return;
    }
    if (!this.cfg.model) {
      this.state = 'error';
      this.error = '未找到 KataGo 神经网络模型（*.txt.gz）';
      this.pushStatus();
      return;
    }

    this.state = 'starting';
    this.error = null;
    this.info = `正在加载引擎与模型：${path.basename(this.cfg.model)}`;
    this.pushStatus();

    const overrides = [
      'logAllGTPCommunication=false',
      'logSearchInfo=false',
      'ponderingEnabled=false',
      `numSearchThreads=${this.cfg.numSearchThreads}`,
    ];
    const args = ['gtp', '-model', this.cfg.model];
    if (this.cfg.config) args.push('-config', this.cfg.config);
    args.push('-override-config', overrides.join(','));

    log('启动引擎:', this.cfg.katago, args.join(' '));
    const proc = spawn(this.cfg.katago, args, {
      cwd: RUN_DIR,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.buf = '';
    this.session += 1;
    this.holdPump = false;
    this.pendingStops = 0;
    this.orphan = false;

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => this._onData(d));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => {
      const text = String(d).trimEnd();
      if (text) {
        this.stderrTail.push(text);
        if (this.stderrTail.length > 20) this.stderrTail.shift();
      }
    });
    proc.on('error', (e) => {
      this.state = 'error';
      this.error = '引擎启动失败：' + e.message;
      log('引擎启动失败:', e.message);
      this.pushStatus();
    });
    proc.on('exit', (code, signal) => {
      log(`引擎退出 code=${code} signal=${signal}`);
      const wasReady = this.state === 'ready';
      this.proc = null;
      this._failCurrent(new Error(`引擎已退出（code=${code}）`));
      if (this.state !== 'error') {
        this.state = 'error';
        this.error = `KataGo 进程已退出（code=${code}）`;
      }
      this.pushStatus();
      // 自动重启（最多 3 次）
      if (wasReady && this.restarts < 3) {
        this.restarts += 1;
        setTimeout(() => { this.state = 'idle'; this.start().catch(() => {}); }, 1500);
      }
    });

    await once(proc, 'spawn');
    try {
      await this.cmd('name', { timeout: this.cfg.startupTimeoutMs });
    } catch (e) {
      this.state = 'error';
      this.error = '引擎握手失败：' + e.message;
      this.pushStatus();
      return;
    }
    this.state = 'ready';
    this.info = 'KataGo 就绪';
    log('引擎就绪');
    this.pushStatus();
    this._pump();
  }

  /* ---- stdout 按行分发 ---- */
  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, '');
      this.buf = this.buf.slice(idx + 1);
      this._onLine(line);
    }
  }

  _onLine(line) {
    if (line.startsWith('info ')) {
      const job = this.cur;
      const tag = job ? job.tag : null;
      const parsed = parseInfoLine(line);
      parsed.tag = tag;
      if (job && job.opts.onInfo) job.opts.onInfo(parsed);
      sseSend('info', parsed);
      return;
    }

    // 孤儿响应块：例如插队发出的 stop 的应答，丢到空行为止
    if (this.orphan) {
      if (line.trim() === '') {
        this.orphan = false;
        this._afterStopAck();
      }
      return;
    }

    const job = this.cur;
    if (!job) {
      if (line.startsWith('=') || line.startsWith('?')) this.orphan = true;
      return;
    }
    if (job.collecting) {
      if (line.trim() === '') { this._finishCurrent(); return; }
      job.lines.push(line);
      return;
    }
    if (line.startsWith('=') || line.startsWith('?')) {
      job.ok = line[0] === '=';
      job.collecting = true;
      const rest = line.slice(1).trim();
      if (rest) job.lines.push(rest);
      return;
    }
    // 其余（引擎杂项输出）忽略
  }

  _afterStopAck() {
    this.pendingStops = Math.max(0, (this.pendingStops || 0) - 1);
    if (this.pendingStops === 0) {
      this.holdPump = false;
      this._pump();
    }
  }

  /**
   * 插队发送 stop（不排队、不等它自己的应答块）。
   * kata-analyze 不会自行结束，必须靠 stop 终止；而 stop 若走队列会被正在运行的
   * analyze 永久阻塞。所以直接写 stdin，并暂停派发后续命令，直到 stop 的应答块
   * 被当作"孤儿响应"吞掉，避免响应块错位。
   */
  interrupt() {
    if (!this.proc) return false;
    this.holdPump = true;
    this.pendingStops = (this.pendingStops || 0) + 1;
    try {
      this.proc.stdin.write('stop\n');
    } catch {
      this.holdPump = false;
      this.pendingStops = 0;
      return false;
    }
    // 兜底：万一引擎不回应 stop，也不能把队列卡死
    setTimeout(() => {
      if (this.pendingStops > 0) {
        this.pendingStops = 0;
        this.orphan = false;
        this.holdPump = false;
        this._pump();
      }
    }, 3000);
    return true;
  }

  _finishCurrent() {
    const job = this.cur;
    if (!job) return;
    this.cur = null;
    if (job.timer) clearTimeout(job.timer);
    if (job.ok) job.resolve({ ok: true, lines: job.lines, text: job.lines.join('\n') });
    else job.reject(new Error(job.lines.join(' ') || '引擎返回错误'));
    this._pump();
  }

  _failCurrent(err) {
    const job = this.cur;
    if (!job) return;
    this.cur = null;
    if (job.timer) clearTimeout(job.timer);
    job.reject(err);
    this._pump();
  }

  _pump() {
    // 注意：state 为 starting 时也要放行（启动时的 name 握手命令就排在这时候）
    if (this.holdPump) return;   // 正在等 stop 的应答块，先别派发
    if (this.cur || !this.queue.length || !this.proc) return;
    const job = this.queue.shift();
    this.cur = job;
    job.timer = setTimeout(() => {
      log('命令超时:', job.command);
      try { this.proc && this.proc.stdin.write('stop\n'); } catch { /* 忽略 */ }
      setTimeout(() => {
        if (this.cur === job) {
          this._failCurrent(new Error('命令超时：' + job.command));
          // 超时可能已让协议错位，重启引擎保证后续正常
          this.restart('命令超时');
        }
      }, 4000);
    }, job.opts.timeout || 60000);
    try { this.proc.stdin.write(job.command + '\n'); } catch (e) {
      this._failCurrent(e);
    }
  }

  cmd(command, opts = {}) {
    return new Promise((resolve, reject) => {
      if (!this.proc && this.state === 'error') {
        reject(new Error(this.error || '引擎不可用'));
        return;
      }
      // 紧急命令（落子/走子）可以打断正在进行的分析，避免用户等待
      if (opts.urgent && this.cur && this.cur.opts.interruptible && !this.holdPump) {
        this.interrupt();
      }
      this.queue.push({
        command, opts, lines: [], collecting: false, ok: false,
        tag: opts.tag || null, resolve, reject, timer: null,
      });
      this._pump();
    });
  }

  async restart(reason) {
    log('重启引擎:', reason || '');
    const proc = this.proc;
    this.proc = null;
    this.state = 'idle';
    this.restarts = 0;
    this._failCurrent(new Error('引擎重启'));
    if (proc) { try { proc.kill(); } catch { /* 忽略 */ } }
    await new Promise((r) => setTimeout(r, 800));
    await this.start();
  }
}

/* ========================== HTTP 服务 ========================== */
const engineConfig = resolveEngineConfig();
const engine = new KataGoEngine(engineConfig);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 4 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

const apiRoutes = {
  'GET /api/status': async () => engine.status(),
  'GET /api/config': async () => ({
    port: engineConfig.port,
    host: engineConfig.host,
    requireToken: !!engineConfig.token,
    hasEngine: !!engineConfig.katago,
  }),

  'POST /api/restart': async () => {
    engine.restart('用户请求').catch((e) => log('重启失败:', e.message));
    return { ok: true };
  },

  'POST /api/newgame': async (body) => {
    const size = clampInt(body.boardSize, 2, 25, 19);
    const komi = Number.isFinite(body.komi) ? body.komi : 7.5;
    const rules = typeof body.rules === 'string' && body.rules ? body.rules : 'chinese';
    const handicap = clampInt(body.handicap, 0, 9, 0);
    await engine.cmd(`boardsize ${size}`, { urgent: true });
    await engine.cmd(`kata-set-rules ${rules}`);
    await engine.cmd(`komi ${komi}`);
    await engine.cmd('clear_board');
    let stones = [];
    if (handicap > 0) {
      // 优先用 fixed_handicap（标准的星位让子点），引擎不支持时退回 place_free_handicap
      let r;
      try {
        r = await engine.cmd(`fixed_handicap ${handicap}`, { timeout: 30000 });
      } catch {
        r = await engine.cmd(`place_free_handicap ${handicap}`, { timeout: 30000 });
      }
      stones = r.text.split(/\s+/).filter(Boolean);
    }
    return { ok: true, boardSize: size, komi, rules, handicap, handicapStones: stones };
  },

  'POST /api/sync': async (body) => {
    const size = clampInt(body.boardSize, 2, 25, 19);
    const komi = Number.isFinite(body.komi) ? body.komi : 7.5;
    const rules = typeof body.rules === 'string' && body.rules ? body.rules : 'chinese';
    const moves = Array.isArray(body.moves) ? body.moves : [];
    await engine.cmd(`boardsize ${size}`, { urgent: true });
    await engine.cmd(`kata-set-rules ${rules}`);
    await engine.cmd(`komi ${komi}`);
    await engine.cmd('clear_board');
    if (Array.isArray(body.handicapStones) && body.handicapStones.length) {
      await engine.cmd(`set_free_handicap ${body.handicapStones.join(' ')}`);
    }
    for (const m of moves) {
      const color = m.color === 'W' || m.color === 'w' ? 'W' : 'B';
      const mv = String(m.move || '').trim();
      if (!mv) continue;
      await engine.cmd(`play ${color} ${mv}`, { timeout: 20000 });
    }
    return { ok: true, replayed: moves.length };
  },

  'POST /api/play': async (body) => {
    const color = body.color === 'W' ? 'W' : 'B';
    const move = String(body.move || '').trim();
    if (!move) throw new Error('缺少着法');
    const r = await engine.cmd(`play ${color} ${move}`, { timeout: 20000, urgent: true });
    return { ok: true, color, move, raw: r.text };
  },

  'POST /api/genmove': async (body) => {
    const color = body.color === 'W' ? 'W' : 'B';
    const seconds = Number(body.seconds) > 0 ? Number(body.seconds) : null;
    const visits = clampInt(body.visits, 1, 2000000, 600);
    const tag = typeof body.tag === 'string' ? body.tag : null;
    if (Number.isFinite(body.pda)) {
      await engine.cmd(`kata-set-param playoutDoublingAdvantage ${body.pda}`);
    }
    // 慢机器上用"思考秒数"比固定 visits 更可控：两者都设，先到者生效
    await engine.cmd(`kata-set-param maxVisits ${seconds ? 1000000 : visits}`, { urgent: true });
    await engine.cmd(`kata-set-param maxTime ${seconds ? seconds : 1000000}`);
    const started = Date.now();
    const r = await engine.cmd(`kata-genmove_analyze ${color} 20`, {
      timeout: Math.max(90000, (seconds ? seconds * 1000 : visits * 150) + 45000),
      tag,
      onInfo: () => {},
    });
    const moveMatch = /play\s+([A-Ta-t][0-9]{1,2}|pass|resign)/i.exec(r.text);
    const move = moveMatch ? moveMatch[1] : r.text.trim().split(/\s+/).pop();
    return {
      ok: true, color, move: normalizeMove(move), visits, elapsedMs: Date.now() - started,
      raw: r.text.slice(0, 200),
    };
  },

  'POST /api/analyze': async (body) => {
    const color = body.color === 'W' ? 'W' : 'B';
    const seconds = Number(body.seconds) > 0 ? Number(body.seconds) : 1.6;
    const tag = typeof body.tag === 'string' ? body.tag : null;
    const ownership = !!body.ownership;
    let last = null;

    // kata-analyze 不会自己结束：它会一直推送 info 行，直到收到 stop。
    // 所以这里不等待它，而是分析够 seconds 秒后插队发 stop 收尾。
    await engine.cmd('kata-set-param maxVisits 1000000');
    await engine.cmd('kata-set-param maxTime 1000000');
    const cmd = `kata-analyze ${color} 20${ownership ? ' ownership true' : ''}`;
    const job = engine.cmd(cmd, {
      timeout: 120000,
      tag,
      interruptible: true,
      onInfo: (p) => { last = p; },
    });

    await new Promise((r) => setTimeout(r, Math.round(seconds * 1000)));
    engine.interrupt();
    try {
      await job;
    } catch (e) {
      // 分析被落子等其他命令打断属于正常情况
      log('分析提前结束:', e.message);
    }

    return { ok: true, tag, result: last };
  },

  'POST /api/setparam': async (body) => {
    const key = String(body.key || '').replace(/[^A-Za-z]/g, '');
    const value = String(body.value ?? '').replace(/[\r\n]/g, '');
    if (!key || !value) throw new Error('参数无效');
    await engine.cmd(`kata-set-param ${key} ${value}`);
    return { ok: true, key, value };
  },

  'POST /api/score': async () => {
    const r = await engine.cmd('final_score', { timeout: 60000 });
    return { ok: true, score: r.text.trim() };
  },

  /** 只读调试命令（showboard 等），方便核对引擎内部棋盘 */
  'POST /api/raw': async (body) => {
    const command = String(body.command || '').replace(/[\r\n]+/g, ' ').trim();
    if (!command) throw new Error('缺少命令');
    const allowed = /^(showboard|final_score|version|name|protocol_version|list_commands|kata-raw-nn|kata-genmove|stop|lz-analyze|kata-analyze)\b/i;
    if (!allowed.test(command)) throw new Error('该命令未开放：' + command);
    const r = await engine.cmd(command, { timeout: 30000 });
    return { ok: true, text: r.text };
  },

  'POST /api/estimate': async () => {
    // KataGo 的自定义命令：快速地形/死活估计（不一定在旧版本可用）
    try {
      const r = await engine.cmd('kata-estimate-score B', { timeout: 120000 });
      return { ok: true, result: r.text.trim() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
};

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeMove(mv) {
  if (!mv) return 'pass';
  const s = String(mv).trim();
  if (/^pass$/i.test(s)) return 'pass';
  if (/^resign$/i.test(s)) return 'resign';
  return s.toUpperCase();
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, rel.replace(/^[\\/]+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const key = `${req.method} ${pathname}`;

  // ---- CORS：允许 Cloudflare Pages 等静态托管页面跨域调用本机引擎 ----
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Go-Token');
  res.setHeader('Access-Control-Max-Age', '86400');
  // Chrome/Edge 的 Private Network Access：公网页面(https)访问本机(http)服务，
  // 必须由服务端显式允许，否则会在预检阶段被浏览器拦掉
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // ---- 可选的访问令牌（把引擎暴露到公网时建议设置）----
    if (pathname.startsWith('/api/') && engineConfig.token) {
      const given = req.headers['x-go-token'] || url.searchParams.get('token') || '';
      if (given !== engineConfig.token) {
        sendJson(res, 401, { ok: false, error: '访问令牌不正确（请在设置里填写引擎令牌）' });
        return;
      }
    }

    // SSE
    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      sseClients.add(res);
      sseSend('status', engine.status());
      const ping = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* 忽略 */ }
      }, 15000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
      return;
    }

    if (apiRoutes[key]) {
      let body = {};
      if (req.method === 'POST') body = await readJson(req);
      const result = await apiRoutes[key](body);
      sendJson(res, 200, result);
      return;
    }

    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { ok: false, error: '未知接口：' + key });
      return;
    }

    serveStatic(req, res, pathname);
  } catch (e) {
    log('请求出错', key, e && e.message);
    sendJson(res, 500, { ok: false, error: (e && e.message) || String(e) });
  }
});

/* ============================ 启动 ============================ */
function openBrowser(url) {
  try {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (e) {
    log('打开浏览器失败:', e.message);
  }
}

/** 检测是否已有本服务在运行（避免重复双击启动多个实例） */
async function probeExisting(port) {
  for (let p = port; p < port + 8; p++) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/api/status`, { signal: AbortSignal.timeout(700) });
      const data = await res.json();
      if (data && typeof data.katago !== 'undefined' && typeof data.state === 'string') return p;
    } catch { /* 该端口没有服务 */ }
  }
  return null;
}

function listenWithRetry(port, attempt = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 12) {
      log(`端口 ${port} 被占用，改用 ${port + 1}`);
      listenWithRetry(port + 1, attempt + 1);
    } else {
      log('服务启动失败:', err.message);
      process.exit(1);
    }
  });
  server.listen(port, engineConfig.host || '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    log('==============================================');
    log('围棋 · KataGo 已启动：' + url);
    log('引擎:', engineConfig.katago || '(未找到)');
    log('模型:', engineConfig.model || '(未找到)');
    log('==============================================');
    console.log('\n  ▶ 网页地址： ' + url);
    console.log('  ▶ 关闭这个窗口即可停止服务与引擎。\n');
    if (process.env.GO_NO_OPEN !== '1') openBrowser(url);
    engine.start().catch((e) => log('引擎启动异常:', e.message));
  });
}

(async () => {
  if (process.env.GO_FORCE !== '1') {
    const running = await probeExisting(engineConfig.port);
    if (running) {
      const url = `http://127.0.0.1:${running}/`;
      log('服务已在运行：' + url + '（如需重启，请先关闭原窗口）');
      console.log('\n  ▶ 服务已在运行，直接打开： ' + url + '\n');
      if (process.env.GO_NO_OPEN !== '1') openBrowser(url);
      process.exit(0);
    }
  }
  listenWithRetry(engineConfig.port);
})();

process.on('SIGINT', () => {
  log('收到退出信号，关闭引擎');
  try { engine.proc && engine.proc.kill(); } catch { /* 忽略 */ }
  process.exit(0);
});
process.on('uncaughtException', (e) => log('未捕获异常:', e.stack || e.message));
process.on('unhandledRejection', (e) => log('未处理的 Promise 拒绝:', (e && e.message) || String(e)));
