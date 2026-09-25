/* api.js — Agent Island: external-agent API (register / say / move / state). */
/* Load order: config.js -> island.js -> agents.js -> api.js -> ui.js -> main.js */
(function () {
  'use strict';

  var REG_KEY = 'agent_island_registry';
  var chatListeners = [];

  function hasStorage() {
    try {
      return typeof window.localStorage !== 'undefined';
    } catch (e) { return false; }
  }

  function loadRegistry() {
    if (!hasStorage()) return [];
    try {
      var raw = window.localStorage.getItem(REG_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function saveRegistry(reg) {
    if (!hasStorage()) return;
    try { window.localStorage.setItem(REG_KEY, JSON.stringify(reg)); } catch (e) {}
  }

  function randomToken() {
    var chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    var out = '';
    for (var i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  function randomId() {
    return 'ext-' + Math.random().toString(36).slice(2, 8);
  }

  window.AgentAPI = {
    init: function () {
      // no-op safe: just make sure storage access won't throw later
      hasStorage();
    },

    register: function (name, colorHex) {
      name = String(name || 'Wanderer').slice(0, 24);
      var id = randomId();
      var token = randomToken();
      var entry = { id: id, name: name, color: colorHex || '#9b7bff', token: token };

      var reg = loadRegistry();
      reg.push(entry);
      saveRegistry(reg);

      // hook into the Agents module if it's up
      if (typeof window.Agents !== 'undefined' && window.Agents.addExternal) {
        try {
          var agent = window.Agents.addExternal({ name: name, color: entry.color });
          if (agent) {
            entry.id = agent.id;
            saveRegistry(reg);
            id = agent.id;
          }
        } catch (e) {}
      }
      if (typeof window.UI !== 'undefined' && window.UI.toast) {
        try { window.UI.toast('Muse registered: ' + name); } catch (e) {}
      }
      return { id: id, token: token };
    },

    say: function (id, text) {
      var reply = '';
      if (typeof window.Agents !== 'undefined' && window.Agents.chat) {
        try { reply = window.Agents.chat(id, text) || ''; } catch (e) {}
      }
      for (var i = 0; i < chatListeners.length; i++) {
        try { chatListeners[i](id, text, reply); } catch (e) {}
      }
      return reply;
    },

    move: function (id, x, z) {
      var ISLE = window.ISLE || {};
      var R = (ISLE.radius || 40) - 4;
      x = Number(x) || 0; z = Number(z) || 0;
      var d = Math.hypot(x, z);
      if (d > R) { x *= R / d; z *= R / d; }
      if (typeof window.Agents !== 'undefined' && window.Agents.sendTo) {
        try { return !!window.Agents.sendTo(id, x, z); } catch (e) {}
      }
      return false;
    },

    state: function () {
      var ISLE = window.ISLE || {};
      var agents = [];
      if (typeof window.Agents !== 'undefined' && window.Agents.list) {
        try { agents = window.Agents.list(); } catch (e) {}
      }
      var places = {};
      (ISLE.places || []).forEach(function (p) {
        places[p.id] = { name: p.name, x: p.x, z: p.z, color: p.color };
      });
      return {
        agents: agents,
        places: places,
        island: { name: ISLE.name || 'Agent Island', code: ISLE.code || 'AGENT-ISLAND' },
        time: Date.now()
      };
    },

    onChat: function (fn) {
      if (typeof fn === 'function') chatListeners.push(fn);
      return function () {
        var i = chatListeners.indexOf(fn);
        if (i !== -1) chatListeners.splice(i, 1);
      };
    },

    restore: function (AgentsModule) {
      // Re-add registered external agents after Agents.init (called from main.js).
      var mod = AgentsModule || window.Agents;
      if (!mod || !mod.addExternal) return;
      var reg = loadRegistry();
      for (var i = 0; i < reg.length; i++) {
        var e = reg[i];
        try {
          var agent = mod.addExternal({ name: e.name, color: e.color });
          if (agent && agent.id !== e.id) {
            // agent ids are derived; if it changed, keep registry in sync
            e.id = agent.id;
          }
        } catch (err) {}
      }
      saveRegistry(reg);
    }
  };
})();
