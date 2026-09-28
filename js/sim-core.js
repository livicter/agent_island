/* sim-core.js — wander step + chat brain shared by the browser and the server.
 *
 * Browser: <script> sets window.IsleSim.
 * Node: require('../js/sim-core') (or this file's module.exports).
 * Story events, networking, and meshes stay in the host. This file is the
 * only implementation of a resident step and a template reply.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IsleSim = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
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

  function rand(min, max) { return min + Math.random() * (max - min); }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function randomPoint(within) {
    var a = Math.random() * Math.PI * 2;
    var r = Math.sqrt(Math.random()) * within;
    return { x: Math.cos(a) * r, z: Math.sin(a) * r };
  }

  function setTarget(agent, places, radius) {
    var place = places.length ? pick(places) : null;
    if (place && Math.random() < 0.7) {
      agent.tx = place.x + rand(-6, 6);
      agent.tz = place.z + rand(-6, 6);
    } else {
      var p = randomPoint(34);
      agent.tx = p.x;
      agent.tz = p.z;
    }
    var R = (radius || 40) - 4;
    var d = Math.hypot(agent.tx, agent.tz);
    if (d > R) { agent.tx *= R / d; agent.tz *= R / d; }
    agent.state = 'walking';
  }

  // One resident for one dt. Same rules the browser loop and engine.tick used
  // to each keep a copy of. Returns { activityChanged }.
  function stepAgent(agent, dt, env) {
    env = env || {};
    var places = env.places || [];
    var radius = env.radius || 40;
    var activityChanged = false;
    if (agent.state === 'idle') {
      agent.pause -= dt;
      if (agent.pause <= 0) {
        setTarget(agent, places, radius);
        if (Math.random() < 0.25) {
          agent.status = Math.random() < 0.7 ? 'working' : 'idle';
          agent.activity = pick(ACTIVITIES);
          activityChanged = true;
        }
      }
    } else {
      var dx = agent.tx - agent.x;
      var dz = agent.tz - agent.z;
      var dist = Math.hypot(dx, dz);
      if (dist < 0.4) {
        agent.state = 'idle';
        agent.pause = rand(2, 6);
      } else {
        var step = Math.min(dist, agent.speed * dt);
        agent.x += (dx / dist) * step;
        agent.z += (dz / dist) * step;
        agent.heading = Math.atan2(dx, dz);
      }
    }
    return { activityChanged: activityChanged };
  }

  function chatReply(ctx) {
    ctx = ctx || {};
    var a = ctx.agent;
    if (!a) return 'Hmm, I don\'t see that resident on the island.';
    var text = String(ctx.text || '');
    var low = text.toLowerCase();
    var islandName = ctx.islandName || 'Agent Island';
    var places = ctx.places || [];
    var others = ctx.others || [];
    var fallbacks = (ctx.fallbacks && ctx.fallbacks.length) ? ctx.fallbacks : ['Interesting... tell me more.'];

    function placeByName(t) {
      var l = String(t).toLowerCase();
      for (var i = 0; i < places.length; i++) {
        if (l.indexOf(String(places[i].name).toLowerCase()) !== -1) return places[i];
      }
      return null;
    }
    function otherByName(t) {
      var l = String(t).toLowerCase();
      for (var i = 0; i < others.length; i++) {
        if (others[i] && l.indexOf(String(others[i].name).toLowerCase()) !== -1) return others[i];
      }
      return null;
    }
    function randomPlace() {
      return places.length ? pick(places) : null;
    }

    if (/\bbye\b|\bgoodbye\b|\bsee you\b/.test(low)) {
      return 'See you around ' + islandName + ', traveler. ' +
        (a.status === 'working' ? 'Back to ' + a.activity + ' for me.' : 'I\'ll be right here, soaking it in.');
    }
    if (/\b(hi|hello|hey|howdy|yo)\b/.test(low) && !/how are you/.test(low)) {
      return 'Hey there! Welcome to ' + islandName + '. I\'m ' + a.name +
        (a.status === 'working' ? ', currently ' + a.activity + '.' : ', just idling and enjoying the breeze.');
    }
    if (/how are you|how\'s it going|how are things/.test(low)) {
      return a.status === 'working'
        ? 'Pretty great — I\'m ' + a.activity + ' right now. Keeps me busy and happy.'
        : 'Relaxed and sun-warmed. Honestly, ' + islandName + ' is hard to beat.';
    }
    var place = placeByName(text);
    if (place && /\b(where|what|tell|about|place)\b/.test(low)) {
      return place.name + '? Oh, I love it there. ' +
        'It\'s one of my favorite spots to hang out when I\'m ' + a.activity + '. ' +
        'You should go see it for yourself — the vibe is unreal.';
    }
    if (/\bwho\b/.test(low)) {
      var other = otherByName(text);
      if (other && other.id !== a.id) {
        return other.name + '? ' + pick([
          'Absolute legend. Always ' + other.activity + ' like it\'s an art form.',
          'Sweet one, that. We crossed paths while they were ' + other.activity + ' — total pro.',
          'A good friend of mine. If you chat with them, ask about their latest adventures.'
        ]);
      }
    }
    if (/\bmuse\b|\bbring\b|\bjoin\b/.test(low)) {
      return 'Want to bring your own muse here? Just click "Bring your Muse" and they\'ll get their own little island body. We\'d love to meet them!';
    }
    if (/\bweather\b|\btime\b|\bday\b|\bnight\b|\bsky\b/.test(low)) {
      return pick([
        'Perpetual golden hour here, honestly. The light never quite leaves ' + islandName + '.',
        'The sky\'s doing that dreamy pastel thing again. Perfect weather for ' + a.activity + '.',
        'Warm breeze, soft glow, moths everywhere. It\'s always a good time on the island.'
      ]);
    }
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
  }

  return {
    ACTIVITIES: ACTIVITIES,
    stepAgent: stepAgent,
    chatReply: chatReply
  };
});
