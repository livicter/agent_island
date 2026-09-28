/* agents.js — browser host for the shared sim (js/sim-core.js).
 * Load order: config.js -> island.js -> sim-core.js -> agents.js -> api.js -> ui.js -> main.js */
(function () {
  'use strict';

  var agents = {};   // id -> agent
  var order = [];    // spawn order of ids
  var storyTimer = 20; // seconds until next island moment

  function rand(min, max) { return min + Math.random() * (max - min); }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function randomPlace() {
    var ISLE = window.ISLE || {};
    var places = ISLE.places || [];
    if (!places.length) return null;
    return pick(places);
  }

  function spawnAgent(def, isExternal) {
    var place = randomPlace();
    var x = place ? place.x + rand(-5, 5) : 0;
    var z = place ? place.z + rand(-5, 5) : 0;
    var agent = {
      id: isExternal ? 'ext-' + def.id : 'a-' + def.name,
      name: def.name,
      color: def.color,
      personality: def.personality || 'easygoing',
      x: x, z: z,
      tx: x, tz: z,
      speed: rand(1.2, 2.2),
      state: 'idle',
      status: 'working',
      activity: pick(window.IsleSim.ACTIVITIES),
      pause: rand(1, 4),
      external: !!isExternal
    };
    agents[agent.id] = agent;
    order.push(agent.id);
    if (typeof window.Island !== 'undefined' && window.Island.addAgentMesh) {
      try { window.Island.addAgentMesh(agent.id, agent.color, agent.name); } catch (e) {}
    }
    if (typeof window.UI !== 'undefined' && window.UI.refreshResidents) {
      try { window.UI.refreshResidents(); } catch (e) {}
    }
    return agent;
  }

  function nearestPlace(x, z) {
    var ISLE = window.ISLE || {};
    var places = ISLE.places || [];
    var best = null, dist = Infinity;
    for (var i = 0; i < places.length; i++) {
      var d = Math.hypot(x - places[i].x, z - places[i].z);
      if (d < dist) { dist = d; best = places[i]; }
    }
    return best ? { place: best, dist: dist } : null;
  }

  function fireStoryEvent() {
    var ids = order.filter(function (id) { return agents[id] && !agents[id].external; });
    if (!ids.length) return;
    var a = agents[pick(ids)];
    var near = nearestPlace(a.x, a.z);
    var where = near && near.dist < 10 ? near.place.name : 'the open shore';
    var doing = a.state === 'walking'
      ? 'walking toward ' + where
      : (a.activity || 'idle') + ' near ' + where;
    var text = a.name + ' is ' + doing + '.';
    if (typeof window.UI !== 'undefined' && window.UI.feedEvent) {
      try { window.UI.feedEvent(text, 'ISLAND MOMENT', { persist: true }); } catch (e) {}
    }
    try {
      if (near && near.dist < 12 && window.Island && window.Island.faceToward) {
        window.Island.faceToward(a.id, near.place.x, near.place.z);
      }
    } catch (e) {}
  }

  window.Agents = {
    init: function () {
      var ISLE = window.ISLE || {};
      var roster = ISLE.roster || [];
      for (var i = 0; i < roster.length; i++) spawnAgent(roster[i], false);
    },

    tick: function (dt) {
      if (!dt || dt <= 0) dt = 0.016;
      dt = Math.min(dt, 0.25); // clamp spikes

      for (var i = 0; i < order.length; i++) {
        var a = agents[order[i]];
        var ISLE = window.ISLE || {};
        var stepped = window.IsleSim.stepAgent(a, dt, { places: ISLE.places, radius: ISLE.radius });
        if (stepped.activityChanged && typeof window.Island !== 'undefined' && window.Island.setAgentStatus) {
          try { window.Island.setAgentStatus(a.id, a.status); } catch (e) {}
        }
        if (typeof window.Island !== 'undefined' && window.Island.moveAgentMesh) {
          try { window.Island.moveAgentMesh(a.id, a.x, a.z, a.heading || 0); } catch (e) {}
        }
      }

      storyTimer -= dt;
      if (storyTimer <= 0) {
        fireStoryEvent();
        storyTimer = rand(25, 45);
      }
    },

    list: function () {
      return order.map(function (id) {
        var a = agents[id];
        return { id: a.id, name: a.name, status: a.status, activity: a.activity, color: a.color };
      });
    },

    get: function (id) { return agents[id] || null; },

    chat: function (id, text) {
      var a = agents[id];
      var ISLE = window.ISLE || {};
      return window.IsleSim.chatReply({
        agent: a,
        text: text,
        islandName: ISLE.name || 'Agent Island',
        places: ISLE.places || [],
        others: order.map(function (oid) { return agents[oid]; }),
        fallbacks: ISLE.chatFallbacks
      });
    },

    sendTo: function (id, x, z) {
      var a = agents[id];
      if (!a) return false;
      a.tx = x; a.tz = z;
      a.state = 'walking';
      return true;
    },

    addExternal: function (def) {
      // def: {name, color} — returns the created agent
      if (!def || !def.name) return null;
      def = {
        id: 'x' + Math.random().toString(36).slice(2, 9),
        name: String(def.name).slice(0, 24),
        color: def.color || '#9b7bff',
        personality: 'curious'
      };
      return spawnAgent(def, true);
    },

    remove: function (id) {
      var a = agents[id];
      if (!a) return false;
      delete agents[id];
      var idx = order.indexOf(id);
      if (idx !== -1) order.splice(idx, 1);
      if (typeof window.Island !== 'undefined' && window.Island.removeAgentMesh) {
        try { window.Island.removeAgentMesh(id); } catch (e) {}
      }
      if (typeof window.UI !== 'undefined' && window.UI.refreshResidents) {
        try { window.UI.refreshResidents(); } catch (e) {}
      }
      return true;
    }
  };
})();
