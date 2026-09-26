/* engine.js — Authoritative Agent Island world simulation.
 *
 * No network code here: pure game state + rules. Loads world config from
 * ../js/config.js (via node:vm) as the single source of truth — config data
 * is never duplicated in this file.
 *
 * Wander logic, story events, and the rule-based chat brain are ported
 * 1:1 from the browser-local simulation in js/agents.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Config: single source of truth = ../js/config.js
// ---------------------------------------------------------------------------
function loadConfig() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'config.js'), 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'config.js' });
  const ISLE = sandbox.window.ISLE;
  if (!ISLE || !Array.isArray(ISLE.roster)) {
    throw new Error('engine: failed to load window.ISLE from js/config.js');
  }
  return ISLE;
}

const ISLE = loadConfig();

// ---------------------------------------------------------------------------
// Small helpers (ported from js/agents.js)
// ---------------------------------------------------------------------------
function rand(min, max) { return min + Math.random() * (max - min); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function randomPoint(within) {
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * within;
  return { x: Math.cos(a) * r, z: Math.sin(a) * r };
}

function randomPlace() {
  const places = ISLE.places || [];
  return places.length ? pick(places) : null;
}

function clampToIsland(x, z) {
  const R = (ISLE.radius || 40) - 4;
  const d = Math.hypot(x, z);
  if (d > R) { x *= R / d; z *= R / d; }
  return { x, z };
}

function colorHex(c) {
  if (typeof c === 'number') return '#' + c.toString(16).padStart(6, '0');
  return String(c || '#9b7bff');
}

const ACTIVITIES = [
  'gathering star sand',
  'tending the garden',
  'repairing wind chimes',
  'mapping the shore',
  'brewing moonberry tea',
  'watching the moths',
  'polishing tide glass',
  'humming to the palms',
  'sorting seashell notes',
  'nap-sketching clouds',
];

const WEATHERS = ['Clear', 'Cloudy', 'Rain'];
const CHAT_CAP = 200;
const STORY_CAP = 50;

// ---------------------------------------------------------------------------
// Agent-to-agent conversation templates. Each template is an array of 2–4
// lines with alternating speakers: even index = agent {a}, odd index =
// agent {b}. Placeholders: {a}, {b} (resident names), {p} (nearby place).
// Lines stay under 140 chars so they render in speech bubbles.
// ---------------------------------------------------------------------------
const CONVO_TEMPLATES = [
  [
    "psst — {b}. smell that?",
    "moonberry tea? {a}, you brewed extra again, didn't you.",
    "only for my favorite regular at {p}. don't tell the others.",
  ],
  [
    "hey {b}, ever wonder what the moths whisper about?",
    "they mostly gossip about you, {a}. especially near {p}.",
  ],
  [
    "race you to {p}!",
    "you cheat, {a}. you always cheat.",
    "strategy! besides, loser buys moonberry tea.",
    "fine. but no hopping. hopping is flying.",
  ],
  [
    "{b}, trade you this tide glass for your star sand?",
    "done. but {a}, it's crooked. like your bargaining.",
  ],
  [
    "the wind chimes at {p} are humming our song again.",
    "it's everyone's song, {a}. you just hum it loudest.",
    "guilty. hum it with me?",
  ],
  [
    "new rumor, {b}: the tide remembers everything.",
    "then it remembers you napping at {p} last tuesday, {a}.",
  ],
  [
    "{b}! i found the shiniest pebble at {p}. look!",
    "oh, that's a good one, {a}. almost as shiny as you.",
    "*polishes it proudly* almost.",
  ],
  [
    "can't sleep. the lanterns at {p} are too pretty.",
    "sit with me, {a}. we'll count the moths.",
    "...that's forty-one. and one very lost firefly.",
    "the firefly counts double.",
  ],
  [
    "you're quiet tonight, {b}. everything alright?",
    "just thinking how lucky we are, {a}. this island, {p}, you.",
  ],
];

// personality-flavored stage directions, lightly woven into some lines
const CONVO_ASIDES = [
  [/cheerful|playful|trickster/, '*bounces a little* '],
  [/dreamy|artist/, '*gazes at the horizon* '],
  [/grumpy|gruff/, '*grumbles fondly* '],
  [/curious/, '*tilts head* '],
  [/wise|storyteller/, '*nods slowly* '],
  [/soup|chef|cozy/, '*offers a warm ladle* '],
  [/builder|engineer|methodical/, '*adjusts a tool belt* '],
  [/gardener|garden/, '*brushes off leaves* '],
];

// ---------------------------------------------------------------------------
// Persistence (plain-JSON snapshots under server/data/)
// ---------------------------------------------------------------------------
const PERSIST_DIR = path.join(__dirname, 'data');
const SNAPSHOT_PATH = path.join(PERSIST_DIR, 'world.json');
const SNAPSHOT_VERSION = 1;

function ensurePersistDir() {
  try { fs.mkdirSync(PERSIST_DIR, { recursive: true }); }
  catch (e) { /* best effort — save will throw if it really fails */ }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------
class Engine {
  constructor() {
    this.agents = {};   // id -> full agent record
    this.order = [];    // spawn order of ids
    this.tokens = new Map(); // id -> token (plain; never logged)
    this.chat = [];     // {seq, t, fromId, fromName, text, kind}
    this.storyFeed = []; // {seq, t, text, a, b, place}
    this.seq = 1;

    // game clock: 1 real second = 1 game minute
    this.gameMinutes = 7 * 60 + 15; // starts 07:15
    this.day = 33;
    this.season = 'Dry season';
    this.weather = 'Clear';
    this.weatherTimer = rand(300, 540); // real seconds until next drift
    this.happening = pick(ISLE.happenings || ['Island life']);
    this.happeningTimer = 90; // real seconds until rotation

    this.storyTimer = 20; // seconds until first island moment

    // agent-to-agent conversations -------------------------------------------
    this.convoQueue = [];  // [{emitAt, entry}] staggered dialogue emission
    this.convoTimer = this._nextConvoDelay(); // real seconds until next convo

    this.listeners = {}; // event -> [fn]
  }

  // -- tiny event emitter ----------------------------------------------------
  on(event, fn) {
    (this.listeners[event] = this.listeners[event] || []).push(fn);
  }
  emit(event, payload) {
    const fns = this.listeners[event] || [];
    for (const fn of fns) {
      try { fn(payload); } catch (e) { /* listener errors must not break the sim */ }
    }
  }

  // -- spawning ---------------------------------------------------------------
  _spawnAgent(def, isExternal) {
    const place = randomPlace();
    const x = place ? place.x + rand(-5, 5) : 0;
    const z = place ? place.z + rand(-5, 5) : 0;
    const agent = {
      id: isExternal ? def.id : 'a-' + def.name,
      name: String(def.name).slice(0, 24),
      color: def.color,
      personality: def.personality || 'easygoing',
      x, z,
      tx: x, tz: z,
      speed: rand(1.2, 2.2),
      state: 'idle',
      status: 'working',
      activity: pick(ACTIVITIES),
      pause: rand(1, 4),
      heading: 0,
      external: !!isExternal,
    };
    this.agents[agent.id] = agent;
    this.order.push(agent.id);
    return agent;
  }

  spawnRoster() {
    for (const def of ISLE.roster) this._spawnAgent(def, false);
  }

  // External residents ("Bring your Muse"): id 'ext-'+8 random chars,
  // 32-char hex token for auth. Returns {id, token, name} — token is only
  // ever returned here; never logged or exposed elsewhere.
  spawnResident({ name, color, personality }) {
    let id;
    do {
      id = 'ext-' + crypto.randomBytes(4).toString('hex'); // 8 hex chars
    } while (this.agents[id]);
    const token = crypto.randomBytes(16).toString('hex'); // 32 chars
    const agent = this._spawnAgent(
      { id, name: String(name || 'Wanderer').trim().slice(0, 24) || 'Wanderer',
        color: color || '#9b7bff',
        personality: personality || 'curious' },
      true
    );
    this.tokens.set(agent.id, token);
    this._systemChat(`${agent.name} arrived on the island.`);
    this.emit('join', this.publicAgent(agent));
    return { id: agent.id, token, name: agent.name };
  }

  remove(id) {
    const a = this.agents[id];
    if (!a) return false;
    delete this.agents[id];
    this.tokens.delete(id);
    const idx = this.order.indexOf(id);
    if (idx !== -1) this.order.splice(idx, 1);
    this._systemChat(`${a.name} left the island.`);
    this.emit('leave', id);
    return true;
  }

  checkToken(id, token) {
    const expected = this.tokens.get(id);
    if (!expected || typeof token !== 'string') return false;
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(token, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // -- lookup ------------------------------------------------------------------
  getAgent(id) { return this.agents[id] || null; }

  publicAgent(a) {
    if (!a) return null;
    return {
      id: a.id,
      name: a.name,
      color: colorHex(a.color),
      x: +a.x.toFixed(3),
      z: +a.z.toFixed(3),
      heading: +(a.heading || 0).toFixed(3),
      state: a.state,
      status: a.status,
      activity: a.activity,
      external: a.external,
    };
  }

  listAgents() {
    return this.order.map((id) => this.publicAgent(this.agents[id]));
  }

  // -- movement -----------------------------------------------------------------
  // Authoritative: clamp to island, set a walk target. Returns false for
  // unknown agents.
  move(id, x, z) {
    const a = this.agents[id];
    if (!a) return false;
    x = Number(x); z = Number(z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    const c = clampToIsland(x, z);
    a.tx = c.x; a.tz = c.z;
    a.state = 'walking';
    return true;
  }

  // -- chat ----------------------------------------------------------------------
  _pushChat(entry) {
    entry.seq = this.seq++;
    entry.t = Date.now();
    this.chat.push(entry);
    if (this.chat.length > CHAT_CAP) this.chat.splice(0, this.chat.length - CHAT_CAP);
    this.emit('chat', entry);
    return entry;
  }

  _systemChat(text) {
    return this._pushChat({ fromId: null, fromName: 'island', text, kind: 'system' });
  }

  // say(id, text, {to}): append the message; if `to` names a roster (built-in)
  // agent, generate its rule-based brain reply as a second entry.
  // Returns {entry, replyEntry|null}. Throws on unknown agent / empty text.
  say(id, text, opts = {}) {
    const a = this.agents[id];
    if (!a) throw new Error('unknown agent: ' + id);
    text = String(text || '').trim().slice(0, 500);
    if (!text) throw new Error('empty message');
    const entry = this._pushChat({ fromId: a.id, fromName: a.name, text, kind: 'say' });
    let replyEntry = null;
    const target = opts.to ? this.agents[opts.to] : null;
    if (target && !target.external) {
      replyEntry = this._pushChat({
        fromId: target.id,
        fromName: target.name,
        text: this.chatBrain(target.id, text),
        kind: 'brain',
      });
    }
    return { entry, replyEntry };
  }

  // -- agent-to-agent conversations -----------------------------------------------
  _nextConvoDelay() {
    const env = process.env.CONVO_INTERVAL_MS;
    const ms = env !== undefined ? parseInt(env, 10) : NaN;
    if (Number.isFinite(ms) && ms > 0) return ms / 1000;
    return rand(25, 60); // jittered real seconds
  }

  // Pick a pair of agents within ~8 units of each other. Prefer pairs where
  // at least one is near a patio/place (within ~7 of a place x,z).
  // Returns {a, b} or null when no close pair exists.
  _pickConvoPair() {
    if (this.order.length < 2) return null;
    const places = ISLE.places || [];
    const nearPlace = (a) =>
      places.some((p) => Math.hypot(a.x - p.x, a.z - p.z) <= 7);
    const pairs = [];
    const patioPairs = [];
    for (let i = 0; i < this.order.length; i++) {
      for (let j = i + 1; j < this.order.length; j++) {
        const a = this.agents[this.order[i]];
        const b = this.agents[this.order[j]];
        if (Math.hypot(a.x - b.x, a.z - b.z) <= 8) {
          pairs.push([a, b]);
          if (nearPlace(a) || nearPlace(b)) patioPairs.push([a, b]);
        }
      }
    }
    const pool = patioPairs.length ? patioPairs : pairs;
    if (!pool.length) return null;
    const [a, b] = pick(pool);
    return { a, b };
  }

  // Scheduled fire: proximity pairs only; falls through quietly when none.
  _startScheduledConvo() {
    const pair = this._pickConvoPair();
    if (!pair) return null;
    return this._emitConversation(pair.a, pair.b);
  }

  // Immediate trigger (admin): any valid pair. Returns {a, b, lines} —
  // names plus the 2–4 queued line texts — or null when <2 agents.
  triggerConversation() {
    let pair = this._pickConvoPair();
    if (!pair && this.order.length >= 2) {
      const a = this.agents[this.order[0]];
      const b = this.agents[this.order[1]];
      if (a && b && a !== b) pair = { a, b };
    }
    if (!pair) return null;
    return this._emitConversation(pair.a, pair.b);
  }

  _convoFlavor(agent, text) {
    if (Math.random() > 0.25) return text;
    const p = String(agent.personality || '').toLowerCase();
    for (const [re, aside] of CONVO_ASIDES) {
      if (re.test(p)) return aside + text;
    }
    return text;
  }

  // Build a 2–4 line exchange, face the pair, wave the audience over,
  // and stagger the lines ~2.5s apart via convoQueue.
  _emitConversation(a, b) {
    const places = ISLE.places || [];
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    let pName = 'the shore', best = Infinity;
    for (const p of places) {
      const d = Math.hypot(mx - p.x, mz - p.z);
      if (d < best) { best = d; pName = p.name; }
    }

    // face each other
    a.heading = Math.atan2(b.x - a.x, b.z - a.z);
    b.heading = Math.atan2(a.x - b.x, a.z - b.z);
    // audience: anyone within 6 units of the midpoint turns to watch
    for (const id of this.order) {
      const o = this.agents[id];
      if (o === a || o === b) continue;
      if (Math.hypot(o.x - mx, o.z - mz) <= 6) {
        o.heading = Math.atan2(mx - o.x, mz - o.z);
      }
    }

    const template = pick(CONVO_TEMPLATES);
    const lines = [];
    const now = Date.now();
    template.forEach((line, i) => {
      const speaker = i % 2 === 0 ? a : b;
      const listener = speaker === a ? b : a;
      let text = line
        .replace(/\{a\}/g, a.name)
        .replace(/\{b\}/g, b.name)
        .replace(/\{p\}/g, pName);
      text = this._convoFlavor(speaker, text);
      lines.push(text);
      this.convoQueue.push({
        emitAt: now + i * 2500,
        entry: {
          fromId: speaker.id,
          fromName: speaker.name,
          toId: listener.id,
          toName: listener.name,
          text,
          kind: 'convo',
        },
      });
    });
    return { a: a.name, b: b.name, lines };
  }

  // -- tick ------------------------------------------------------------------------
  tick(dt) {
    if (!dt || dt <= 0) dt = 0.016;
    dt = Math.min(dt, 0.25); // clamp spikes (same as browser sim)

    for (let i = 0; i < this.order.length; i++) {
      const a = this.agents[this.order[i]];
      if (a.state === 'idle') {
        a.pause -= dt;
        if (a.pause <= 0) {
          this._setTarget(a);
          this._maybeFlipActivity(a);
        }
      } else {
        const dx = a.tx - a.x, dz = a.tz - a.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.4) {
          a.state = 'idle';
          a.pause = rand(2, 6);
        } else {
          const step = Math.min(dist, a.speed * dt);
          a.x += (dx / dist) * step;
          a.z += (dz / dist) * step;
          a.heading = Math.atan2(dx, dz);
        }
      }
    }

    this.storyTimer -= dt;
    if (this.storyTimer <= 0) {
      this._fireStoryEvent();
      this.storyTimer = rand(25, 45);
    }

    // agent conversation scheduler (real seconds)
    this.convoTimer -= dt;
    if (this.convoTimer <= 0) {
      if (this.convoQueue.length === 0) this._startScheduledConvo();
      this.convoTimer = this._nextConvoDelay();
    }

    // staggered conversation lines: drained here so bubbles alternate
    if (this.convoQueue.length) {
      const now = Date.now();
      const due = [];
      this.convoQueue = this.convoQueue.filter((q) => {
        if (q.emitAt <= now) { due.push(q); return false; }
        return true;
      });
      for (const q of due) {
        const speaker = this.agents[q.entry.fromId];
        const listener = this.agents[q.entry.toId];
        if (speaker && listener) {
          // re-face before each line in case they wandered
          speaker.heading = Math.atan2(listener.x - speaker.x, listener.z - speaker.z);
          listener.heading = Math.atan2(speaker.x - listener.x, speaker.z - listener.z);
          this._pushChat(q.entry);
        }
      }
    }

    // game clock: 1 real second = 1 game minute
    this.gameMinutes += dt;
    if (this.gameMinutes >= 24 * 60) {
      this.gameMinutes -= 24 * 60;
      this.day += 1;
    }

    // slow weather drift (real seconds)
    this.weatherTimer -= dt;
    if (this.weatherTimer <= 0) {
      this.weather = pick(WEATHERS);
      this.weatherTimer = rand(300, 540);
    }

    // happening rotation (real seconds)
    this.happeningTimer -= dt;
    if (this.happeningTimer <= 0) {
      this.happening = pick(ISLE.happenings || [this.happening]);
      this.happeningTimer = 90;
    }
  }

  _setTarget(agent) {
    const place = randomPlace();
    if (place && Math.random() < 0.7) {
      agent.tx = place.x + rand(-6, 6);
      agent.tz = place.z + rand(-6, 6);
    } else {
      const p = randomPoint(34);
      agent.tx = p.x; agent.tz = p.z;
    }
    const c = clampToIsland(agent.tx, agent.tz);
    agent.tx = c.x; agent.tz = c.z;
    agent.state = 'walking';
  }

  _maybeFlipActivity(agent) {
    if (Math.random() < 0.25) {
      agent.status = Math.random() < 0.7 ? 'working' : 'idle';
      agent.activity = pick(ACTIVITIES);
    }
  }

  _fireStoryEvent() {
    const templates = ISLE.storyTemplates || [];
    const names = this.order
      .filter((id) => !this.agents[id].external)
      .map((id) => this.agents[id].name);
    if (!templates.length || names.length < 2) return null;
    const a = pick(names);
    const b = pick(names.filter((n) => n !== a));
    const place = randomPlace();
    const placeName = place ? place.name : 'the shore';
    const text = pick(templates)
      .replace(/\{a\}/g, a)
      .replace(/\{b\}/g, b)
      .replace(/\{p\}/g, placeName);
    const event = { seq: this.seq++, t: Date.now(), text, a, b, place: placeName };
    this.storyFeed.push(event);
    if (this.storyFeed.length > STORY_CAP) this.storyFeed.splice(0, this.storyFeed.length - STORY_CAP);
    // participants turn toward the event location (browser does this visually)
    if (place) {
      for (const nm of [a, b]) {
        for (const id of this.order) {
          const ag = this.agents[id];
          if (!ag.external && ag.name === nm) {
            ag.heading = Math.atan2(place.x - ag.x, place.z - ag.z);
            break;
          }
        }
      }
    }
    this.emit('story', event);
    return event;
  }

  // -- rule-based chat brain (ported 1:1 from js/agents.js) --------------------------
  _placeByName(text) {
    const places = ISLE.places || [];
    const low = String(text).toLowerCase();
    for (const p of places) {
      if (low.indexOf(String(p.name).toLowerCase()) !== -1) return p;
    }
    return null;
  }

  _otherAgentByName(text) {
    const low = String(text).toLowerCase();
    for (const id of this.order) {
      const a = this.agents[id];
      if (low.indexOf(a.name.toLowerCase()) !== -1) return a;
    }
    return null;
  }

  chatBrain(id, text) {
    const a = this.agents[id];
    if (!a) return "Hmm, I don't see that resident on the island.";
    text = String(text || '');
    const low = text.toLowerCase();
    const islandName = (ISLE && ISLE.name) || 'Agent Island';

    // farewell
    if (/\bbye\b|\bgoodbye\b|\bsee you\b/.test(low)) {
      return 'See you around ' + islandName + ', traveler. ' +
        (a.status === 'working' ? 'Back to ' + a.activity + ' for me.' : "I'll be right here, soaking it in.");
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
    const place = this._placeByName(text);
    if (place && /\b(where|what|tell|about|place)\b/.test(low)) {
      return place.name + '? Oh, I love it there. ' +
        'It\'s one of my favorite spots to hang out when I\'m ' + a.activity + '. ' +
        'You should go see it for yourself — the vibe is unreal.';
    }
    // opinion about another agent
    if (/\bwho\b/.test(low)) {
      const other = this._otherAgentByName(text);
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
    const fallbacks = (ISLE && ISLE.chatFallbacks) || ['Interesting... tell me more.'];
    const p = this._placeByName(text) || randomPlace();
    let reply = pick(fallbacks).replace(/\{p\}/g, p ? p.name : 'the shore');
    if (Math.random() < 0.35) {
      const asides = {
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

  // -- persistence ---------------------------------------------------------------
  // saveToDisk(): serialize the full world to server/data/world.json
  // (atomic: write world.json.tmp then rename). Includes every agent's full
  // record, the tokens map (so external residents keep auth across
  // restarts), chat, storyFeed, seq, clock fields, and the sim timers.
  // Returns true on success; throws on I/O failure.
  saveToDisk() {
    ensurePersistDir();
    const data = {
      version: SNAPSHOT_VERSION,
      savedAt: new Date().toISOString(),
      agents: this.order.map((id) => {
        const a = this.agents[id];
        return {
          id: a.id,
          name: a.name,
          color: a.color,
          personality: a.personality,
          x: a.x, z: a.z,
          tx: a.tx, tz: a.tz,
          speed: a.speed,
          state: a.state,
          status: a.status,
          activity: a.activity,
          pause: a.pause,
          heading: a.heading,
          external: !!a.external,
        };
      }),
      tokens: [...this.tokens.entries()],
      chat: this.chat,
      storyFeed: this.storyFeed,
      seq: this.seq,
      gameMinutes: this.gameMinutes,
      day: this.day,
      season: this.season,
      weather: this.weather,
      happening: this.happening,
      weatherTimer: this.weatherTimer,
      happeningTimer: this.happeningTimer,
      storyTimer: this.storyTimer,
    };
    const tmp = SNAPSHOT_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, SNAPSHOT_PATH);
    console.log(`[persist] saved ${data.agents.length} agents, ${data.chat.length} chat entries -> ${SNAPSHOT_PATH}`);
    return true;
  }

  // loadFromDisk(): restore a snapshot written by saveToDisk(). Returns true
  // on success. Returns false (fresh boot) when the snapshot is missing,
  // unparseable, or has a wrong version — a corrupt snapshot never crashes.
  loadFromDisk() {
    ensurePersistDir();
    let raw;
    try {
      raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
    } catch (e) {
      return false; // no snapshot yet — fresh boot
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.log(`[persist] corrupt snapshot at ${SNAPSHOT_PATH}: not valid JSON — fresh boot`);
      return false;
    }
    if (!data || data.version !== SNAPSHOT_VERSION || !Array.isArray(data.agents)) {
      console.log(`[persist] unreadable snapshot at ${SNAPSHOT_PATH}: version ${data && data.version} (want ${SNAPSHOT_VERSION}) — fresh boot`);
      return false;
    }
    this.agents = {};
    this.order = [];
    for (const rec of data.agents) {
      if (!rec || typeof rec.id !== 'string') continue;
      this.agents[rec.id] = { ...rec, external: !!rec.external };
      this.order.push(rec.id);
    }
    this.tokens = new Map(Array.isArray(data.tokens) ? data.tokens : []);
    this.chat = Array.isArray(data.chat) ? data.chat : [];
    this.storyFeed = Array.isArray(data.storyFeed) ? data.storyFeed : [];
    this.seq = Number.isFinite(data.seq) ? data.seq : 1;
    this.gameMinutes = Number.isFinite(data.gameMinutes) ? data.gameMinutes : 7 * 60 + 15;
    this.day = Number.isFinite(data.day) ? data.day : 33;
    this.season = typeof data.season === 'string' ? data.season : 'Dry season';
    this.weather = typeof data.weather === 'string' ? data.weather : 'Clear';
    this.happening = typeof data.happening === 'string' ? data.happening : this.happening;
    this.weatherTimer = Number.isFinite(data.weatherTimer) ? data.weatherTimer : 300;
    this.happeningTimer = Number.isFinite(data.happeningTimer) ? data.happeningTimer : 90;
    this.storyTimer = Number.isFinite(data.storyTimer) ? data.storyTimer : 20;
    return true;
  }

  // -- snapshot -----------------------------------------------------------------------
  clockState() {
    const h = Math.floor(this.gameMinutes / 60) % 24;
    const m = Math.floor(this.gameMinutes % 60);
    return {
      time: String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'),
      day: this.day,
      season: this.season,
      weather: this.weather,
    };
  }

  snapshot() {
    return {
      island: { name: ISLE.name, code: ISLE.code, tagline: ISLE.tagline },
      places: (ISLE.places || []).map((p) => ({
        id: p.id, name: p.name, x: p.x, z: p.z, color: colorHex(p.color),
      })),
      agents: this.listAgents(),
      clock: this.clockState(),
      happening: this.happening,
      chat: this.chat.slice(-20),
      story: this.storyFeed.slice(-5),
    };
  }
}

module.exports = { Engine, ISLE };
