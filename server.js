#!/usr/bin/env node
// Claude 사무실 관제탑 서버
// ~/.claude/projects 아래 세션 기록(jsonl)을 0.25초마다 따라 읽어서 브라우저로 흘려보낸다.
// 훅/설정은 건드리지 않고, 외부 패키지도 쓰지 않는다. 127.0.0.1 에서만 열린다.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT || 4317);
const ROOT = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
const CODEX_ROOT = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
const CODEX_RECENT_MS = 3 * 24 * 3600 * 1000; // Codex 기록은 날짜별로 쌓이니 최근 3일 것만 따라간다
const POLL_MS = 250;
const SCAN_MS = 3000;
const RECENT_MS = 24 * 3600 * 1000; // 시작할 때 이만큼 최근에 바뀐 파일만 과거 기록을 읽는다
const TAIL_BYTES = 256 * 1024;      // 과거 기록은 파일 끝에서 이만큼만
const HISTORY_MAX = 3000;

const files = new Map();    // filePath -> { project, offset, rest, isSub, agentId }
const projects = new Map(); // projectKey -> { key, name, cwd, lastActive, sessionId }
const history = [];
const clients = new Set();
let booted = false;

const trunc = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s);

// tool_input 중 화면에 필요한 것만 남긴다 (파일 내용·diff 같은 큰 값은 버림)
function slimInput(input) {
  if (!input || typeof input !== 'object') return {};
  const keep = ['file_path', 'notebook_path', 'path', 'pattern', 'glob', 'command', 'description',
    'subagent_type', 'url', 'query', 'prompt', 'skill', 'action', 'text', 'coordinate', 'element'];
  const out = {};
  for (const k of keep) if (input[k] != null) out[k] = trunc(String(input[k]), 160);
  if (Array.isArray(input.todos)) out.todos = input.todos.length;
  return out;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(c => c && c.type === 'text').map(c => c.text).join(' ');
  return '';
}

function projectFor(filePath) {
  const rel = path.relative(ROOT, filePath);
  return rel.split(path.sep)[0];
}

function touchProject(key, line) {
  let p = projects.get(key);
  if (!p) {
    // 디렉터리 이름은 경로의 / 를 - 로 바꾼 형태다. cwd 를 아직 모르면 마지막 조각으로 이름을 짓는다.
    const guess = key.split('-').filter(Boolean).pop() || key;
    p = { key, name: guess, cwd: '', lastActive: 0, sessionId: '' };
    projects.set(key, p);
  }
  if (line) {
    if (line.cwd && !p.cwd) { p.cwd = line.cwd; p.name = path.basename(line.cwd) || p.name; }
    const t = Date.parse(line.timestamp || '') || 0;
    if (t > p.lastActive) { p.lastActive = t; if (line.sessionId && !line.isSidechain) p.sessionId = line.sessionId; }
  }
  return p;
}

// jsonl 한 줄 -> 화면용 이벤트 0개 이상
function convert(line, f) {
  const out = [];
  if (!line || typeof line !== 'object') return out;
  const sub = f.isSub || line.isSidechain === true;
  const base = {
    project: f.project,
    sessionId: line.sessionId || '',
    ts: Date.parse(line.timestamp || '') || Date.now(),
    agent_id: sub ? (line.agentId || f.agentId || 'sidechain') : null,
  };
  const msg = line.message || {};
  if (line.type === 'assistant' && Array.isArray(msg.content)) {
    for (const c of msg.content) {
      if (c.type === 'tool_use') out.push({ ...base, ev: 'PreToolUse', tool_name: c.name, tool_use_id: c.id, tool_input: slimInput(c.input) });
      else if (c.type === 'thinking') out.push({ ...base, ev: 'Thinking' });
      else if (c.type === 'text' && c.text && c.text.trim()) out.push({ ...base, ev: 'Text', text: trunc(c.text.trim(), 140) });
    }
  } else if (line.type === 'user' && !line.isMeta) {
    if (Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c.type === 'tool_result') out.push({ ...base, ev: 'PostToolUse', tool_use_id: c.tool_use_id, is_error: !!c.is_error });
      }
    }
    const text = textOf(msg.content).trim();
    if (text && !out.length) {
      const cmd = text.match(/<command-name>\/?([^<]+)<\/command-name>/);
      if (cmd) out.push({ ...base, ev: 'Command', text: '/' + cmd[1].replace(/^\//, '') });
      else if (text.startsWith('[Request interrupted')) out.push({ ...base, ev: 'Interrupted' });
      else if (!text.startsWith('<')) out.push({ ...base, ev: 'Prompt', text: trunc(text, 140) });
    }
  }
  return out;
}

function emit(ev, live) {
  history.push(ev);
  if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
  if (live) broadcast({ type: 'event', event: ev });
}

const CHUNK_BYTES = 4 * 1024 * 1024;   // 한 번에 읽는 최대 크기
const MAX_BACKLOG = 32 * 1024 * 1024;  // 이보다 많이 밀렸으면 앞부분은 건너뛰고 끝부분만 본다
const MAX_LINE = 8 * 1024 * 1024;      // 이보다 긴 한 줄은 버린다

function readNew(filePath, f, live) {
  let st;
  try { st = fs.statSync(filePath); } catch { files.delete(filePath); return; }
  if (st.size < f.offset) { f.offset = 0; f.rest = ''; } // 파일이 새로 써졌으면 처음부터
  if (st.size === f.offset) return;
  f.lastMs = Date.now();
  if (st.size - f.offset > MAX_BACKLOG) { f.offset = st.size - TAIL_BYTES; f.rest = '\u0000'; }
  const fd = fs.openSync(filePath, 'r');
  try {
    const len = Math.min(st.size - f.offset, CHUNK_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, f.offset);
    f.offset += len;
    const chunk = f.rest + buf.toString('utf8');
    const lines = chunk.split('\n');
    f.rest = lines.pop();
    if (f.rest.length > MAX_LINE) f.rest = '\u0000'; // 줄이 너무 길면 끝날 때까지 버림
    let changed = false;
    for (const raw of lines) {
      if (!raw.trim() || raw.length > MAX_LINE) continue;
      let obj;
      try { obj = JSON.parse(raw); } catch { continue; }
      changed = true;
      if (f.codex) {
        touchProject(f.project, { cwd: f.cwd, timestamp: obj.timestamp, sessionId: f.sessionId });
        for (const ev of convertCodex(obj, f)) emit(ev, live);
      } else {
        touchProject(f.project, obj);
        for (const ev of convert(obj, f)) emit(ev, live);
      }
    }
    if (changed && live) broadcastFloors();
  } finally { fs.closeSync(fd); }
}

function walk(dir, depth, acc) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 3) walk(p, depth + 1, acc);
    else if (e.isFile() && e.name.endsWith('.jsonl')) acc.push(p);
  }
  return acc;
}

// ───────── Codex ─────────
// Claude 의 프로젝트 폴더 이름과 같은 규칙(경로의 영숫자 외 문자를 - 로)으로 층을 맞춘다
const projectKeyFromCwd = cwd => cwd.replace(/[^a-zA-Z0-9]/g, '-');
const ignored = new Set();

// 첫 줄(session_meta)에 긴 지시문이 들어 있어 잘릴 수 있으니, JSON 파싱 대신 앞부분 글자에서 cwd 를 찾는다
function codexMeta(fp) {
  try {
    const fd = fs.openSync(fp, 'r');
    const buf = Buffer.alloc(1024 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.toString('utf8', 0, n);
    const cwd = head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/) || head.match(/<cwd>([^<]+)<\/cwd>/);
    if (!cwd) return null;
    const id = head.match(/"id"\s*:\s*"([0-9a-f]{8}-[0-9a-f-]{27})"/i);
    let dir = cwd[1];
    try { dir = JSON.parse('"' + dir + '"'); } catch {}
    return { cwd: dir, id: id ? id[1] : '' };
  } catch {}
  return null;
}

function shellString(args) {
  let c = args.command != null ? args.command : args.cmd;
  if (Array.isArray(c)) {
    const i = c.findIndex(x => /^-(l?c|Command)$/i.test(x)); // bash -lc "…", powershell -Command "…"
    c = i >= 0 && /(^|[\\/])((ba|z)?sh|powershell|pwsh)(\.exe)?$/i.test(c[0]) ? c.slice(i + 1).join(' ') : c.join(' ');
  }
  return String(c || '');
}
function patchTool(text) {
  const m = String(text || '').match(/\*\*\* (Update|Add) File: (\S+)/);
  return { tool_name: m && m[1] === 'Add' ? 'Write' : 'Edit', tool_input: { file_path: m ? m[2] : 'patch' } };
}
// Codex 는 파일 읽기·검색도 셸로 하니까, 명령을 보고 Claude 도구 이름으로 바꿔서 같은 방으로 보낸다
function classifyShell(cmd) {
  const c = cmd.trim().replace(/^cd\s+\S+\s*&&\s*/, '');
  if (/\bapply_patch\b/.test(c)) return patchTool(c);
  const tok = c.split(/\s+/);
  const unq = t => (t || '').replace(/^['"]|['"]$/g, '');
  const head = tok[0].toLowerCase();
  // 윈도우 PowerShell 명령도 같은 방으로
  if (/^(select-string|sls|findstr)$/.test(head)) return { tool_name: 'Grep', tool_input: { pattern: trunc(unq(tok.slice(1).find(t => !t.startsWith('-'))) || c, 80) } };
  if (/^(get-content|gc|type)$/.test(head)) return { tool_name: 'Read', tool_input: { file_path: unq([...tok].reverse().find(t => !t.startsWith('-'))) || c } };
  if (/^(get-childitem|gci|dir)$/.test(head)) return { tool_name: 'Glob', tool_input: { pattern: trunc(c, 60) } };
  if (/^(rg|grep|ag|ack|git-grep)$/.test(tok[0])) return { tool_name: 'Grep', tool_input: { pattern: trunc(unq(tok.slice(1).find(t => !t.startsWith('-'))) || c, 80) } };
  if (/^(cat|sed|head|tail|nl|less|bat|wc)$/.test(tok[0])) {
    const file = [...tok].reverse().find(t => /[\/.]/.test(t) && !t.startsWith('-') && !/^['"]?\d/.test(t));
    return { tool_name: 'Read', tool_input: { file_path: unq(file) || c } };
  }
  if (/^(ls|find|tree|fd)$/.test(tok[0])) return { tool_name: 'Glob', tool_input: { pattern: trunc(c, 60) } };
  return { tool_name: 'Bash', tool_input: { command: trunc(c, 160) } };
}
function convertCodex(o, f) {
  const out = [];
  if (!o || typeof o !== 'object') return out;
  const wrapped = typeof o.type === 'string' && o.payload && typeof o.payload === 'object';
  const p = wrapped ? o.payload : o;
  const base = { project: f.project, sessionId: f.sessionId, who: 'codex', ts: Date.parse(o.timestamp || '') || Date.now(), agent_id: null };
  const text = c => (Array.isArray(c) ? c.map(x => x.text || '').join(' ') : String(c || '')).trim();
  if (wrapped && o.type === 'event_msg') {
    if (p.type === 'user_message' && p.message && !String(p.message).trim().startsWith('<')) out.push({ ...base, ev: 'Prompt', text: trunc(String(p.message).trim(), 140) });
    else if (p.type === 'agent_message' && p.message) out.push({ ...base, ev: 'Text', text: trunc(String(p.message).trim(), 140) });
    else if (p.type === 'agent_reasoning') out.push({ ...base, ev: 'Thinking' });
    else if (p.type === 'task_complete') out.push({ ...base, ev: 'Stop' });
    else if (p.type === 'turn_aborted') out.push({ ...base, ev: 'Interrupted' });
    return out;
  }
  if (wrapped && o.type !== 'response_item') return out;
  const pre = (id, t) => out.push({ ...base, ev: 'PreToolUse', tool_use_id: id, tool_name: t.tool_name, tool_input: t.tool_input });
  switch (p.type) {
    case 'message': // 예전 형식에는 event_msg 가 없어서 message 로 대신한다
      if (!wrapped) {
        const t = text(p.content);
        if (p.role === 'user' && t && !t.startsWith('<')) out.push({ ...base, ev: 'Prompt', text: trunc(t, 140) });
        if (p.role === 'assistant' && t) out.push({ ...base, ev: 'Text', text: trunc(t, 140) });
      }
      break;
    case 'reasoning': out.push({ ...base, ev: 'Thinking' }); break;
    case 'function_call': {
      let args = {}; try { args = JSON.parse(p.arguments || '{}'); } catch {}
      const name = p.name || '';
      const t = /^(shell|exec|exec_command|unified_exec|shell_command|container\.exec|local_shell)$/.test(name) ? classifyShell(shellString(args))
        : name === 'write_stdin' ? { tool_name: 'BashOutput', tool_input: {} }
        : name === 'js' ? { tool_name: 'Bash', tool_input: { command: 'js ' + trunc(String(args.code || args.source || args.input || ''), 60) } }
        : /^(send_message|spawn_agent|wait_agent|wait)$/.test(name) ? { tool_name: 'SendMessage', tool_input: {} }
        : name === 'apply_patch' ? patchTool(args.input)
        : name === 'update_plan' ? { tool_name: 'TodoWrite', tool_input: { todos: (args.plan || []).length } }
        : name === 'view_image' ? { tool_name: 'Read', tool_input: { file_path: args.path || '' } }
        : { tool_name: name, tool_input: slimInput(args) };
      pre(p.call_id, t);
      break;
    }
    case 'custom_tool_call': pre(p.call_id, p.name === 'apply_patch' ? patchTool(p.input) : { tool_name: p.name || 'tool', tool_input: {} }); break;
    case 'local_shell_call': pre(p.call_id || p.id, classifyShell(shellString((p.action) || {}))); break;
    case 'web_search_call': {
      const id = p.id || 'ws' + base.ts;
      pre(id, { tool_name: 'WebSearch', tool_input: { query: trunc(String((p.action && p.action.query) || '웹'), 80) } });
      out.push({ ...base, ev: 'PostToolUse', tool_use_id: id, is_error: false });
      break;
    }
    case 'function_call_output': case 'custom_tool_call_output': {
      const s = typeof p.output === 'string' ? p.output : JSON.stringify(p.output || '');
      const m = s.match(/exit(?:_| )code"?\s*[:=]?\s*(\d+)/i);
      out.push({ ...base, ev: 'PostToolUse', tool_use_id: p.call_id, is_error: !!m && m[1] !== '0' });
      break;
    }
  }
  return out;
}

function scanCodex() {
  for (const fp of walk(CODEX_ROOT, 0, [])) {
    if (files.has(fp) || ignored.has(fp)) continue;
    let st;
    try { st = fs.statSync(fp); } catch { continue; }
    if (Date.now() - st.mtimeMs > CODEX_RECENT_MS) { ignored.add(fp); continue; }
    const meta = codexMeta(fp);
    if (!meta) { if (Date.now() - st.mtimeMs > 60000) ignored.add(fp); continue; } // 첫 줄이 아직 안 써졌으면 다음에 다시
    const idFromName = (path.basename(fp, '.jsonl').match(/[0-9a-f]{8}-[0-9a-f-]{27}$/i) || [])[0];
    const f = { codex: true, project: projectKeyFromCwd(meta.cwd), cwd: meta.cwd, sessionId: 'codex-' + (meta.id || idFromName || path.basename(fp)), offset: 0, rest: '' };
    files.set(fp, f);
    const proj = touchProject(f.project, { cwd: meta.cwd });
    if (!proj.cwd) { proj.cwd = meta.cwd; proj.name = path.basename(meta.cwd); }
    // 처음 보는 파일은 끝부분만 읽는다 (Codex 기록은 수백 MB 까지 커질 수 있다)
    f.offset = Math.max(0, st.size - TAIL_BYTES);
    if (f.offset > 0) f.rest = '\u0000';
    readNew(fp, f, booted);
  }
}

function scan() {
  let dirs = [];
  try { dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch {}
  for (const d of dirs) touchProject(d);
  for (const fp of walk(ROOT, 0, [])) {
    if (files.has(fp)) continue;
    const base = path.basename(fp, '.jsonl');
    const isSub = base.startsWith('agent-');
    const f = { project: projectFor(fp), offset: 0, rest: '', isSub, agentId: isSub ? base.slice(6) : null };
    files.set(fp, f);
    let st;
    try { st = fs.statSync(fp); } catch { continue; }
    if (!booted) {
      // 시작 시점: 오래된 파일은 층만 만들고, 최근 파일은 끝부분을 기록으로 읽어둔다
      if (Date.now() - st.mtimeMs > RECENT_MS) {
        f.offset = st.size;
        touchProject(f.project).lastActive = Math.max(touchProject(f.project).lastActive, st.mtimeMs);
        peekCwd(fp, f.project);
      } else {
        f.offset = Math.max(0, st.size - TAIL_BYTES);
        if (f.offset > 0) f.rest = '\u0000'; // 첫 줄은 잘렸을 수 있으니 버린다
        readNew(fp, f, false);
      }
    } else {
      // 실행 중에 새로 생긴 파일(새 세션, /clear, 서브에이전트)은 처음부터. 이미 큰 파일이면 끝부분만
      f.offset = Math.max(0, st.size - TAIL_BYTES);
      if (f.offset > 0) f.rest = '\u0000';
      readNew(fp, f, true);
    }
  }
  scanCodex();
  if (booted) broadcastFloors();
}

// 오래된 프로젝트도 이름은 제대로 보이도록 첫 몇 줄에서 cwd 만 읽는다
function peekCwd(fp, key) {
  const p = touchProject(key);
  if (p.cwd) return;
  try {
    const fd = fs.openSync(fp, 'r');
    const buf = Buffer.alloc(16384);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const raw of buf.toString('utf8', 0, n).split('\n')) {
      try { const o = JSON.parse(raw); if (o.cwd) { p.cwd = o.cwd; p.name = path.basename(o.cwd); return; } } catch {}
    }
  } catch {}
}

// 최근 10분 안에 바뀐 파일은 0.25초마다, 나머지는 5초마다 확인한다
let tick = 0;
function poll() {
  tick++;
  for (const [fp, f] of files) {
    if (Date.now() - (f.lastMs || 0) > 600000 && tick % 20 !== 0) continue;
    readNew(fp, f, true);
  }
}

function floorList() {
  return [...projects.values()].map(p => ({ key: p.key, name: p.name, cwd: p.cwd, lastActive: p.lastActive, sessionId: p.sessionId }));
}

function send(res, obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }
function broadcast(obj) { for (const res of clients) send(res, obj); }
let floorsTimer = null;
function broadcastFloors() {
  if (floorsTimer) return;
  floorsTimer = setTimeout(() => { floorsTimer = null; broadcast({ type: 'floors', floors: floorList() }); }, 500);
}

const INDEX = path.join(__dirname, 'public', 'index.html');
const CHAR_DIR = path.join(__dirname, 'characters');
// Codex 펫(v2 스프라이트시트)을 찾는 곳: 이 폴더의 pets/ 와 ~/.codex/pets/
const PET_DIRS = [path.join(__dirname, 'pets'), path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'pets')];
function findPets() {
  const pets = new Map();
  for (const dir of PET_DIRS) {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { continue; }
    for (const n of names) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, n, 'pet.json'), 'utf8'));
        if (meta.spriteVersionNumber && meta.spriteVersionNumber !== 2) continue;
        const sheet = path.join(dir, n, path.basename(meta.spritesheetPath || 'spritesheet.png'));
        const id = String(meta.id || n);
        if (!pets.has(id) && fs.existsSync(sheet)) pets.set(id, { id, name: meta.displayName || id, sheet });
      } catch {}
    }
  }
  return pets;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    send(res, { type: 'init', floors: floorList(), events: history, now: Date.now() });
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }
  if (url.pathname === '/pets/list') {
    const pets = findPets();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify([...pets.values()].map(p => ({ id: p.id, name: p.name, url: '/pets/' + encodeURIComponent(p.id) + '/sheet' }))));
  }
  const petMatch = url.pathname.match(/^\/pets\/([^/]+)\/sheet$/);
  if (petMatch) {
    const pet = findPets().get(decodeURIComponent(petMatch[1]));
    if (!pet) { res.writeHead(404); return res.end(); }
    return fs.readFile(pet.sheet, (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' }); res.end(buf);
    });
  }
  if (url.pathname === '/characters/list') {
    let list = [];
    try { list = fs.readdirSync(CHAR_DIR).filter(n => /\.(png|gif|webp|jpe?g)$/i.test(n)); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(list));
  }
  if (url.pathname.startsWith('/characters/')) {
    const name = path.basename(decodeURIComponent(url.pathname.slice(12)));
    const type = { '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }[path.extname(name).toLowerCase()];
    if (!type) { res.writeHead(404); return res.end(); }
    return fs.readFile(path.join(CHAR_DIR, name), (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); res.end(buf);
    });
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(INDEX, 'utf8', (err, html) => {
      if (err) { res.writeHead(500); return res.end('index.html 을 찾을 수 없습니다'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>' + html + '</body></html>');
    });
    return;
  }
  res.writeHead(404); res.end();
});

if (!fs.existsSync(ROOT)) {
  console.warn(`! ${ROOT} 가 없습니다. Claude Code를 한 번 이상 실행했는지 확인하세요. (CLAUDE_PROJECTS_DIR 로 경로 지정 가능)`);
}
scan();
booted = true;
setInterval(poll, POLL_MS);
setInterval(scan, SCAN_MS);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Claude 사무실 관제탑: http://localhost:${PORT}`);
  console.log(`읽는 위치: ${ROOT} (프로젝트 ${projects.size}개, 세션 파일 ${files.size}개)`);
  console.log(`Codex 기록: ${CODEX_ROOT} (최근 3일 세션 ${[...files.values()].filter(f => f.codex).length}개)`);
  const pets = findPets();
  console.log(pets.size ? `캐릭터: Codex 펫 ${pets.size}마리 (${[...pets.keys()].join(', ')})` : '캐릭터: 기본 고양이 (Codex 펫을 설치하면 그 캐릭터로 바뀝니다)');
});
