// Blockverse multiplayer server — matchmaking by map+mode, bot fill, relay + authoritative HP/score.
// Run: npm install && npm start   (PORT env var honoured; Render/Fly set it automatically)
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8787;
const WAIT_SECS = 8;          // how long a lobby waits for more humans before starting
const BOT_HP = 150, PLAYER_HP = 150, PLAYER_HIT = 1; // damage is sent in HP units
const RESPAWN = 2.5;

// ---------- Accounts (username + password, saved to a JSON file) ----------
// NOTE: on Render's free tier the file is wiped on each redeploy. Attach a persistent disk (or a database) before real users rely on it.
const DATA_FILE = process.env.DATA_FILE || './data.json';
let users = {}; try { users = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
let saveT = null; const saveUsers = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(users)); } catch (e) { console.error('save failed', e.message); } }, 500); };
const BANNED = ['fuck','shit','bitch','cunt','dick','cock','pussy','asshole','nigg','fag','retard','whore','slut','rape','nazi','hitler','porn','sex','penis','vagina','boob','kys','kill yourself','hoe','twat','wank','cum','damn','bastard','douche','jerkoff','molest','pedo'];
const normalize = n => n.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't').replace(/\$/g, 's').replace(/@/g, 'a').replace(/(.)\1+/g, '$1');
const nameProblem = n => {
  if (typeof n !== 'string') return 'Username required';
  if (!/^[A-Za-z0-9_]{3,16}$/.test(n)) return '3–16 letters, numbers or _ only';
  const norm = normalize(n); if (BANNED.some(w => norm.includes(normalize(w)))) return 'That username isn\'t allowed';
  if (/^(admin|server|system|moderator|blockverse)/i.test(n)) return 'That name is reserved';
  return null;
};
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');
const defaultProfile = () => ({ bits: 40, items: ['cap','none','shirt','pants'], wear: { head: 'cap', body: 'shirt', legs: 'pants' }, shirt: 0, pants: 1, hat: 2, owned: [0,1,2,3], coins: 0, wins: 0, deaths: 0, best: {} });
const byToken = t => Object.values(users).find(u => u.token === t);
// ---------- Moderation ----------
// Admins: comma-separated usernames in the ADMINS env var (e.g. ADMINS=kalbrecht,Rich). Admins can ban/mute/kick from the Account tab or with chat commands.
const ADMINS = new Set(String(process.env.ADMINS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
const isAdmin = u => !!u && ADMINS.has(u.name.toLowerCase());
let mod = { ipBans: {}, reports: [] }; try { mod = { ...mod, ...JSON.parse(fs.readFileSync(DATA_FILE + '.mod', 'utf8')) }; } catch {}
const saveMod = () => { try { fs.writeFileSync(DATA_FILE + '.mod', JSON.stringify(mod)); } catch {} };
const ipOf = req => String((req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')).split(',')[0].trim();
const activeBan = u => (u && u.ban && (u.ban.until === 0 || u.ban.until > Date.now())) ? u.ban : null;
const activeMute = u => (u && u.mute && u.mute.until > Date.now()) ? u.mute : null;
const ipBanned = ip => { const b = mod.ipBans[ip]; return b && (b.until === 0 || b.until > Date.now()) ? b : null; };
const banText = b => `Banned${b.until ? ' until ' + new Date(b.until).toLocaleString() : ' permanently'}${b.reason ? ': ' + b.reason : ''}`;
const hasBadWord = t => { const norm = normalize(String(t)); return BANNED.some(w => norm.includes(normalize(w))); };
function strike(u, ip) { // automatic moderation for repeated bad language
  const rec = u || (mod.ipBans[ip + '#strikes'] = mod.ipBans[ip + '#strikes'] || { strikes: 0 }); rec.strikes = (rec.strikes || 0) + 1;
  if (u) saveUsers(); else saveMod();
  if (rec.strikes >= 6) { if (u) { u.ban = { until: Date.now() + 3600e3, reason: 'Repeated inappropriate language (automatic)' }; saveUsers(); } else { mod.ipBans[ip] = { until: Date.now() + 3600e3, reason: 'Repeated inappropriate language (automatic)' }; saveMod(); } return 'ban'; }
  if (rec.strikes >= 3) { if (u) { u.mute = { until: Date.now() + 600e3, reason: 'Inappropriate language (automatic)' }; saveUsers(); } return 'mute'; }
  return 'warn';
}
function kickPlayer(target, reason) { for (const p of [...(target.room ? target.room.players : []), ...[...lobbies.values()].flatMap(L => L.players)]) if (p === target) { send(p.ws, { t: 'kicked', reason }); try { p.ws.close(); } catch {} } }
function findOnline(name) { const n = String(name).toLowerCase(); const all = [...rooms.values()].flatMap(r => r.players).concat([...lobbies.values()].flatMap(L => L.players)); return all.find(p => p.name.toLowerCase() === n); }
function modAction(admin, a) { // a = {action, user, minutes, reason}
  const name = String(a.user || '').replace(/^@/, ''); const key = name.toLowerCase(); const u = users[key]; const online = findOnline(name);
  const until = a.minutes > 0 ? Date.now() + a.minutes * 60e3 : 0; const reason = String(a.reason || '').slice(0, 120);
  if (a.action === 'ban') { if (u) u.ban = { until, reason, by: admin.name }; if (online && online.ip) mod.ipBans[online.ip] = { until, reason, by: admin.name }; if (!u && !online) throw new Error('No such user online or registered'); if (online) kickPlayer(online, banText({ until, reason })); saveUsers(); saveMod(); return `Banned ${name}${until ? ' for ' + a.minutes + ' min' : ' permanently'}`; }
  if (a.action === 'unban') { if (u) delete u.ban; for (const ip in mod.ipBans) if (mod.ipBans[ip].name === key) delete mod.ipBans[ip]; saveUsers(); saveMod(); return `Unbanned ${name}`; }
  if (a.action === 'mute') { if (!u) throw new Error('Only registered users can be muted'); u.mute = { until: until || Date.now() + 600e3, reason, by: admin.name }; saveUsers(); return `Muted ${name} for ${a.minutes || 10} min`; }
  if (a.action === 'unmute') { if (u) delete u.mute; saveUsers(); return `Unmuted ${name}`; }
  if (a.action === 'kick') { if (!online) throw new Error(`${name} isn't online`); kickPlayer(online, 'Kicked by a moderator' + (reason ? ': ' + reason : '')); return `Kicked ${name}`; }
  throw new Error('Unknown action');
}
const pub = u => ({ name: u.name, profile: u.profile, admin: isAdmin(u), muted: !!activeMute(u) });

// ---------- Stripe (Checkout + webhook). Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SITE_URL in Render env vars. ----------
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const SITE_URL = process.env.SITE_URL || 'https://kalyan-alt.github.io/blockverse-game/';
const PACKS = { 100: 99, 450: 399, 1200: 999, 2600: 1999 };   // Blockbux -> price in cents
const balances = new Map();                                   // token -> unclaimed Blockbux (in-memory: resets on redeploy)
const readBody = req => new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.end();
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/auth/check' && req.method === 'POST') { const { u } = JSON.parse((await readBody(req)).toString() || '{}'); const prob = nameProblem(u); res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ok: !prob && !users[u.toLowerCase()], error: prob || (users[u.toLowerCase()] ? 'That username is taken' : null) })); }
    if (url.pathname === '/auth/signup' && req.method === 'POST') {
      const { u, p } = JSON.parse((await readBody(req)).toString() || '{}'); const prob = nameProblem(u); if (prob) throw new Error(prob);
      if (typeof p !== 'string' || p.length < 4) throw new Error('Password must be at least 4 characters');
      const key = u.toLowerCase(); if (users[key]) throw new Error('That username is taken'); if (ipBanned(ipOf(req))) throw new Error(banText(ipBanned(ipOf(req))));
      const salt = crypto.randomBytes(8).toString('hex'); users[key] = { name: u, salt, hash: hashPw(p, salt), token: newToken(), profile: defaultProfile(), created: Date.now() }; saveUsers();
      res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ token: users[key].token, ...pub(users[key]) }));
    }
    if (url.pathname === '/auth/login' && req.method === 'POST') {
      const { u, p } = JSON.parse((await readBody(req)).toString() || '{}'); const user = users[String(u || '').toLowerCase()];
      if (!user || hashPw(String(p || ''), user.salt) !== user.hash) throw new Error('Wrong username or password');
      const b = activeBan(user) || ipBanned(ipOf(req)); if (b) throw new Error(banText(b));
      user.token = newToken(); saveUsers(); res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ token: user.token, ...pub(user) }));
    }
    if (url.pathname === '/profile' && req.method === 'GET') { const user = byToken(url.searchParams.get('token')); if (!user) throw new Error('Not signed in'); const b = activeBan(user); if (b) throw new Error(banText(b)); res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(pub(user))); }
    if (url.pathname === '/profile' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}'); const user = byToken(body.token); if (!user) throw new Error('Not signed in');
      const pr = body.profile || {}; const cur = user.profile;
      // the client may spend bits and change cosmetics; server keeps the authoritative bits from purchases via /claim
      user.profile = { ...cur, ...pr, bits: Math.max(0, Math.min(cur.bits + 5000, pr.bits | 0)) }; saveUsers();
      res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(pub(user)));
    }
    if (url.pathname === '/mod' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}'); const admin = byToken(body.token); if (!isAdmin(admin)) throw new Error('Admins only');
      const msg = modAction(admin, body); res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ok: true, msg }));
    }
    if (url.pathname === '/mod/list' && req.method === 'GET') {
      const admin = byToken(url.searchParams.get('token')); if (!isAdmin(admin)) throw new Error('Admins only');
      const banned = Object.values(users).filter(u => activeBan(u)).map(u => ({ name: u.name, ...u.ban })); const muted = Object.values(users).filter(u => activeMute(u)).map(u => ({ name: u.name, ...u.mute }));
      const online = [...rooms.values()].flatMap(r => r.players.map(p => ({ name: p.name, room: r.key }))); res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ banned, muted, online, reports: mod.reports.slice(-50).reverse(), users: Object.keys(users).length }));
    }
    if (url.pathname === '/mod/clearreports' && req.method === 'POST') { const body = JSON.parse((await readBody(req)).toString() || '{}'); if (!isAdmin(byToken(body.token))) throw new Error('Admins only'); mod.reports = []; saveMod(); return res.end('{"ok":true}'); }
    if (url.pathname === '/buy' && req.method === 'POST') {
      if (!stripe) throw new Error('Stripe not configured');
      const { bb, token } = JSON.parse((await readBody(req)).toString() || '{}');
      if (!PACKS[bb] || !token) throw new Error('bad pack');
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: PACKS[bb], product_data: { name: `${bb} Blockbux`, description: 'In-game currency for Blockverse', tax_code: 'txcd_10000000' } } }],
        managed_payments: { enabled: false },
        metadata: { bb: String(bb), token },
        success_url: `${SITE_URL}?paid=1&token=${encodeURIComponent(token)}`,
        cancel_url: `${SITE_URL}?paid=0`,
      });
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ url: session.url }));
    }
    if (url.pathname === '/stripe/webhook' && req.method === 'POST') {
      const raw = await readBody(req);
      const event = stripe.webhooks.constructEvent(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
      if (event.type === 'checkout.session.completed') {
        const s = event.data.object; const bb = +s.metadata.bb, token = s.metadata.token;
        balances.set(token, (balances.get(token) || 0) + bb);
        console.log('paid', bb, 'Blockbux for', token);
      }
      return res.end('ok');
    }
    if (url.pathname === '/claim') {   // game calls this after returning from Stripe; hands over unclaimed Blockbux once
      const token = url.searchParams.get('token'); const bb = balances.get(token) || 0; balances.delete(token);
      const user = byToken(token); if (user && bb > 0) { user.profile.bits += bb; saveUsers(); }
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ bb }));
    }
  } catch (e) { res.statusCode = 400; return res.end(JSON.stringify({ error: e.message })); }
  res.end(JSON.stringify({ ok: true, rooms: rooms.size, lobbies: lobbies.size, stripe: !!stripe }));
});
const wss = new WebSocketServer({ server });

let nextId = 1;
const lobbies = new Map();   // key map|mode -> {players:[], timer, startsAt}
const rooms = new Map();     // id -> room

const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
const bcast = (room, m, except) => room.players.forEach(p => { if (p !== except) send(p.ws, m); });

function lobbyKey(map, mode) { return `${map}|${mode}`; }

function joinLobby(p) {
  const key = lobbyKey(p.map, p.mode) + (p.nobots ? '|h' : '');
  if (p.nobots) {
    const open = [...rooms.values()].find(r => r.key === key && !r.over && r.players.length < 8);
    if (open) { p.room = open; p.team = 0; p.hp = PLAYER_HP; p.dead = false; open.players.push(p);
      const pub = open.players.map(q => ({ id: q.id, name: q.name, team: q.team, avatar: q.avatar }));
      send(p.ws, { t: 'start', room: open.id, you: p.id, team: 0, host: open.hostId, players: pub, bots: [], teams: [8], target: 0, ffa: false });
      bcast(open, { t: 'join', player: { id: p.id, name: p.name, team: 0, avatar: p.avatar } }, p); return; }
    const L = { key, players: [p], startsAt: Date.now(), timer: null }; p.lobby = L; startRoom(L); return;
  }
  let L = lobbies.get(key);
  if (!L) { L = { key, players: [], startsAt: Date.now() + WAIT_SECS * 1000, timer: null }; lobbies.set(key, L);
    L.timer = setTimeout(() => startRoom(L), WAIT_SECS * 1000); }
  L.players.push(p); p.lobby = L;
  const max = p.teams.reduce((a, b) => a + b, 0);
  L.players.forEach(q => send(q.ws, { t: 'wait', count: L.players.length, max, secs: Math.max(0, Math.round((L.startsAt - Date.now()) / 1000)) }));
  if (L.players.length >= max) { clearTimeout(L.timer); startRoom(L); }
}

function startRoom(L) {
  lobbies.delete(L.key);
  if (!L.players.length) return;
  const teams = L.players[0].teams, ffa = L.players[0].mode === 'ffa', target = L.players[0].target;
  const room = { id: 'r' + nextId++, key: L.key, players: [], bots: [], teams: teams.map(() => ({ score: 0, rounds: 0 })), target, ffa, over: false, roundOver: false, round: 1, hostId: null };
  // assign humans round-robin to teams (FFA: one team each)
  const sizes = teams.slice(); let humanIdx = 0;
  L.players.forEach((p, i) => {
    p.room = room; p.lobby = null; p.hp = PLAYER_HP; p.dead = false;
    if (ffa) { p.team = i; } else { let t = i % teams.length; let tries = 0; while (sizes[t] <= 0 && tries++ < teams.length) t = (t + 1) % teams.length; p.team = t; sizes[t]--; }
    room.players.push(p);
  });
  if (ffa) { for (let i = 0; i < L.players.length; i++) sizes[i] = 0; }
  // FFA: every entity is its own team; also give each bot its own team index
  if (ffa) { let t = L.players.length; const extra = []; sizes.forEach((n, i) => { for (let k = 0; k < n; k++) extra.push(t++); }); room.ffaBotTeams = extra; while (room.teams.length < t) room.teams.push({ score: 0, rounds: 0 }); }
  // bots fill the rest (unless this lobby asked for humans only)
  if (L.players[0].nobots) sizes.fill(0);
  let b = 0;
  if (ffa && !L.players[0].nobots) { room.ffaBotTeams.forEach(t => room.bots.push({ id: 'b' + (b++), team: t, hp: BOT_HP, dead: false })); } else sizes.forEach((n, t) => { for (let k = 0; k < n; k++) room.bots.push({ id: 'b' + (b++), team: t, hp: BOT_HP, dead: false }); });
  room.hostId = room.players[0].id;
  rooms.set(room.id, room);
  const pub = room.players.map(p => ({ id: p.id, name: p.name, team: p.team, avatar: p.avatar }));
  room.players.forEach(p => send(p.ws, { t: 'start', room: room.id, you: p.id, team: p.team, host: room.hostId, players: pub, bots: room.bots.map(x => ({ id: x.id, team: x.team })), teams: teams, target, ffa }));
}

function entity(room, id) { return room.players.find(p => p.id === id) || room.bots.find(b => b.id === id); }

const ROUNDS_TO_WIN = 6, MAX_ROUNDS = 11, ROUND_DELAY_MS = 2500;

function aliveTeams(room) {
  const alive = new Set();
  room.players.forEach(p => { if (!p.dead) alive.add(p.team); });
  room.bots.forEach(b => { if (!b.dead) alive.add(b.team); });
  return alive;
}

function applyHit(room, m, shooter) {
  if (room.over || room.roundOver) return;
  const tgt = entity(room, m.target); if (!tgt || tgt.dead) return;
  const self = tgt.id === shooter.id;
  if (!self && tgt.team === shooter.team && !room.ffa) return;
  const isBot = String(tgt.id).startsWith('b');
  tgt.hp -= isBot ? m.dmg : m.dmg * PLAYER_HIT;
  if (tgt.hp <= 0) {
    tgt.dead = true;
    if (!self) room.teams[shooter.team].score++;
    bcast(room, { t: 'ko', id: tgt.id, by: shooter.id, byTeam: shooter.team, scores: room.teams.map(t => t.score) });
    const alive = aliveTeams(room);
    if (alive.size <= 1) endRound(room, alive.size === 1 ? [...alive][0] : -1);
  } else {
    bcast(room, { t: 'hp', id: tgt.id, hp: tgt.hp });
  }
}

function endRound(room, winner) {
  room.roundOver = true;
  if (winner >= 0) room.teams[winner].rounds++;
  bcast(room, { t: 'round', winner, round: room.round, rounds: room.teams.map(t => t.rounds) });
  const won = room.teams.findIndex(t => t.rounds >= ROUNDS_TO_WIN);
  if (won >= 0 || room.round >= MAX_ROUNDS) {
    room.over = true;
    const best = Math.max(...room.teams.map(t => t.rounds));
    const w = won >= 0 ? won : room.teams.findIndex(t => t.rounds === best);
    setTimeout(() => { if (rooms.has(room.id)) bcast(room, { t: 'end', winner: w, rounds: room.teams.map(t => t.rounds), scores: room.teams.map(t => t.score) }); }, ROUND_DELAY_MS);
    setTimeout(() => closeRoom(room), ROUND_DELAY_MS + 15000);
    return;
  }
  setTimeout(() => {
    if (!rooms.has(room.id)) return;
    room.round++; room.roundOver = false;
    room.players.forEach(p => { p.dead = false; p.hp = PLAYER_HP; });
    room.bots.forEach(b => { b.dead = false; b.hp = BOT_HP; });
    bcast(room, { t: 'newround', round: room.round });
  }, ROUND_DELAY_MS);
}

function closeRoom(room) { rooms.delete(room.id); room.players.forEach(p => { p.room = null; }); }

function leave(p) {
  if (p.lobby) { p.lobby.players = p.lobby.players.filter(q => q !== p); if (!p.lobby.players.length) { clearTimeout(p.lobby.timer); lobbies.delete(p.lobby.key); } p.lobby = null; }
  if (p.room) { const room = p.room; room.players = room.players.filter(q => q !== p); p.room = null;
    if (!room.players.length) return rooms.delete(room.id);
    // the leaver's slot becomes a bot so teams stay even
    let bot = null; if (!p.nobots) { bot = { id: 'b' + Date.now() % 100000, team: p.team, hp: BOT_HP, dead: !!p.dead }; room.bots.push(bot); }
    if (room.hostId === p.id) room.hostId = room.players[0].id;
    bcast(room, { t: 'leave', id: p.id, bot: bot ? { id: bot.id, team: bot.team } : null, host: room.hostId });
  }
}

wss.on('connection', (ws, req) => {
  const p = { id: 'p' + nextId++, ws, name: 'Player', avatar: null, room: null, lobby: null, team: 0, ip: ipOf(req), user: null };
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'join') { leave(p); const acctUser = m.token ? byToken(m.token) : null; p.user = acctUser; const b = activeBan(acctUser) || ipBanned(p.ip); if (b) { send(ws, { t: 'kicked', reason: banText(b) }); try { ws.close(); } catch {} return; } p.name = acctUser ? acctUser.name : ('Guest' + String(m.name || '').replace(/\D/g, '').slice(0, 4)); if (!acctUser && !/^Guest\d/.test(p.name)) p.name = 'Guest' + Math.floor(100 + Math.random() * 900); p.avatar = m.avatar; p.map = String(m.map); p.mode = String(m.mode); p.teams = Array.isArray(m.teams) ? m.teams.map(n => Math.max(1, Math.min(5, n | 0))).slice(0, 6) : [1, 1]; p.target = Math.max(5, Math.min(50, m.target | 0)) || 15; p.nobots = !!m.nobots; joinLobby(p); return; }
    const room = p.room; if (!room) return;
    if (m.t === 'state') { bcast(room, { t: 'state', id: p.id, p: m.p, yaw: m.yaw, slot: m.slot, sc: m.sc, sl: m.sl }, p); return; }
    if (m.t === 'bots' && p.id === room.hostId) { bcast(room, { t: 'bots', b: m.b }, p); return; }
    if (m.t === 'shot') { bcast(room, { t: 'shot', from: m.from, to: m.to, c: m.c }, p); return; }
    if (m.t === 'hit') { let shooter = p; if (m.by && String(m.by).startsWith('b') && p.id === room.hostId) { shooter = entity(room, m.by) || p; } applyHit(room, m, shooter); return; }
    if (m.t === 'bomb') { bcast(room, { t: 'bomb', from: m.from, dir: m.dir }, p); return; }
    if (m.t === 'ev' && m.d && m.d.k === 'chat') {
      let text = String(m.d.text || '').slice(0, 140); const t = text.trim();
      if (t.startsWith('/')) { const [cmd, who, ...rest] = t.slice(1).split(/\s+/); const minutes = /^\d+$/.test(rest[0] || '') ? +rest.shift() : 0; const reason = rest.join(' ');
        try {
          if (cmd === 'report') { if (!who) throw new Error('Usage: /report name reason'); mod.reports.push({ by: p.name, user: who, reason, at: Date.now(), room: room.key }); saveMod(); return send(ws, { t: 'sys', text: `Reported ${who}. Thanks — a moderator will take a look.` }); }
          if (['ban','unban','mute','unmute','kick'].includes(cmd)) { if (!isAdmin(p.user)) throw new Error('Admins only'); const msg = modAction(p.user, { action: cmd, user: who, minutes, reason }); bcast(room, { t: 'sys', text: `[Moderator] ${msg}` }); return; }
          if (cmd === 'help') return send(ws, { t: 'sys', text: 'Commands: /report name reason' + (isAdmin(p.user) ? ' · /ban name [minutes] reason · /unban name · /mute name [minutes] · /unmute name · /kick name reason' : '') });
          throw new Error('Unknown command. Try /help');
        } catch (e) { return send(ws, { t: 'sys', text: e.message }); } }
      const mute = activeMute(p.user); if (mute) return send(ws, { t: 'sys', text: `You're muted until ${new Date(mute.until).toLocaleTimeString()}${mute.reason ? ' (' + mute.reason + ')' : ''}` });
      if (hasBadWord(text)) { const r = strike(p.user, p.ip); if (r === 'ban') { kickPlayer(p, 'Banned for 1 hour: repeated inappropriate language'); return; } send(ws, { t: 'sys', text: r === 'mute' ? 'Muted for 10 minutes: inappropriate language.' : 'Warning: keep it clean. Repeated bad language leads to a mute, then a ban.' }); if (r !== 'warn') return; text = text.replace(/\S+/g, w => hasBadWord(w) ? '*'.repeat(w.length) : w); }
      bcast(room, { t: 'ev', from: p.id, d: { k: 'chat', text } }, p); return; }
    if (m.t === 'ev') { bcast(room, { t: 'ev', from: p.id, d: m.d }, p); return; }
    if (m.t === 'leave') { leave(p); return; }
  });
  ws.on('close', () => leave(p));
});

server.listen(PORT, () => console.log('Blockverse server on :' + PORT));
