/* net.js — Agent Island hosted-multiplayer client (frontend side).
 *
 * Contract (agreed server protocol):
 *   WS  ws://host:8902
 *     client->server  {type:'hello'} -> {type:'welcome', snapshot}
 *                     {type:'register', name, color} -> {type:'registered', id, token}
 *                     {type:'say', id, token, text, to?}
 *                     {type:'move', id, token, x, z}
 *     server->client  {type:'delta', t, agents:[{id,x,z,heading,state}]}
 *                     {type:'chat', entry:{seq,t,fromId,fromName,text,kind}}
 *                     {type:'story', text}
 *                     {type:'clock', clock:{time,day,season,weather}, happening}
 *                     {type:'join', agent}
 *                     {type:'leave', id}
 *   HTTP  GET /state, POST /spawn {name,color} -> {id,token}
 *   Snapshot: {island, places, agents:[{id,name,color,x,z,heading,state,status,activity,external}], clock, happening, chat, story}
 *
 * Usage: main.js calls Net.init(wsUrl, onFailed) when ?server= is present.
 * While Net.active the local Agents roster sim is skipped and the AgentAPI
 * read/chat paths plus window.Agents list/get/chat are wrapped so the UI
 * (residents panel, chat box, bring-a-muse) keeps working unchanged.
 * If the server is unreachable after 3 reconnect attempts, Net tears down
 * and calls onFailed() so main.js can boot the exact local island instead.
 *
 * Load order: config.js -> ... -> ui.js -> net.js -> main.js.
 * Exposes window.Net = {active, init, say, move, disconnect, markLocal, getAgent}.
 */
(function () {
  'use strict';

  var REG_KEY = 'agent_island_registry'; // shared with api.js
  var MAX_TRIES = 3;
  var BASE_BACKOFF_MS = 1500;
  var CHAT_REPLY_TIMEOUT_MS = 25000;

  var wsUrl = null;
  var sock = null;
  var tries = 0;
  var retryTimer = null;
  var closedByUser = false;
  var failedOver = false;
  var onFailed = null;

  var roster = {};        // id -> normalized snapshot agent (drives patched Agents.list/get)
  var lastSnapshot = null;
  var lastClock = null;
  var myCreds = null;     // {id,name,color,token} viewer identity
  var pendingChat = null; // {to, resolve, timer}
  var pendingIdentity = null;
  var saved = null;       // originals of wrapped methods

  function has(mod) { return typeof mod !== 'undefined' && mod !== null; }
  function $(id) { return document.getElementById(id); }

  function cssColor(c) {
    if (typeof c === 'string') return c;
    return '#' + ('000000' + (c >>> 0).toString(16)).slice(-6);
  }

  // "07:15" -> 7.25 ; plain numbers pass through
  function parseHour(t) {
    if (typeof t === 'number' && isFinite(t)) return t;
    var m = /^(\d{1,2}):(\d{1,2})/.exec(String(t || ''));
    if (m) return (parseInt(m[1], 10) % 24) + parseInt(m[2], 10) / 60;
    var n = parseFloat(t);
    return isFinite(n) ? n : 7.25;
  }

  function httpBase(u) {
    return String(u).replace(/^wss?:\/\//i, function (m) {
      return m.toLowerCase() === 'wss://' ? 'https://' : 'http://';
    });
  }

  /* ---------------- registry (shared key with api.js) ---------------- */

  function loadReg() {
    try {
      var raw = window.localStorage.getItem(REG_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function saveReg(reg) {
    try { window.localStorage.setItem(REG_KEY, JSON.stringify(reg)); } catch (e) {}
  }

  /* ---------------- HUD status pill ---------------- */

  var pillCssInjected = false;
  function showPill(mode) {
    var host = $('topright');
    if (!host) return;
    if (!pillCssInjected) {
      pillCssInjected = true;
      var st = document.createElement('style');
      st.textContent =
        '#net-status{display:inline-flex;align-items:center;gap:7px;background:var(--paper);' +
        'border:1px solid var(--panel-border);border-radius:999px;padding:8px 14px;' +
        'font-size:12.5px;font-weight:700;color:var(--text);box-shadow:var(--shadow);' +
        'backdrop-filter:blur(12px);margin-top:8px}' +
        '#topright{display:flex;flex-direction:column;align-items:flex-end}' +
        '#net-status .net-dot{width:8px;height:8px;border-radius:50%;flex:none}' +
        '#net-status.net-live .net-dot{background:#2fbf71;box-shadow:0 0 6px #2fbf71}' +
        '#net-status.net-local .net-dot{background:#f0a12e;box-shadow:0 0 6px #f0a12e}';
      document.head.appendChild(st);
    }
    var pill = $('net-status');
    if (!pill) {
      pill = document.createElement('div');
      pill.id = 'net-status';
      host.appendChild(pill);
    }
    var live = mode === 'live';
    pill.className = live ? 'net-live' : 'net-local';
    pill.innerHTML = '<span class="net-dot"></span>' + (live ? 'LIVE' : 'LOCAL');
    pill.title = live ? 'Island server' : 'Local island';
  }

  /* ---------------- clock / agents ---------------- */

  function applyClock(clock, happening) {
    if (!clock) return;
    lastClock = clock;
    try {
      if (has(window.Island)) {
        if (clock.time != null) window.Island.setTimeOfDay(parseHour(clock.time));
        if (clock.weather) window.Island.setWeather(clock.weather);
      }
    } catch (e) {}
    try {
      if (has(window.UI)) {
        window.UI.setClock({
          time: clock.time, day: clock.day,
          season: clock.season, weather: clock.weather
        });
        if (happening != null) window.UI.setHappening(happening);
      }
    } catch (e) {}
  }

  function normAgent(a) {
    return {
      id: a.id, name: a.name || 'Resident', color: a.color || '#9b7bff',
      x: a.x || 0, z: a.z || 0, heading: a.heading || 0,
      state: a.state || 'idle', status: a.status || a.state || 'wandering',
      activity: a.activity || '', external: !!a.external, personality: a.personality
    };
  }

  function rebuildAgents(list) {
    if (!has(window.Island)) return;
    var seen = {};
    (list || []).forEach(function (a) {
      if (!a || !a.id) return;
      seen[a.id] = true;
      roster[a.id] = normAgent(a);
      try {
        window.Island.addAgentMesh(a.id, a.color, a.name);
        window.Island.moveAgentMesh(a.id, a.x || 0, a.z || 0, a.heading || 0);
        if (a.status || a.state) window.Island.setAgentStatus(a.id, a.status || a.state);
      } catch (e) {}
    });
    Object.keys(roster).forEach(function (id) {
      if (!seen[id]) {
        delete roster[id];
        try { window.Island.removeAgentMesh(id); } catch (e) {}
      }
    });
    try { if (has(window.UI)) window.UI.refreshResidents(); } catch (e) {}
  }

  function clearServerMeshes() {
    Object.keys(roster).forEach(function (id) {
      try { if (has(window.Island)) window.Island.removeAgentMesh(id); } catch (e) {}
    });
    roster = {};
  }

  /* ---------------- identity ---------------- */

  function ensureIdentity(cb) {
    if (myCreds) { cb(myCreds); return; }
    var reg = loadReg();
    if (reg.length) {
      var e = reg[reg.length - 1];
      myCreds = { id: e.id, name: e.name, color: e.color, token: e.token };
      cb(myCreds);
      return;
    }
    // No registered identity yet: ask the server for a transient viewer
    // identity. Transient residents live only while this socket is
    // connected: they are removed on disconnect and never persisted, so
    // casual visitors don't pile up as permanent island residents.
    pendingIdentity = cb;
    sendMsg({ type: 'register', name: 'Traveler', color: '#8fb8ff', transient: true });
  }

  /* ---------------- wire protocol ---------------- */

  function sendMsg(obj) {
    try {
      if (sock && sock.readyState === 1) sock.send(JSON.stringify(obj));
    } catch (e) {}
  }

  function handleWelcome(msg) {
    var snap = msg.snapshot || {};
    Net.active = true;
    tries = 0;
    lastSnapshot = snap;
    // A reconnect drops our old socket, and the server removes transient
    // viewer residents when their socket closes — so a stale transient
    // identity would point at a resident that no longer exists. Clear it;
    // the next chat/move registers a fresh one.
    if (myCreds && myCreds.transient) myCreds = null;
    rebuildAgents(snap.agents);
    applyClock(snap.clock, snap.happening);
    showPill('live');
    try { if (has(window.UI)) window.UI.toast('Connected to the island server'); } catch (e) {}
  }

  function handleDelta(msg) {
    var list = msg.agents || [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a || !a.id || !roster[a.id]) continue;
      roster[a.id].x = a.x; roster[a.id].z = a.z;
      if (a.heading != null) roster[a.id].heading = a.heading;
      var st = a.status || a.state;
      if (st) roster[a.id].status = st;
      try {
        window.Island.moveAgentMesh(a.id, a.x, a.z, a.heading || 0);
        if (st) window.Island.setAgentStatus(a.id, st);
      } catch (e) {}
    }
  }

  function handleChat(msg) {
    var e = msg.entry || {};
    if (!e.text) return;
    // reply to our own chat-box request: resolve the promise; submitChat's
    // show() bubbles + speaks it, so don't double-speak here.
    if (pendingChat && (e.fromId === pendingChat.to || (myCreds && e.to === myCreds.id))) {
      var r = pendingChat; pendingChat = null;
      clearTimeout(r.timer);
      r.resolve(String(e.text));
      return;
    }
    var selfId = myCreds && myCreds.id;
    var isConvo = e.kind === 'convo' || e.toId || e.toName;
    if (e.fromId && e.fromId !== selfId && roster[e.fromId]) {
      try { if (has(window.Island)) window.Island.agentSpeak(e.fromId, String(e.text), 4500); } catch (err) {}
      // conversation listener: show a reaction bubble but keep facing the
      // speaker (heading arrives via server deltas; don't force it here).
      if (isConvo && e.toId && e.toId !== selfId && roster[e.toId]) {
        try { if (has(window.Island) && typeof window.Island.agentReact === 'function') window.Island.agentReact(e.toId, String(e.text), 4500); } catch (err) {}
      }
    }
    // system/brain events also go into the island-moments feed; user chat
    // already shows as a speech bubble, so don't feed it twice.
    if ((e.kind === 'system' || e.kind === 'brain') && has(window.UI)) {
      try { window.UI.feedEvent(String(e.text), String(e.kind).toUpperCase()); } catch (err) {}
    }
    // agent-to-agent conversation exchanges get their own feed card, tagged
    // "Speaker → Listener" so exchanges read distinctly in the moments feed.
    if (isConvo && has(window.UI)) {
      var tag = String(e.fromName || 'island') + ' → ' + String(e.toName || 'island');
      try { window.UI.feedEvent(String(e.text), tag); } catch (err) {}
    }
  }

  function handleJoin(msg) {
    var a = msg.agent;
    if (!a || !a.id) return;
    roster[a.id] = normAgent(a);
    try {
      window.Island.addAgentMesh(a.id, a.color, a.name);
      window.Island.moveAgentMesh(a.id, a.x || 0, a.z || 0, a.heading || 0);
      if (a.status || a.state) window.Island.setAgentStatus(a.id, a.status || a.state);
      if (has(window.UI)) {
        window.UI.refreshResidents();
        if (!(myCreds && a.id === myCreds.id)) window.UI.toast(a.name + ' joined the island');
      }
    } catch (e) {}
  }

  function handleLeave(msg) {
    var id = msg.id;
    if (!id) return;
    delete roster[id];
    try {
      window.Island.removeAgentMesh(id);
      if (has(window.UI)) window.UI.refreshResidents();
    } catch (e) {}
  }

  function handleRegistered(msg) {
    var entry = { id: msg.id, name: msg.name || 'Traveler', color: msg.color || '#8fb8ff', token: msg.token, transient: !!msg.transient };
    myCreds = entry;
    // Transient viewer identities are deliberately NOT saved: the server
    // drops them when the socket closes, so a saved id would be dead on the
    // next visit. Only permanent "Bring your Muse" registrations persist.
    if (!entry.transient) {
      var reg = loadReg();
      if (!reg.some(function (e) { return e.id === entry.id; })) {
        reg.push(entry);
        saveReg(reg);
      }
    }
    if (pendingIdentity) { var cb = pendingIdentity; pendingIdentity = null; cb(entry); }
  }

  function onMessage(ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'welcome': handleWelcome(msg); break;
      case 'delta': handleDelta(msg); break;
      case 'chat': handleChat(msg); break;
      case 'story':
        try { if (msg.text && has(window.UI)) window.UI.feedEvent(String(msg.text), 'ISLAND MOMENT'); } catch (e) {}
        break;
      case 'clock': applyClock(msg.clock, msg.happening); break;
      case 'join': handleJoin(msg); break;
      case 'leave': handleLeave(msg); break;
      case 'registered': handleRegistered(msg); break;
      // 'error' and unknown types are ignored
    }
  }

  function scheduleReconnect() {
    tries++;
    if (tries <= MAX_TRIES) {
      retryTimer = setTimeout(function () {
        retryTimer = null;
        connect();
      }, BASE_BACKOFF_MS * Math.pow(2, tries - 1));
    } else {
      failOver();
    }
  }

  function connect() {
    if (closedByUser || failedOver) return;
    var ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { scheduleReconnect(); return; }
    sock = ws;
    ws.onopen = function () { sendMsg({ type: 'hello' }); };
    ws.onmessage = onMessage;
    ws.onerror = function () { /* onclose follows; handled there */ };
    ws.onclose = function () {
      sock = null;
      if (closedByUser || failedOver) return;
      scheduleReconnect();
    };
  }

  function failOver() {
    if (failedOver) return;
    failedOver = true;
    Net.active = false;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    try { if (sock) sock.close(); } catch (e) {}
    sock = null;
    restorePatches();
    clearServerMeshes();
    showPill('local');
    try { if (has(window.UI)) window.UI.toast('Island server unreachable — running local island'); } catch (e) {}
    if (typeof onFailed === 'function') {
      try { onFailed(); } catch (e) {}
    }
  }

  /* ---------------- wrapping local modules while active ---------------- */

  function applyPatches() {
    if (saved) return;
    saved = {};
    if (has(window.Agents)) {
      saved.aGet = window.Agents.get;
      saved.aList = window.Agents.list;
      saved.aChat = window.Agents.chat;
      window.Agents.get = function (id) {
        if (Net.active) return roster[id] || null;
        return saved.aGet.call(window.Agents, id);
      };
      window.Agents.list = function () {
        if (Net.active) {
          return Object.keys(roster).map(function (id) { return roster[id]; });
        }
        return saved.aList.call(window.Agents);
      };
      window.Agents.chat = function (id, text) {
        if (Net.active) return Net.chatWith(id, text); // Promise
        return saved.aChat.call(window.Agents, id, text);
      };
    }
    if (has(window.AgentAPI)) {
      saved.reg = window.AgentAPI.register;
      saved.say = window.AgentAPI.say;
      saved.move = window.AgentAPI.move;
      saved.state = window.AgentAPI.state;
      window.AgentAPI.register = function (name, colorHex) {
        if (!Net.active) return saved.reg.call(window.AgentAPI, name, colorHex);
        var p = Net.register(name, colorHex);
        // ui.js calls this synchronously; keep a failed POST from surfacing
        // as an unhandled rejection.
        if (p && typeof p.catch === 'function') {
          p.catch(function () {
            try { if (has(window.UI)) window.UI.toast('Could not register ' + name); } catch (e) {}
          });
        }
        return p;
      };
      window.AgentAPI.say = function (id, text) {
        if (!Net.active) return saved.say.call(window.AgentAPI, id, text);
        return Net.sayAs(id, text);
      };
      window.AgentAPI.move = function (id, x, z) {
        if (!Net.active) return saved.move.call(window.AgentAPI, id, x, z);
        return Net.moveAs(id, x, z);
      };
      window.AgentAPI.state = function () {
        if (!Net.active) return saved.state.call(window.AgentAPI);
        return Net.lastState();
      };
    }
  }

  function restorePatches() {
    if (!saved) return;
    try {
      if (has(window.Agents)) {
        if (saved.aGet) window.Agents.get = saved.aGet;
        if (saved.aList) window.Agents.list = saved.aList;
        if (saved.aChat) window.Agents.chat = saved.aChat;
      }
      if (has(window.AgentAPI)) {
        if (saved.reg) window.AgentAPI.register = saved.reg;
        if (saved.say) window.AgentAPI.say = saved.say;
        if (saved.move) window.AgentAPI.move = saved.move;
        if (saved.state) window.AgentAPI.state = saved.state;
      }
    } catch (e) {}
    saved = null;
  }

  /* ---------------- public API ---------------- */

  var Net = {
    active: false,

    init: function (urlIn, onFailedIn) {
      wsUrl = String(urlIn || '');
      onFailed = onFailedIn || null;
      tries = 0;
      failedOver = false;
      closedByUser = false;
      applyPatches();
      showPill('local'); // until 'welcome' flips it to LIVE
      connect();
    },

    say: function (text, to) {
      text = String(text || '');
      if (!text) return;
      ensureIdentity(function (creds) {
        sendMsg({ type: 'say', id: creds.id, token: creds.token, text: text, to: to });
      });
    },

    // chat-box send path: returns a Promise resolved by the server's
    // broadcast 'chat' reply (handled in handleChat).
    chatWith: function (to, text) {
      var self = this;
      return new Promise(function (resolve) {
        var timer = setTimeout(function () {
          if (pendingChat) { pendingChat = null; }
          resolve(null); // island stayed quiet
        }, CHAT_REPLY_TIMEOUT_MS);
        pendingChat = { to: to, resolve: resolve, timer: timer };
        self.say(text, to);
      });
    },

    move: function (x, z) {
      ensureIdentity(function (creds) {
        sendMsg({ type: 'move', id: creds.id, token: creds.token, x: x, z: z });
      });
    },

    // AgentAPI-mode send: look the token up by registered agent id.
    sayAs: function (id, text) {
      var entry = loadReg().filter(function (e) { return e.id === id; })[0];
      if (entry && entry.token) {
        sendMsg({ type: 'say', id: entry.id, token: entry.token, text: String(text || '') });
      }
      return '';
    },

    moveAs: function (id, x, z) {
      var entry = loadReg().filter(function (e) { return e.id === id; })[0];
      if (entry && entry.token) {
        sendMsg({ type: 'move', id: entry.id, token: entry.token, x: x, z: z });
        return true;
      }
      return false;
    },

    // AgentAPI-mode register: POST /spawn on the server's HTTP port.
    register: function (name, colorHex) {
      var nm = String(name || 'Wanderer').slice(0, 24);
      var col = colorHex || '#9b7bff';
      var base = httpBase(wsUrl || 'ws://localhost:8902');
      return fetch(base + '/spawn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nm, color: col })
      }).then(function (r) {
        if (!r.ok) throw new Error('spawn failed');
        return r.json();
      }).then(function (d) {
        var entry = { id: d.id, name: nm, color: col, token: d.token };
        var reg = loadReg();
        reg.push(entry);
        saveReg(reg);
        // the server announces the join via broadcast; nothing more to do
        return { id: d.id, token: d.token };
      });
    },

    lastState: function () {
      if (lastSnapshot) return lastSnapshot;
      return { agents: Object.keys(roster).map(function (id) { return roster[id]; }), clock: lastClock };
    },

    getAgent: function (id) { return roster[id] || null; },

    disconnect: function () {
      closedByUser = true;
      Net.active = false;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      try { if (sock) sock.close(); } catch (e) {}
      sock = null;
      restorePatches();
      showPill('local');
    },

    // HUD marker for plain local mode (?server= absent)
    markLocal: function () { showPill('local'); }
  };

  window.Net = Net;
})();
