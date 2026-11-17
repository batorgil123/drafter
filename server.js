// Office Dota 2 Team Builder — live snake draft server
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const SECRET = process.env.SECRET || 'change-me-steppe-secret';
const ACCOUNTS = process.env.ACCOUNTS_JSON
  ? JSON.parse(process.env.ACCOUNTS_JSON)
  : JSON.parse(fs.readFileSync(path.join(__dirname, 'accounts.json'), 'utf8'));
const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8'));

// ---------- state ----------
function freshState() {
  return {
    players: SEED.map((p, i) => ({ id: 'p' + (i + 1), ...p })),
    nextId: SEED.length + 1,
    teamCount: 5,
    captains: [],          // player ids
    captainsLocked: false,
    captainOrder: [],      // random team order of captains (index 0 = Team 1), set on lock
    phase: 'setup',        // setup | draft | done
    teams: [],             // [{no, captainId, players:[ids]}]
    order: [],             // team numbers in pick order
    pickIndex: 0,
    history: [],           // [{team, playerId, by, at}]
  };
}
let state;
try { state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { state = freshState(); }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(DATA_FILE, JSON.stringify(state), () => {}), 200);
}

// ---------- auth (stateless signed tokens) ----------
const sign = (u) => crypto.createHmac('sha256', SECRET).update(u.username + ':' + u.password).digest('hex').slice(0, 32);
const makeToken = (u) => u.username + '.' + sign(u);
function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const [name, sig] = token.split('.');
  const u = ACCOUNTS.find((a) => a.username === name);
  if (!u || sign(u) !== sig) return null;
  return { username: u.username, role: u.role, team: u.team || null };
}

// ---------- draft logic ----------
const clean = (s, n = 40) => String(s || '').trim().slice(0, n);
const getP = (id) => state.players.find((p) => p.id === id);
const pickedIds = () => new Set(state.teams.flatMap((t) => t.players));

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function buildOrder(teamCount, poolSize) {
  const total = Math.min(poolSize, teamCount * 4);
  const order = [];
  for (let r = 0; order.length < total; r++) {
    const round = Array.from({ length: teamCount }, (_, i) => i + 1);
    if (r % 2 === 1) round.reverse();
    for (const t of round) if (order.length < total) order.push(t);
  }
  return order;
}

const COMPANIES = ['TPG', 'TPI', 'EM', 'MCST'];
function playerFrom(d) {
  const mmr = Math.max(0, Math.min(15000, parseInt(d.mmr, 10) || 0));
  const pos = Math.max(1, Math.min(5, parseInt(d.pos, 10) || 1));
  const sec = Math.max(1, Math.min(5, parseInt(d.sec, 10) || pos));
  const name = clean(d.name).toUpperCase();
  if (!name) throw new Error('Нэр оруулна уу');
  const company = String(d.company || '').trim().toUpperCase();
  if (!COMPANIES.includes(company)) throw new Error('Компани сонгоно уу');
  return { name, medal: clean(d.medal, 20) || 'Herald', mmr, pos, sec, company };
}

const actions = {
  // ---- admin ----
  addPlayer(a, d) { const p = playerFrom(d); state.players.push({ id: 'p' + state.nextId++, ...p }); },
  editPlayer(a, d) { const p = getP(d.id); if (!p) throw new Error('Тоглогч олдсонгүй'); Object.assign(p, playerFrom(d)); },
  deletePlayer(a, d) {
    if (state.phase !== 'setup') throw new Error('Драфтын үед устгах боломжгүй');
    state.players = state.players.filter((p) => p.id !== d.id);
    state.captains = state.captains.filter((c) => c !== d.id);
  },
  setTeamCount(a, d) {
    if (state.phase !== 'setup') throw new Error('Драфт эхэлсэн байна');
    const n = d.n === 4 ? 4 : 5; state.teamCount = n;
    if (state.captains.length > n) state.captains = state.captains.slice(0, n);
    state.captainsLocked = false;
  },
  toggleCaptain(a, d) {
    if (state.phase !== 'setup') throw new Error('Драфт эхэлсэн байна');
    if (!getP(d.id)) return;
    if (state.captains.includes(d.id)) state.captains = state.captains.filter((c) => c !== d.id);
    else { if (state.captains.length >= state.teamCount) throw new Error(`Яг ${state.teamCount} ахлагч сонгоно`); state.captains.push(d.id); }
    state.captainsLocked = false;
  },
  lockCaptains() {
    if (state.captains.length !== state.teamCount) throw new Error(`Яг ${state.teamCount} ахлагч сонгоно уу`);
    state.captainsLocked = true;
    state.captainOrder = shuffle(state.captains); // random: index 0 = Team 1
  },
  startDraft() {
    if (state.phase !== 'setup') throw new Error('Драфт аль хэдийн эхэлсэн');
    if (!state.captainsLocked) throw new Error('Эхлээд ахлагчдаа хадгална уу');
    if (state.players.length < 10) throw new Error('Дор хаяж 10 тоглогч хэрэгтэй');
    // team numbers decided randomly when captains were locked
    const valid = state.captainOrder && state.captainOrder.length === state.captains.length &&
      state.captains.every((c) => state.captainOrder.includes(c));
    if (!valid) state.captainOrder = shuffle(state.captains);
    const caps = state.captainOrder.map(getP);
    state.teams = caps.map((c, i) => ({ no: i + 1, captainId: c.id, players: [c.id] }));
    state.order = buildOrder(state.teamCount, state.players.length - caps.length);
    state.pickIndex = 0; state.history = []; state.phase = state.order.length ? 'draft' : 'done';
  },
  undo() {
    const h = state.history.pop(); if (!h) throw new Error('Буцаах сонголт алга');
    const t = state.teams.find((x) => x.no === h.team); t.players = t.players.filter((p) => p !== h.playerId);
    state.pickIndex--; state.phase = 'draft';
  },
  resetDraft() { Object.assign(state, { phase: 'setup', teams: [], order: [], pickIndex: 0, history: [] }); },
  resetAll() { state = freshState(); },
  // ---- captain or admin ----
  pick(a, d) {
    if (state.phase !== 'draft') throw new Error('Драфт идэвхгүй байна');
    const teamNo = state.order[state.pickIndex];
    if (a.role === 'captain' && a.team !== teamNo) throw new Error(`Одоо Баг ${teamNo}-ийн ээлж`);
    const p = getP(d.playerId);
    if (!p || pickedIds().has(p.id)) throw new Error('Тоглогч сонгох боломжгүй');
    state.teams.find((t) => t.no === teamNo).players.push(p.id);
    state.history.push({ team: teamNo, playerId: p.id, by: a.username, at: Date.now() });
    state.pickIndex++;
    if (state.pickIndex >= state.order.length) state.phase = 'done';
  },
};
const CAPTAIN_ALLOWED = new Set(['pick']);

// ---------- server ----------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => res.send('ok'));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });

const broadcast = () => io.emit('state', { ...state, online: io.engine.clientsCount });

io.on('connection', (socket) => {
  socket.data.acct = verify(socket.handshake.auth && socket.handshake.auth.token);
  socket.emit('me', socket.data.acct);
  broadcast();

  socket.on('login', ({ username, password } = {}, cb) => {
    const u = ACCOUNTS.find((x) => x.username === String(username || '').trim().toLowerCase() && x.password === password);
    if (!u) return cb && cb({ error: 'Нэвтрэх нэр эсвэл нууц үг буруу' });
    socket.data.acct = { username: u.username, role: u.role, team: u.team || null };
    cb && cb({ token: makeToken(u), me: socket.data.acct });
  });
  socket.on('logout', () => { socket.data.acct = null; socket.emit('me', null); });

  socket.on('action', ({ type, data } = {}, cb) => {
    const a = socket.data.acct; const fn = actions[type];
    try {
      if (!fn) throw new Error('Үл мэдэгдэх үйлдэл');
      if (!a) throw new Error('Нэвтэрнэ үү');
      if (a.role !== 'admin' && !CAPTAIN_ALLOWED.has(type)) throw new Error('Зөвхөн админ');
      fn(a, data || {}); save(); broadcast(); cb && cb({ ok: true });
    } catch (e) { cb && cb({ error: e.message }); }
  });
  socket.on('disconnect', () => setTimeout(broadcast, 50));
});

server.listen(PORT, () => console.log(`Snake draft running on http://localhost:${PORT}`));
