'use strict';
/**
 * 《璀璨宝石：宝可梦》联机服务器
 * 零依赖 Node HTTP 服务器：静态资源 + 房间 API + SSE 实时状态推送 + bot 托管
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('./engine');
const { botAction } = require('./bot');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const rooms = new Map();          // code -> room
const sseClients = new Set();     // {res, code, token}

function tok() { return crypto.randomBytes(12).toString('hex'); }

/* ---------------- 阵营 ---------------- */
const FACTIONS = ['ash', 'brock', 'rocket', 'misty'];
const FACTION_BOT_NAMES = { ash: 'Bot·小智', brock: 'Bot·小刚', rocket: 'Bot·火箭队', misty: 'Bot·小霞' };
function pickFreeFaction(room) {
  const used = new Set(room.seats.map(s => s.faction).filter(Boolean));
  const free = FACTIONS.filter(f => !used.has(f));
  return free.length ? free[Math.floor(Math.random() * free.length)] : FACTIONS[Math.floor(Math.random() * FACTIONS.length)];
}
function roomCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 4 }, () => abc[Math.floor(Math.random() * abc.length)]).join(''); } while (rooms.has(c));
  return c;
}

/** 校验房主指定的位次：必须是 0..n-1 的一个排列 */
function normalizeOrder(o, n) {
  if (!Array.isArray(o) || o.length !== n) return null;
  const arr = o.map(Number);
  if (arr.some(x => !Number.isInteger(x) || x < 0 || x >= n)) return null;
  if (new Set(arr).size !== n) return null;
  return arr;
}

/** 开局换位：随机打乱 seat 索引，决定行动顺序（先手 = 第一位） */
const INTRO_MS = 3400;   // 客户端「决定先后手」动画时长，期间 Bot 不出手
function randomOrder(n) {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = crypto.randomInt ? crypto.randomInt(i + 1) : Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function newRoom(hostName, faction) {
  const code = roomCode();
  const room = {
    code,
    createdAt: Date.now(),
    phase: 'lobby',             // lobby | playing
    hostSeat: 0,
    seats: [{ name: hostName, token: tok(), isBot: false, connected: true, faction }],
    game: null,
    botTimer: null,
  };
  rooms.set(code, room);
  return room;
}

function roomInfo(room) {
  return {
    code: room.code,
    phase: room.phase,
    hostSeat: room.hostSeat,
    orderMode: room.orderMode || 'random',
    seats: room.seats.map(s => ({ name: s.name, isBot: s.isBot, connected: s.connected, faction: s.faction || null })),
  };
}

function broadcast(room) {
  const info = roomInfo(room);
  for (const cli of sseClients) {
    if (cli.code !== room.code) continue;
    const seat = seatByToken(room, cli.token);
    let payload;
    if (room.phase === 'lobby' || !room.game) {
      payload = { type: 'state', ...info, game: null };
    } else {
      payload = { type: 'state', ...info, game: E.sanitize(room.game, seat === null ? -1 : seat, { orderMode: room.orderMode || 'random' }) };
    }
    sendSSE(cli, payload);
  }
}

function sendSSE(cli, obj) {
  try { cli.res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) { /* ignore */ }
}

function seatByToken(room, token) {
  const i = room.seats.findIndex(s => s.token === token);
  return i;
}

/* ---------------- Bot 调度 ---------------- */
function scheduleBot(room) {
  if (!room.game || room.game.phase !== 'playing') return;
  const g = room.game;
  const p = g.players[g.turn];
  if (!p || !p.isBot) return;
  clearTimeout(room.botTimer);
  // 开局换位动画期间 Bot 先不动，等动画结束再出手
  const wait = Math.max(900, (room.introUntil || 0) - Date.now() + 250);
  room.botTimer = setTimeout(() => {
    try {
      const gg = room.game;
      if (!gg || gg.phase !== 'playing') return;
      const cur = gg.players[gg.turn];
      if (!cur || !cur.isBot) return;
      const action = botAction(gg, gg.turn);
      const r = E.applyAction(gg, gg.turn, action);
      if (!r.ok) {
        // bot 动作被拒：记录并跳过进化兜底，避免卡死
        E.addLog(gg, `BOT 动作被拒(${r.error})，尝试兜底`);
        if (gg.awaiting && gg.awaiting.type === 'evolve') E.applyAction(gg, gg.turn, { type: 'skipEvolve' });
        else if (gg.awaiting && gg.awaiting.type === 'discard') {
          // 强制归还
          const colors = Object.keys(cur.tokens).filter(c => cur.tokens[c] > 0);
          cur.tokens[colors[0]]--; gg.supply[colors[0]]++;
          if (E.tokenCount(cur) <= E.TOKEN_LIMIT) E.applyAction(gg, gg.turn, { type: 'skipEvolve' });
        }
      }
      broadcast(room);
      scheduleBot(room); // bot 连续行动（弃球/进化/下一位也是 bot）
    } catch (e) {
      console.error('bot error', e);
    }
  }, wait);
}

/* ---------------- API 处理 ---------------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', d => { data += d; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const route = url.pathname;
  const body = await readBody(req).catch(() => ({}));

  if (route === '/api/room/create' && req.method === 'POST') {
    const name = String(body.name || '').trim().slice(0, 12) || '训练家';
    const faction = FACTIONS.includes(body.faction) ? body.faction : FACTIONS[0];
    const room = newRoom(name, faction);
    return json(res, 200, { code: room.code, token: room.seats[0].token, seat: 0 });
  }

  if (route === '/api/room/join' && req.method === 'POST') {
    const room = rooms.get(String(body.code || '').toUpperCase());
    if (!room) return json(res, 404, { error: '房间不存在' });
    const name = String(body.name || '').trim().slice(0, 12) || '训练家';
    if (room.phase !== 'lobby') return json(res, 400, { error: '游戏已开始，无法加入' });
    if (room.seats.length >= 4) return json(res, 400, { error: '房间已满（最多 4 人）' });
    if (room.seats.some(s => s.name === name)) return json(res, 400, { error: '该昵称已被使用' });
    const old = room.seats.findIndex(s => s.token === body.token);
    if (old >= 0) return json(res, 200, { code: room.code, token: body.token, seat: old });
    const faction = FACTIONS.includes(body.faction) ? body.faction : pickFreeFaction(room);
    room.seats.push({ name, token: tok(), isBot: false, connected: true, faction });
    broadcast(room);
    return json(res, 200, { code: room.code, token: room.seats[room.seats.length - 1].token, seat: room.seats.length - 1 });
  }

  if (route === '/api/room/addBot' && req.method === 'POST') {
    const room = rooms.get(String(body.code || '').toUpperCase());
    if (!room) return json(res, 404, { error: '房间不存在' });
    if (seatByToken(room, body.token) !== room.hostSeat) return json(res, 403, { error: '只有房主可以操作' });
    if (room.phase !== 'lobby') return json(res, 400, { error: '游戏已开始' });
    if (room.seats.length >= 4) return json(res, 400, { error: '房间已满' });
    const faction = pickFreeFaction(room);
    const botName = FACTION_BOT_NAMES[faction] || `Bot·训练家${room.seats.length}`;
    room.seats.push({ name: botName, token: tok(), isBot: true, connected: true, faction });
    broadcast(room);
    return json(res, 200, { ok: true });
  }

  if (route === '/api/room/kick' && req.method === 'POST') {
    const room = rooms.get(String(body.code || '').toUpperCase());
    if (!room) return json(res, 404, { error: '房间不存在' });
    if (seatByToken(room, body.token) !== room.hostSeat) return json(res, 403, { error: '只有房主可以操作' });
    if (room.phase !== 'lobby') return json(res, 400, { error: '游戏已开始' });
    const seat = body.seat;
    if (seat === room.hostSeat) return json(res, 400, { error: '不能移除自己' });
    room.seats.splice(seat, 1);
    broadcast(room);
    return json(res, 200, { ok: true });
  }

  if (route === '/api/game/start' && req.method === 'POST') {
    const room = rooms.get(String(body.code || '').toUpperCase());
    if (!room) return json(res, 404, { error: '房间不存在' });
    if (seatByToken(room, body.token) !== room.hostSeat) return json(res, 403, { error: '只有房主可以开始游戏' });
    if (room.phase !== 'lobby') return json(res, 400, { error: '游戏已开始' });
    if (room.seats.length < 2) return json(res, 400, { error: '至少需要 2 名玩家（可用 Bot 补位）' });
    const n = room.seats.length;
    const manual = normalizeOrder(body.order, n);
    const order = manual || randomOrder(n);
    room.orderMode = manual ? 'manual' : 'random';
    room.order = order;
    room.game = E.createGame(
      room.seats.map(s => ({ name: s.name, isBot: s.isBot, faction: s.faction })),
      order,
    );
    room.phase = 'playing';
    if (manual) room.game.log[0].msg = room.game.log[0].msg.replace('🎲 换位完成', '🎲 房主指定位次');
    room.introUntil = Date.now() + (manual ? 1600 : INTRO_MS);
    broadcast(room);
    scheduleBot(room);
    return json(res, 200, { ok: true, mode: room.orderMode, order });
  }

  if (route === '/api/action' && req.method === 'POST') {
    const room = rooms.get(String(body.code || '').toUpperCase());
    if (!room || !room.game) return json(res, 404, { error: '房间不存在或未开始' });
    const seat = seatByToken(room, body.token);
    if (seat === null || seat < 0) return json(res, 403, { error: '身份校验失败' });
    const r = E.applyAction(room.game, seat, body.action);
    if (!r.ok) return json(res, 400, { error: r.error });
    broadcast(room);
    scheduleBot(room);
    return json(res, 200, { ok: true });
  }

  if (route === '/api/room/leave' && req.method === 'POST') {
    const room = rooms.get(String(body.code || '').toUpperCase());
    if (room) {
      const seat = seatByToken(room, body.token);
      if (seat >= 0) {
        if (room.phase === 'lobby') {
          room.seats.splice(seat, 1);
          if (room.hostSeat >= room.seats.length) room.hostSeat = 0;
          if (!room.seats.length) rooms.delete(room.code);
          broadcast(room);
        } else if (room.game && room.game.phase === 'playing') {
          // 对战中退出：座位交给 Bot 托管，游戏继续
          const pl = room.game.players[seat];
          if (pl && !pl.isBot) {
            pl.isBot = true;
            room.seats[seat].isBot = true;
            E.addLog(room.game, `🚪 ${pl.name} 退出了对战，其宝可梦由 Bot 接管`);
          }
          room.seats[seat].connected = false;
          broadcast(room);
          scheduleBot(room);
        }
      }
    }
    return json(res, 200, { ok: true });
  }

  if (route === '/api/game/end' && req.method === 'POST') {
    const room = rooms.get(String(body.code || '').toUpperCase());
    if (!room || !room.game) return json(res, 404, { error: '房间不存在或未开始' });
    if (seatByToken(room, body.token) !== room.hostSeat) return json(res, 403, { error: '只有房主可以结束对战' });
    if (room.game.phase !== 'playing') return json(res, 400, { error: '对战已结束' });
    clearTimeout(room.botTimer);
    E.addLog(room.game, `🏳 房主结束了对战，按当前积分结算`);
    E.forceEnd(room.game);
    broadcast(room);
    return json(res, 200, { ok: true });
  }

  if (route === '/api/game/again' && req.method === 'POST') {
    const room = rooms.get(String(body.code || '').toUpperCase());
    if (!room || !room.game) return json(res, 404, { error: '房间不存在或未开始' });
    if (seatByToken(room, body.token) !== room.hostSeat) return json(res, 403, { error: '只有房主可以开始新一局' });
    if (room.phase !== 'playing' || room.game.phase !== 'ended') return json(res, 400, { error: '当前不能开始新一局' });
    clearTimeout(room.botTimer);
    E.addLog(room.game, `🔁 房主开始了新一局，重新决定先后手`);
    const n = room.seats.length;
    // 房主本次指定了位次就用它；否则沿用上一局的手动位次；再否则随机
    const manual = normalizeOrder(body.order, n)
      || (room.orderMode === 'manual' ? normalizeOrder(room.order, n) : null);
    const order = manual || randomOrder(n);
    room.orderMode = manual ? 'manual' : 'random';
    room.order = order;
    room.game = E.createGame(
      room.seats.map(s => ({ name: s.name, isBot: s.isBot, faction: s.faction })),
      order,
    );
    if (manual) room.game.log[0].msg = room.game.log[0].msg.replace('🎲 换位完成', '🎲 房主指定位次');
    room.introUntil = Date.now() + (manual ? 1600 : INTRO_MS);
    broadcast(room);
    scheduleBot(room);
    return json(res, 200, { ok: true, mode: room.orderMode, order });
  }

  return json(res, 404, { error: 'not found' });
}

/* ---------------- SSE ---------------- */
function handleStream(req, res, url) {
  const code = url.searchParams.get('code');
  const token = url.searchParams.get('token');
  const room = rooms.get(code);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const cli = { res, code, token };
  sseClients.add(cli);
  // 断线重连：标记在线
  if (room) {
    const seat = seatByToken(room, token);
    if (seat >= 0 && !room.seats[seat].connected) {
      room.seats[seat].connected = true;
      if (room.game) {
        room.game.log.push({ t: Date.now(), msg: `${room.seats[seat].name} 重新连接了游戏` });
      }
      broadcast(room);
    }
    // 立即推送当前状态
    setTimeout(() => broadcast(room), 50);
  }
  req.on('close', () => {
    sseClients.delete(cli);
    const r = rooms.get(code);
    if (r) {
      const seat = seatByToken(r, token);
      if (seat >= 0) {
        r.seats[seat].connected = false;
        broadcast(r);
        // 断线后 60s 仍未回来且是 lobby，则移除
      }
    }
  });
}

/* ---------------- 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function serveStatic(req, res, url) {
  let p = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    // HTML 与数据文件不缓存，保证更新即时生效；带版本号的 css/js 可长缓存
    const noCache = p === '/index.html' || p.endsWith('.json');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': noCache ? 'no-cache' : 'public, max-age=86400' });
    res.end(data);
  });
}

/* ---------------- 服务器 ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/stream') return handleStream(req, res, url);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    try { json(res, 500, { error: '服务器内部错误' }); } catch (_) {}
  }
});

// 心跳 + 房间清理
setInterval(() => {
  for (const cli of sseClients) sendSSE(cli, { type: 'ping' });
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > 12 * 3600e3) {
      clearTimeout(room.botTimer);
      rooms.delete(code);
    }
  }
}, 25000);

server.listen(PORT, () => {
  console.log(`Pokemon Splendor Online 服务器已启动: http://localhost:${PORT}`);
});
