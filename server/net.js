/* net.js — HTTP + WebSocket network layer for the Agent Island engine.
 *
 * Pure transport: JSON protocol over WS, small REST surface over HTTP.
 * All game logic lives in engine.js; this file only validates, authenticates,
 * and broadcasts.
 */
'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');

const MAX_BODY = 1 * 1024 * 1024; // 1 MB

function start(engine, opts = {}) {
  const port = Number(opts.port || process.env.PORT || 8902);
  const SECRET = process.env.ISLAND_SECRET || '';
  const startedAt = Date.now();

  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer(handleRequest);

  // Say rate limit: 1 accepted message per agent per SAY_COOLDOWN_MS (2 s),
  // enforced in the transport layer (here, not the engine) so a spammy
  // client burns one cheap check instead of touching the sim. Tracked by
  // agent id: counts the request once — a `say` to a roster agent (brain
  // reply) emits two chat entries but is still one request. Roster agents
  // have no tokens and can't say at all, so this only affects external
  // residents. In-memory Map; stale entries are pruned on insert so it
  // can't grow unboundedly.
  const SAY_COOLDOWN_MS = 2000;
  const lastSayAt = new Map(); // id -> timestamp of last accepted say
  function checkSayRate(id) {
    const now = Date.now();
    // prune occasionally: drop entries older than 2x the cooldown window
    if (lastSayAt.size >= 1000 || Math.random() < 0.01) {
      for (const [k, t] of lastSayAt) {
        if (now - t > SAY_COOLDOWN_MS * 2) lastSayAt.delete(k);
      }
    }
    const last = lastSayAt.get(id);
    if (last !== undefined && now - last < SAY_COOLDOWN_MS) {
      return { limited: true, retryAfterMs: SAY_COOLDOWN_MS - (now - last) };
    }
    lastSayAt.set(id, now);
    return { limited: false, retryAfterMs: 0 };
  }

  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // ------------------------------------------------------------------ broadcast
  function broadcast(obj) {
    const msg = JSON.stringify(obj);
    for (const ws of wss.clients) {
      if (ws.readyState === 1) { // OPEN
        try { ws.send(msg); } catch (e) { /* drop */ }
      }
    }
  }

  // Engine events -> broadcasts -----------------------------------------
  engine.on('chat', (entry) => broadcast({ type: 'chat', entry }));
  engine.on('story', (event) => broadcast({ type: 'story', ...event }));
  engine.on('join', (agent) => broadcast({ type: 'join', agent }));
  engine.on('leave', (id) => broadcast({ type: 'leave', id }));

  // Delta loop: 10 Hz, only agents whose position/heading/state changed ----
  const lastSent = new Map(); // id -> {x,z,heading,state}
  const deltaTimer = setInterval(() => {
    const changed = [];
    for (const a of engine.listAgents()) {
      const prev = lastSent.get(a.id);
      if (!prev || prev.x !== a.x || prev.z !== a.z ||
          prev.heading !== a.heading || prev.state !== a.state) {
        changed.push({ id: a.id, x: a.x, z: a.z, heading: a.heading, state: a.state });
        lastSent.set(a.id, { x: a.x, z: a.z, heading: a.heading, state: a.state });
      }
    }
    // prune departed agents
    for (const id of lastSent.keys()) {
      if (!engine.getAgent(id)) lastSent.delete(id);
    }
    if (changed.length) broadcast({ type: 'delta', t: Date.now(), agents: changed });
  }, 100);
  deltaTimer.unref();

  // Clock loop: every 6 s ---------------------------------------------------
  const clockTimer = setInterval(() => {
    broadcast({ type: 'clock', clock: engine.clockState(), happening: engine.happening });
  }, 6000);
  clockTimer.unref();

  // ------------------------------------------------------------------ WS
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); }
      catch (e) { return ws.send(JSON.stringify({ type: 'error', error: 'invalid JSON' })); }
      try { handleWs(ws, msg); }
      catch (e) { ws.send(JSON.stringify({ type: 'error', error: e.message || 'error' })); }
    });
    // Transient viewer residents only live while their socket is connected.
    ws.on('close', () => {
      const ids = ws._transientIds;
      ws._transientIds = null;
      if (ids) {
        for (const id of ids) {
          const a = engine.getAgent(id);
          if (a && a.transient) engine.remove(id); // emits 'leave' -> broadcast
        }
      }
    });
  });

  function checkSecret(secret) {
    if (SECRET && secret !== SECRET) throw new Error('invalid secret');
  }

  function authed(msg) {
    if (!engine.getAgent(msg.id)) throw new Error('unknown agent');
    if (!engine.checkToken(msg.id, msg.token)) throw new Error('bad token');
    return engine.getAgent(msg.id);
  }

  function handleWs(ws, msg) {
    switch (msg.type) {
      case 'hello':
        ws.send(JSON.stringify({
          type: 'welcome',
          snapshot: engine.snapshot(),
          serverTime: Date.now(),
        }));
        break;

      case 'register': {
        checkSecret(msg.secret);
        // transient: true marks a casual viewer (e.g. a browser tab that just
        // wants to chat). The resident is removed when this socket closes and
        // is never persisted. Omitted/false keeps the classic behavior: a
        // permanent resident that must leave explicitly via POST /leave.
        const transient = msg.transient === true;
        const res = engine.spawnResident({ name: msg.name, color: msg.color, transient });
        if (transient) {
          ws._transientIds = ws._transientIds || [];
          ws._transientIds.push(res.id);
        }
        ws.send(JSON.stringify({ type: 'registered', id: res.id, token: res.token, name: res.name, transient }));
        break;
      }

      case 'say': {
        authed(msg);
        const rate = checkSayRate(msg.id);
        if (rate.limited) {
          ws.send(JSON.stringify({ type: 'error', error: 'rate limited' }));
          break;
        }
        engine.say(msg.id, msg.text, { to: msg.to }); // emits 'chat' -> broadcast
        break;
      }

      case 'move': {
        authed(msg);
        if (!engine.move(msg.id, msg.x, msg.z)) throw new Error('move rejected');
        break; // movement shows up in the 10 Hz delta stream
      }

      default:
        ws.send(JSON.stringify({ type: 'error', error: 'unknown message type: ' + msg.type }));
    }
  }

  // ------------------------------------------------------------------ HTTP
  function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  function json(res, status, obj) {
    cors(res);
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
        catch (e) { reject(new Error('invalid JSON body')); }
      });
      req.on('error', reject);
    });
  }

  async function handleRequest(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;

    try {
      if (req.method === 'GET' && path === '/health') {
        return json(res, 200, {
          ok: true,
          agents: engine.order.length,
          uptime: Math.floor((Date.now() - startedAt) / 1000),
        });
      }
      if (req.method === 'GET' && path === '/state') {
        return json(res, 200, engine.snapshot());
      }
      if (req.method === 'GET' && path === '/chat') {
        const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 200);
        return json(res, 200, { chat: engine.chat.slice(-limit) });
      }
      if (req.method === 'GET' && path === '/places') {
        return json(res, 200, { places: engine.snapshot().places });
      }

      if (req.method === 'POST' && path === '/say') {
        const body = await readBody(req);
        if (!engine.getAgent(body.id)) return json(res, 404, { error: 'unknown agent' });
        if (!engine.checkToken(body.id, body.token)) return json(res, 403, { error: 'bad token' });
        const rate = checkSayRate(body.id);
        if (rate.limited) return json(res, 429, { error: 'rate limited', retryAfterMs: rate.retryAfterMs });
        const { entry, replyEntry } = engine.say(body.id, body.text, { to: body.to });
        return json(res, 200, { ok: true, entry, reply: replyEntry });
      }
      if (req.method === 'POST' && path === '/move') {
        const body = await readBody(req);
        if (!engine.getAgent(body.id)) return json(res, 404, { error: 'unknown agent' });
        if (!engine.checkToken(body.id, body.token)) return json(res, 403, { error: 'bad token' });
        if (!engine.move(body.id, body.x, body.z)) return json(res, 400, { error: 'move rejected' });
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/spawn') {
        const body = await readBody(req);
        if (SECRET && body.secret !== SECRET) return json(res, 403, { error: 'invalid secret' });
        const r = engine.spawnResident({ name: body.name, color: body.color });
        return json(res, 200, { id: r.id, token: r.token, name: r.name });
      }
      if (req.method === 'POST' && path === '/leave') {
        const body = await readBody(req);
        if (!engine.getAgent(body.id)) return json(res, 404, { error: 'unknown agent' });
        if (!engine.checkToken(body.id, body.token)) return json(res, 403, { error: 'bad token' });
        engine.remove(body.id);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/admin/convo') {
        if (SECRET && url.searchParams.get('secret') !== SECRET) {
          return json(res, 403, { error: 'invalid secret' });
        }
        const convo = engine.triggerConversation();
        if (!convo) return json(res, 400, { error: 'need at least 2 agents for a conversation' });
        return json(res, 200, { ok: true, a: convo.a, b: convo.b, lines: convo.lines });
      }
      if (req.method === 'GET' && path === '/admin/snapshot') {
        if (SECRET && url.searchParams.get('secret') !== SECRET) {
          return json(res, 403, { error: 'invalid secret' });
        }
        engine.saveToDisk();
        return json(res, 200, { ok: true, agents: engine.order.length, path: engine.snapshotRelPath() });
      }

      return json(res, 404, { error: 'not found' });
    } catch (e) {
      return json(res, 400, { error: e.message || 'bad request' });
    }
  }

  server.listen(port);

  return {
    server,
    wss,
    port,
    broadcast,
    close(cb) {
      clearInterval(deltaTimer);
      clearInterval(clockTimer);
      wss.close(() => server.close(cb));
    },
  };
}

module.exports = { start };
