// Bumper Arena — authoritative 2v2 bumper-car hockey server.
// Serves the client from ./public and runs the physics over WebSockets.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8790;
const TICK_HZ = 30;
const SUBSTEPS = 2;
const DT = 1 / TICK_HZ / SUBSTEPS;

// Rink: x is the long axis (-L..L), z the short one (-W..W). Team 0 attacks +x, team 1 attacks -x.
const CFG = {
  L: 26, W: 15, CR: 6,        // half length, half width, corner radius
  GW: 4.6, GD: 3,             // goal half-width and depth
  PR: 1.3, BR: 0.85,          // player and ball radius
  BUMPERS: [[0, 7.6], [0, -7.6]], BUMPER_R: 1.4,
  MATCH_S: Number(process.env.MATCH_S) || 180, DASH_CD: 2.2, // match length in seconds; a tie goes to golden goal
};
const { L, W, CR, GW, GD, PR, BR, BUMPER_R } = CFG;
const ACCEL = 32, DRAG = 1.5, BALL_DRAG = 0.6, BALL_MAX = 38;
const DASH_IMPULSE = 16, DASH_TIME = 0.28;
const TURN = 4.8, GRIP = 2.2; // steering rate (rad/s) and sideways grip for human-driven cars
const P_MASS = 3, B_MASS = 1;
const COUNTDOWN_MS = 3000, GOAL_MS = 2600, OVER_MS = 7000;
const BOT_NAMES = ['Bolt', 'Dynamo', 'Pinball', 'Ricochet', 'Zap', 'Comet', 'Tumble', 'Wobble'];
const SPAWNS = [[-7, -3.5], [-16, 3.5]]; // for team 0; mirrored on x for team 1
const SOLO_SPAWN = [-9, 0];             // 1v1 rooms

// ---------- static files ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
};
const PUBLIC_DIR = path.join(__dirname, 'public');
const THREE_DIR = path.join(__dirname, 'node_modules', 'three');

// The client is bundled into one plain script (three.js included) so it also runs in browsers
// without import-map support, and loads in a single request. Rebuilt whenever main.js changes.
let bundle = { mtime: 0, data: null };
function clientBundle() {
  const entry = path.join(PUBLIC_DIR, 'main.js');
  try {
    const mtime = fs.statSync(entry).mtimeMs;
    if (mtime !== bundle.mtime) {
      const out = require('esbuild').buildSync({
        entryPoints: [entry], bundle: true, format: 'iife', minify: true, target: ['es2019'], write: false, logLevel: 'silent',
      });
      bundle = { mtime, data: Buffer.from(out.outputFiles[0].contents) };
    }
    return bundle.data;
  } catch (err) {
    console.warn('Client bundle failed, falling back to module loading:', err.message);
    return Buffer.from("import('/main.js');");
  }
}
clientBundle();

const server = http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { res.writeHead(400).end(); return; }
  if (urlPath === '/game.js') {
    res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache' });
    res.end(clientBundle());
    return;
  }
  if (urlPath === '/api/room') { // lets the join screen say whose game a link leads to before joining
    const name = cleanRoom(new URL(req.url, 'http://x').searchParams.get('room'));
    const room = rooms.get(name);
    const body = room
      ? { exists: true, size: room.size, humans: humans(room).map(p => p.name), spectators: room.spectators.size }
      : { exists: false };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
    return;
  }
  let root = PUBLIC_DIR;
  if (urlPath.startsWith('/vendor/three/')) { root = THREE_DIR; urlPath = urlPath.slice('/vendor/three'.length); }
  if (urlPath === '/' || urlPath === '/index.html') {
    // fill in this site's own address for the link-preview tags
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
    const origin = `${proto}://${String(req.headers.host || '').replace(/[^\w.:\-]/g, '')}`;
    fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8', (err, html) => {
      if (err) { res.writeHead(500).end(); return; }
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      res.end(html.split('__ORIGIN__').join(origin));
    });
    return;
  }
  const file = path.normalize(path.join(root, urlPath));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': root === THREE_DIR ? 'public, max-age=86400' : 'no-cache',
    });
    res.end(data);
  });
});

function cleanRoom(raw) {
  return String(raw || 'lobby').toLowerCase().replace(/[^a-z0-9\-_]/g, '').slice(0, 24) || 'lobby';
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) return ni.address;
  }
  return null;
}

// ---------- rooms ----------
const rooms = new Map();
let nextId = 1;

function makePlayer(room, team, slot, bot, name, ws) {
  const p = {
    id: nextId++, team, slot, bot, name, ws,
    x: 0, z: 0, vx: 0, vz: 0, ix: 0, iz: 0, h: 0,
    dashCd: 0, dashT: 0, wantDash: false, goals: 0, think: 0, m: P_MASS, r: PR,
    solo: room.size === 1,
  };
  placeAtSpawn(p);
  room.players.push(p);
  return p;
}

function placeAtSpawn(p) {
  const [sx, sz] = p.solo ? SOLO_SPAWN : SPAWNS[p.slot];
  const s = p.team === 0 ? 1 : -1;
  p.x = sx * s; p.z = sz * s; p.vx = 0; p.vz = 0; p.dashT = 0; p.dashCd = 0;
  p.h = p.team === 0 ? 0 : Math.PI; // face the goal you attack
}

function botName(room) {
  const used = new Set(room.players.map(p => p.name));
  const free = BOT_NAMES.filter(n => !used.has(n));
  return free[Math.floor(Math.random() * free.length)] || 'Bot';
}

function getRoom(name, size) {
  let room = rooms.get(name);
  if (!room) {
    room = {
      name, size: size === 1 ? 1 : 2, diff: 2, players: [], spectators: new Set(),
      ball: { x: 0, z: 0, vx: 0, vz: 0, m: B_MASS, r: BR },
      score: [0, 0], state: 'countdown', until: Date.now() + COUNTDOWN_MS,
      lastTouch: null, events: [], winner: -1,
      len: CFG.MATCH_S * 1000, timeLeft: CFG.MATCH_S * 1000, golden: false, order: [], paused: null,
    };
    for (let team = 0; team < 2; team++)
      for (let slot = 0; slot < room.size; slot++) makePlayer(room, team, slot, true, botName(room), null);
    rooms.set(name, room);
  }
  return room;
}

function humans(room) { return room.players.filter(p => !p.bot); }

function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj) {
  const msg = JSON.stringify(obj);
  for (const p of room.players) if (p.ws && p.ws.readyState === 1) p.ws.send(msg);
  for (const ws of room.spectators) if (ws.readyState === 1) ws.send(msg);
}
function sendRoster(room) {
  broadcast(room, {
    t: 'roster',
    players: room.players.map(p => ({ id: p.id, name: p.name, team: p.team, slot: p.slot, bot: p.bot, goals: p.goals })),
    spectators: room.spectators.size, size: room.size, mins: Math.round(room.len / 6000) / 10, diff: room.diff,
    host: room.order[0] && room.order[0].player ? room.order[0].player.id : -1,
    hostName: room.order[0] ? room.order[0].pname : '',
  });
}

function kickoff(room) {
  for (const p of room.players) placeAtSpawn(p);
  Object.assign(room.ball, { x: 0, z: 0, vx: 0, vz: 0 });
  room.lastTouch = null;
  room.state = 'countdown';
  room.until = Date.now() + COUNTDOWN_MS;
}

// Put a connected person into a free seat (replacing a bot), or make them a spectator if the game is full.
function seat(room, ws) {
  const count = [0, 1].map(t => room.players.filter(p => p.team === t && !p.bot).length);
  const team = count[0] <= count[1] ? 0 : 1;
  const s = room.players.find(p => p.team === team && p.bot) || room.players.find(p => p.bot);
  if (!s) {
    ws.player = null; room.spectators.add(ws);
    send(ws, { t: 'welcome', id: -1, cfg: CFG, room: room.name, size: room.size });
    return;
  }
  room.spectators.delete(ws);
  s.bot = false; s.ws = ws; s.name = ws.pname; s.goals = 0; s.ix = s.iz = 0;
  ws.player = s;
  send(ws, { t: 'welcome', id: s.id, cfg: CFG, room: room.name, size: room.size });
}

function joinRoom(room, ws, rawName) {
  ws.pname = String(rawName || '').replace(/[^\w \-.!?']/g, '').trim().slice(0, 14) || 'Player';
  const fresh = humans(room).length === 0;
  room.order.push(ws); // join order: the first one still here is the host
  seat(room, ws);
  if (fresh && ws.player) { resetMatch(room); kickoff(room); }
  sendRoster(room);
}

function leaveRoom(room, ws) {
  room.order = room.order.filter(w => w !== ws);
  room.spectators.delete(ws);
  const player = ws.player;
  if (player && player.ws === ws) {
    player.bot = true; player.ws = null; player.ix = player.iz = 0;
    player.name = botName(room);
  }
  ws.player = null;
  if (room.order.length === 0) rooms.delete(room.name);
  else sendRoster(room);
}

function setPause(room, on, by) {
  const now = Date.now();
  if (on && !room.paused) room.paused = { at: now, by };
  else if (!on && room.paused) { room.until += now - room.paused.at; room.paused = null; }
}

// Host only: restart with (possibly) a different team size and goal target.
function resetMatch(room) {
  room.score = [0, 0]; room.winner = -1; room.timeLeft = room.len; room.golden = false;
  for (const p of room.players) p.goals = 0;
}

function newMatch(room, size, mins, diff) {
  room.len = mins * 60000; room.diff = diff;
  if (size !== room.size) {
    room.size = size; room.players = []; room.spectators = new Set();
    for (let team = 0; team < 2; team++)
      for (let slot = 0; slot < size; slot++) makePlayer(room, team, slot, true, botName(room), null);
    for (const ws of room.order) seat(room, ws);
  }
  resetMatch(room); room.paused = null;
  kickoff(room);
  room.events.push(['new', size, mins, diff]);
  sendRoster(room);
}

// ---------- physics ----------
function wallBounce(room, b, isBall) {
  const r = b.r, rest = isBall ? 0.97 : 0.45;
  const ax = Math.abs(b.x), az = Math.abs(b.z);
  let hit = 0;
  // goal mouth and net (ball only)
  if (isBall && az < GW - r * 0.4 && ax > L - r) {
    if (ax > L) {
      if (az > GW - r) { b.z = Math.sign(b.z) * (GW - r); b.vz *= -0.4; }
      if (ax > L + GD - r) { b.x = Math.sign(b.x) * (L + GD - r); b.vx *= -0.3; }
    }
    return;
  }
  if (ax > L - CR && az > W - CR) {
    // rounded corner
    const cx = Math.sign(b.x) * (L - CR), cz = Math.sign(b.z) * (W - CR);
    const dx = b.x - cx, dz = b.z - cz, d = Math.hypot(dx, dz);
    if (d > CR - r) {
      const nx = dx / d, nz = dz / d;
      b.x = cx + nx * (CR - r); b.z = cz + nz * (CR - r);
      const vn = b.vx * nx + b.vz * nz;
      if (vn > 0) { b.vx -= (1 + rest) * vn * nx; b.vz -= (1 + rest) * vn * nz; hit = vn; }
    }
  } else {
    if (az > W - r) { b.z = Math.sign(b.z) * (W - r); if (b.vz * b.z > 0) { hit = Math.abs(b.vz); b.vz *= -rest; } }
    if (ax > L - r) { b.x = Math.sign(b.x) * (L - r); if (b.vx * b.x > 0) { hit = Math.max(hit, Math.abs(b.vx)); b.vx *= -rest; } }
  }
  if (isBall && hit > 7) room.events.push(['wall', +b.x.toFixed(1), +b.z.toFixed(1), Math.round(hit)]);
}

function bumperBounce(room, b, isBall) {
  for (let i = 0; i < CFG.BUMPERS.length; i++) {
    const [bx, bz] = CFG.BUMPERS[i];
    const dx = b.x - bx, dz = b.z - bz, d = Math.hypot(dx, dz), min = BUMPER_R + b.r;
    if (d >= min || d === 0) continue;
    const nx = dx / d, nz = dz / d;
    b.x = bx + nx * min; b.z = bz + nz * min;
    const vn = b.vx * nx + b.vz * nz;
    if (vn < 0) {
      const kick = isBall ? 9 : 5;
      b.vx -= 2 * vn * nx; b.vz -= 2 * vn * nz;
      b.vx += nx * kick; b.vz += nz * kick;
      room.events.push(['bump', i]);
    }
  }
}

function collide(room, a, b, bIsBall) {
  const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz), min = a.r + b.r;
  if (d >= min || d === 0) return;
  const nx = dx / d, nz = dz / d;
  const ma = a.m * (a.dashT > 0 ? 2.5 : 1), mb = b.m * (b.dashT > 0 ? 2.5 : 1);
  const overlap = min - d, tot = ma + mb;
  a.x -= nx * overlap * (mb / tot); a.z -= nz * overlap * (mb / tot);
  b.x += nx * overlap * (ma / tot); b.z += nz * overlap * (ma / tot);
  const rel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
  if (rel >= 0) return;
  // gentle touches barely bounce the puck (so it can be dribbled); hard hits and dashes still send it flying
  const e = !bIsBall ? 0.95 : a.dashT > 0 ? 0.9 : clamp(0.15 + (-rel - 7) * 0.06, 0.15, 0.85);
  const j = -(1 + e) * rel / (1 / ma + 1 / mb);
  a.vx -= j / ma * nx; a.vz -= j / ma * nz;
  b.vx += j / mb * nx; b.vz += j / mb * nz;
  if (bIsBall) {
    room.lastTouch = a.id;
    if (-rel > 3) room.events.push(['kick', +b.x.toFixed(1), +b.z.toFixed(1), Math.round(-rel)]);
  } else if (-rel > 4) {
    room.events.push(['hit', +((a.x + b.x) / 2).toFixed(1), +((a.z + b.z) / 2).toFixed(1), Math.round(-rel)]);
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Bot difficulty: 1 easy, 2 normal, 3 hard. skill = share of a person's acceleration, think = ticks between decisions,
// look = how far ahead (s) they read the puck, dash = chance per decision to dash when lined up, top = top speed they aim for.
const BOT_LEVELS = {
  1: { skill: 0.42, think: 8, look: 0.1, dash: 0.02, top: 15 },
  2: { skill: 0.6, think: 5, look: 0.22, dash: 0.08, top: 21 },
  3: { skill: 0.9, think: 3, look: 0.3, dash: 0.22, top: 26 },
};
function botThink(room, p) {
  const lv = BOT_LEVELS[room.diff] || BOT_LEVELS[2];
  const dir = p.team === 0 ? 1 : -1;
  const b = room.ball;
  const px = clamp(b.x + b.vx * lv.look, -L, L), pz = clamp(b.z + b.vz * lv.look, -W, W);
  const mate = room.players.find(q => q.team === p.team && q !== p);
  const myD = Math.hypot(px - p.x, pz - p.z);
  let attack;
  if (!mate) attack = true;
  else if (!mate.bot) attack = px * dir < -3 || myD < 6; // support a human: guard, clear when it's in our half
  else {
    const mateD = Math.hypot(px - mate.x, pz - mate.z);
    attack = myD < mateD || (myD === mateD && p.id < mate.id);
    if (!attack && px * dir < -L * 0.45 && myD < 7) attack = true;
  }
  let tx, tz, dash = false;
  if (attack) {
    const gx = dir * L, gz = clamp(pz * 0.25, -GW * 0.6, GW * 0.6);
    let dx = gx - px, dz = gz - pz; const n = Math.hypot(dx, dz) || 1; dx /= n; dz /= n;
    const align = ((px - p.x) * dx + (pz - p.z) * dz) / (myD || 1);
    if (align > 0.7) {
      tx = px + dx * 2.5; tz = pz + dz * 2.5;
      if (myD < 5.5 && p.dashCd <= 0 && Math.random() < lv.dash) dash = true;
    } else {
      const off = PR + BR + 0.8;
      tx = px - dx * off; tz = pz - dz * off;
      if (align < 0.1 && myD < 4.5) tz += (p.z >= pz ? 1 : -1) * 3.2; // swing around instead of pushing it backwards
    }
  } else {
    tx = -dir * L * 0.6; tz = clamp(pz * 0.6, -GW - 1, GW + 1);
  }
  tx = clamp(tx, -L + PR, L - PR); tz = clamp(tz, -W + PR, W - PR);
  const ex = tx - p.x, ez = tz - p.z, d = Math.hypot(ex, ez);
  if (d < 0.4) { p.ix = p.iz = 0; return; }
  const want = Math.min(lv.top, d * 4);
  let sx = ex / d * want - p.vx, sz = ez / d * want - p.vz;
  const sn = Math.hypot(sx, sz) || 1;
  p.ix = sx / sn * lv.skill; p.iz = sz / sn * lv.skill;
  if (dash) p.wantDash = true;
}

function stepRoom(room, now) {
  const playing = room.state === 'play' || room.state === 'goal' || room.state === 'over';
  if (room.state === 'countdown' && now >= room.until) { room.state = 'play'; room.events.push(['go']); }
  else if (room.state === 'goal' && now >= room.until) kickoff(room);
  else if (room.state === 'over' && now >= room.until) {
    resetMatch(room);
    kickoff(room); sendRoster(room);
  }
  if (!playing) return;

  // match clock: runs only while the puck is live
  if (room.state === 'play' && !room.golden) {
    room.timeLeft -= 1000 / TICK_HZ;
    if (room.timeLeft <= 0) {
      room.timeLeft = 0;
      if (room.score[0] !== room.score[1]) {
        room.winner = room.score[0] > room.score[1] ? 0 : 1;
        room.state = 'over'; room.until = now + OVER_MS;
        room.events.push(['time', room.winner]);
      } else { room.golden = true; room.events.push(['golden']); }
    }
  }

  for (const p of room.players) {
    if (p.bot && --p.think <= 0) { p.think = (BOT_LEVELS[room.diff] || BOT_LEVELS[2]).think; botThink(room, p); }
  }
  const b = room.ball;
  for (let s = 0; s < SUBSTEPS; s++) {
    for (const p of room.players) {
      if (p.bot || p.abs) {
        // bots and touch-stick players push in any direction on the rink; the car turns to face that way
        let ix = p.ix, iz = p.iz; const n = Math.hypot(ix, iz);
        if (n > 1) { ix /= n; iz /= n; }
        if (p.wantDash) {
          p.wantDash = false;
          const dx = n > 0.1 ? ix / n : Math.cos(p.h), dz = n > 0.1 ? iz / n : Math.sin(p.h);
          if (p.dashCd <= 0 && (n > 0.1 || !p.bot)) {
            p.vx += dx * DASH_IMPULSE; p.vz += dz * DASH_IMPULSE;
            p.dashCd = CFG.DASH_CD; p.dashT = DASH_TIME;
            room.events.push(['dash', p.id]);
          }
        }
        p.vx += ix * ACCEL * DT; p.vz += iz * ACCEL * DT;
        const steerByStick = !p.bot && n > 0.2;
        if (steerByStick || Math.hypot(p.vx, p.vz) > 0.8) {
          let da = (steerByStick ? Math.atan2(iz, ix) : Math.atan2(p.vz, p.vx)) - p.h;
          da = Math.atan2(Math.sin(da), Math.cos(da));
          p.h += da * (1 - Math.exp(-12 * DT));
        }
      } else {
        // humans drive the car: left/right steer, up accelerates, down reverses
        const thr = -p.iz, steer = p.ix; // left always turns the car left, also in reverse
        p.h += steer * TURN * DT;
        const fx = Math.cos(p.h), fz = Math.sin(p.h);
        if (p.wantDash) {
          p.wantDash = false;
          if (p.dashCd <= 0) {
            p.vx += fx * DASH_IMPULSE; p.vz += fz * DASH_IMPULSE;
            p.dashCd = CFG.DASH_CD; p.dashT = DASH_TIME;
            room.events.push(['dash', p.id]);
          }
        }
        const a = thr * ACCEL * (thr < 0 ? 0.65 : 1) * DT;
        p.vx += fx * a; p.vz += fz * a;
        // a little sideways grip so the car goes where it points, while still sliding on the ice
        const lat = -p.vx * fz + p.vz * fx, kill = lat * (1 - Math.exp(-GRIP * DT));
        p.vx += fz * kill; p.vz -= fx * kill;
      }
      const k = Math.exp(-DRAG * DT);
      p.vx *= k; p.vz *= k;
      p.x += p.vx * DT; p.z += p.vz * DT;
      if (p.dashCd > 0) p.dashCd -= DT;
      if (p.dashT > 0) p.dashT -= DT;
    }
    const kb = Math.exp(-BALL_DRAG * DT);
    b.vx *= kb; b.vz *= kb;
    const sp = Math.hypot(b.vx, b.vz);
    if (sp > BALL_MAX) { b.vx *= BALL_MAX / sp; b.vz *= BALL_MAX / sp; }
    b.x += b.vx * DT; b.z += b.vz * DT;

    const ps = room.players;
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) collide(room, ps[i], ps[j], false);
      collide(room, ps[i], b, true);
    }
    for (const p of ps) { bumperBounce(room, p, false); wallBounce(room, p, false); }
    bumperBounce(room, b, true); wallBounce(room, b, true);

    if (room.state === 'play' && Math.abs(b.x) > L + BR * 0.5) {
      const team = b.x > 0 ? 0 : 1;
      room.score[team]++;
      const toucher = room.players.find(p => p.id === room.lastTouch);
      let who = '';
      if (toucher) {
        if (toucher.team === team) { toucher.goals++; who = toucher.name; }
        else who = toucher.name + ' (own goal)';
      }
      if (room.golden) { // golden goal: first goal of extra time wins
        room.state = 'over'; room.winner = team; room.until = now + OVER_MS;
      } else { room.state = 'goal'; room.until = now + GOAL_MS; }
      room.events.push(['goal', team, who]);
      sendRoster(room);
    }
  }
}

function snapshot(room, now) {
  const r2 = v => Math.round(v * 100) / 100;
  const b = room.ball;
  const msg = {
    t: 's', st: room.state, cd: Math.max(0, room.until - (room.paused ? room.paused.at : now)), sc: room.score, w: room.winner,
    pz: room.paused ? room.paused.by : 0, tl: Math.ceil(room.timeLeft / 1000), gg: room.golden ? 1 : 0,
    b: [r2(b.x), r2(b.z), r2(b.vx), r2(b.vz)],
    p: room.players.map(p => [p.id, r2(p.x), r2(p.z), r2(p.vx), r2(p.vz), Math.max(0, r2(p.dashCd)), p.dashT > 0 ? 1 : 0, r2(p.h)]),
  };
  if (room.events.length) { msg.e = room.events; room.events = []; }
  return msg;
}

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!room.paused) stepRoom(room, now);
    broadcast(room, snapshot(room, now));
  }
}, 1000 / TICK_HZ);

// ---------- sockets ----------
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  let roomName = 'lobby';
  try {
    roomName = cleanRoom(new URL(req.url, 'http://x').searchParams.get('room'));
  } catch { /* keep default */ }
  let room = null;
  ws.on('message', data => {
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const player = ws.player;
    if (m.t === 'join' && !room) {
      room = getRoom(roomName, Number(m.size)); // the first player into a room sets 1v1 or 2v2
      joinRoom(room, ws, m.name);
    } else if (!room) {
      return;
    } else if (m.t === 'in' && player && !player.bot) {
      player.ix = clamp(Number(m.x) || 0, -1, 1);
      player.iz = clamp(Number(m.z) || 0, -1, 1);
      player.abs = !!m.a; // touch stick: x/z are a direction on the rink, not steer/throttle
      if (m.d && !room.paused) player.wantDash = true;
    } else if (m.t === 'pause') {
      setPause(room, !!m.on, ws.pname);
    } else if (m.t === 'new' && room.order[0] === ws) {
      const size = Number(m.size) === 1 ? 1 : 2;
      const mins = clamp(Math.round(Number(m.mins)) || 3, 1, 10);
      const diff = clamp(Math.round(Number(m.diff)) || room.diff, 1, 3);
      newMatch(room, size, mins, diff);
    }
  });
  const bye = () => { if (room) { leaveRoom(room, ws); room = null; } };
  ws.on('close', bye);
  ws.on('error', bye);
});

// Hosted platforms (Render sets RENDER=true) route traffic over IPv4, so bind to it explicitly there.
const HOST = process.env.HOST || (process.env.RENDER ? '0.0.0.0' : undefined);
server.listen(PORT, HOST, () => {
  const lan = lanAddress();
  console.log(`Bumper Arena running:\n  local  http://localhost:${PORT}` + (lan ? `\n  LAN    http://${lan}:${PORT}` : ''));
});
