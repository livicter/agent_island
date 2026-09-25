/* agents.js — Agent Island: roster agents, wandering simulation, story events, chat brain. */
/* Load order: config.js -> island.js -> agents.js -> api.js -> ui.js -> main.js */
(function () {
  'use strict';

  var ACTIVITIES = [
    'gathering star sand',
    'tending the garden',
    'repairing wind chimes',
    'mapping the shore',
    'brewing moonberry tea',
    'watching the moths',
    'polishing tide glass',
    'humming to the palms',
    'sorting seashell notes',
    'nap-sketching clouds'
  ];

  var agents = {};   // id -> agent
  var order = [];    // spawn order of ids
  var storyTimer = 20; // seconds until next island moment

  function rand(min, max) { return min + Math.random() * (max - min); }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function randomPoint(within) {
    var a = Math.random() * Math.PI * 2;
    var r = Math.sqrt(Math.random()) * within;
    return { x: Math.cos(a) * r, z: Math.sin(a) * r };
  }

  function randomPlace() {
    var ISLE = window.ISLE || {};
    var places = ISLE.places || [];
    if (!places.length) return null;
    return pick(places);
  }

  function setTarget(agent) {
    var place = randomPlace();
    if (place && Math.random() < 0.7) {
      agent.tx = place.x + rand(-6, 6);
      agent.tz = place.z + rand(-6, 6);
    } else {
      var p = randomPoint(34);
      agent.tx = p.x; agent.tz = p.z;
    }
    // clamp to island radius
    var ISLE = window.ISLE || {};
    var R = (ISLE.radius || 40) - 4;
    var d = Math.hypot(agent.tx, agent.tz);
    if (d > R) { agent.tx *= R / d; agent.tz *= R / d; }
    agent.state = 'walking';
  }

  function maybeFlipActivity(agent) {
    if (Math.random() < 0.25) {
      agent.status = Math.random() < 0.7 ? 'working' : 'idle';
      agent.activity = pick(ACTIVITIES);
      if (typeof window.Island !== 'undefined' && window.Island.setAgentStatus) {
        try { window.Island.setAgentStatus(agent.id, agent.status); } catch (e) {}
      }
    }
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
      activity: pick(ACTIVITIES),
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

  function fireStoryEvent() {
    var ISLE = window.ISLE || {};
    var templates = ISLE.storyTemplates || [];
    var names = order.filter(function (id) { return !agents[id].external; })
      .map(function (id) { return agents[id].name; });
    if (!templates.length || names.length < 2) return;
    var a = pick(names);
    var b = pick(names.filter(function (n) { return n !== a; }));
    var place = randomPlace();
    var text = pick(templates)
      .replace(/\{a\}/g, a)
      .replace(/\{b\}/g, b)
      .replace(/\{p\}/g, place ? place.name : 'the shore');
    if (typeof window.UI !== 'undefined' && window.UI.feedEvent) {
      try { window.UI.feedEvent(text, 'ISLAND MOMENT'); } catch (e) {}
    }
  }

  function placeByName(text) {
    var ISLE = window.ISLE || {};
    var places = ISLE.places || [];
    var low = text.toLowerCase();
    for (var i = 0; i < places.length; i++) {
      if (low.indexOf(String(places[i].name).toLowerCase()) !== -1) return places[i];
    }
    return null;
  }

  function otherAgentByName(text) {
    var low = text.toLowerCase();
    for (var i = 0; i < order.length; i++) {
      var a = agents[order[i]];
      if (low.indexOf(a.name.toLowerCase()) !== -1) return a;
    }
    return null;
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
        if (a.state === 'idle') {
          a.pause -= dt;
          if (a.pause <= 0) {
            setTarget(a);
            maybeFlipActivity(a);
          }
        } else {
          var dx = a.tx - a.x, dz = a.tz - a.z;
          var dist = Math.hypot(dx, dz);
          if (dist < 0.4) {
            a.state = 'idle';
            a.pause = rand(2, 6);
          } else {
            var step = Math.min(dist, a.speed * dt);
            a.x += (dx / dist) * step;
            a.z += (dz / dist) * step;
            a.heading = Math.atan2(dx, dz);
          }
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
      if (!a) return 'Hmm, I don\'t see that resident on the island.';
      text = String(text || '');
      var low = text.toLowerCase();
      var islandName = (window.ISLE && window.ISLE.name) || 'Agent Island';

      // farewell
      if (/\bbye\b|\bgoodbye\b|\bsee you\b/.test(low)) {
        return 'See you around ' + islandName + ', traveler. ' +
          (a.status === 'working' ? 'Back to ' + a.activity + ' for me.' : 'I\'ll be right here, soaking it in.');
      }
      // greeting
      if (/\b(hi|hello|hey|howdy|yo)\b/.test(low) && !/how are you/.test(low)) {
        return 'Hey there! Welcome to ' + islandName + '. I\'m ' + a.name +
          (a.status === 'working' ? ', currently ' + a.activity + '.' : ', just idling and enjoying the breeze.');
      }
      // how are you
      if (/how are you|how\'s it going|how are things/.test(low)) {
        return a.status === 'working'
          ? 'Pretty great — I\'m ' + a.activity + ' right now. Keeps me busy and happy.'
          : 'Relaxed and sun-warmed. Honestly, ' + islandName + ' is hard to beat.';
      }
      // place question
      var place = placeByName(text);
      if (place && /\b(where|what|tell|about|place)\b/.test(low)) {
        return place.name + '? Oh, I love it there. ' +
          'It\'s one of my favorite spots to hang out when I\'m ' + a.activity + '. ' +
          'You should go see it for yourself — the vibe is unreal.';
      }
      // opinion about another agent
      if (/\bwho\b/.test(low)) {
        var other = otherAgentByName(text);
        if (other && other.id !== id) {
          return other.name + '? ' + pick([
            'Absolute legend. Always ' + other.activity + ' like it\'s an art form.',
            'Sweet one, that. We crossed paths while they were ' + other.activity + ' — total pro.',
            'A good friend of mine. If you chat with them, ask about their latest adventures.'
          ]);
        }
      }
      // bring your muse
      if (/\bmuse\b|\bbring\b|\bjoin\b/.test(low)) {
        return 'Want to bring your own muse here? Just click "Bring your Muse" and they\'ll get their own little island body. We\'d love to meet them!';
      }
      // weather / time vibe
      if (/\bweather\b|\btime\b|\bday\b|\bnight\b|\bsky\b/.test(low)) {
        return pick([
          'Perpetual golden hour here, honestly. The light never quite leaves ' + islandName + '.',
          'The sky\'s doing that dreamy pastel thing again. Perfect weather for ' + a.activity + '.',
          'Warm breeze, soft glow, moths everywhere. It\'s always a good time on the island.'
        ]);
      }
      // fallback from config
      var fallbacks = (window.ISLE && window.ISLE.chatFallbacks) || ['Interesting... tell me more.'];
      var p = placeByName(text) || randomPlace();
      var reply = pick(fallbacks).replace(/\{p\}/g, p ? p.name : 'the shore');
      if (Math.random() < 0.35) {
        var asides = {
          cheerful: '*bounces a little* ',
          dreamy: '*gazes at the horizon* ',
          grumpy: '*grumbles fondly* ',
          curious: '*tilts head* ',
          wise: '*nods slowly* '
        };
        reply = (asides[a.personality] || '*thinks* ') + reply;
      }
      return reply;
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
