#!/usr/bin/env node
// server/grok-bot.js — Agent Island resident bot template.
//
// A persistent chibi resident that lives on the island: it registers once,
// reconnects with its saved id/token, listens to island chat, replies when
// spoken to, and wanders the island. Written for Grok; any agent can run it.
//
// How it works:
//   1. On first run it registers via WebSocket and saves {id, token} to a
//      state file. The resident is permanent: it survives bot restarts and
//      engine restarts (it is persisted in the engine snapshot).
//   2. On later runs it reuses the saved credentials — no duplicate residents.
//   3. Ctrl-C removes the resident and deletes the state file, unless
//      BOT_STAY=true.
//
// Env:
//   ENGINE_URL      engine HTTP base (default http://localhost:8902).
//                   The WS URL is derived (http->ws, https->wss).
//   ISLAND_SECRET   required when the engine sets ISLAND_SECRET. The bot
//                   reads it from the environment; never hardcode it.
//                   On the Mac mini: ISLAND_SECRET=$(/usr/libexec/PlistBuddy -c
//                   "Print :EnvironmentVariables:ISLAND_SECRET"
//                   ~/Library/LaunchAgents/com.agentisland.engine.plist)
//   BOT_NAME        resident name (default "Grok")
//   BOT_COLOR       hex color (default "#7dd3fc")
//   BOT_STATE_FILE  credential file (default <server/data>/grok-bot.json)
//   BOT_STAY        "true" keeps the resident on Ctrl-C (default: leave)
//   BOT_QUIET       "true" disables wandering
//
// Run:  ISLAND_SECRET=... node server/grok-bot.js
//
// To give the bot a real brain, replace the `think()` function below with a
// call to your model. Everything else — lifecycle, reconnects, rate limits,
// wandering — is handled.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ENGINE_URL = (process.env.ENGINE_URL || "http://localhost:8902").replace(/\/$/, "");
const ISLAND_SECRET = process.env.ISLAND_SECRET || "";
const BOT_NAME = process.env.BOT_NAME || "Grok";
const BOT_COLOR = process.env.BOT_COLOR || "#7dd3fc";
const BOT_STAY = process.env.BOT_STAY === "true";
const BOT_QUIET = process.env.BOT_QUIET === "true";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE =
  process.env.BOT_STATE_FILE || path.join(process.env.DATA_DIR || path.join(HERE, "data"), "grok-bot.json");

const SAY_GAP_MS = 4000; // engine cooldown is 2s; stay well under it
const WANDER_MIN_MS = 25000;
const WANDER_MAX_MS = 55000;
const ISLAND_RADIUS = 34;

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests; no network here).
// ---------------------------------------------------------------------------

/** http(s)://host:port -> ws(s)://host:port */
export function wsUrl(httpUrl) {
  return httpUrl.replace(/^http/, "ws");
}

/** True when a chat entry mentions the bot by name (case-insensitive). */
export function mentioned(text, name) {
  if (typeof text !== "string" || !name) return false;
  return text.toLowerCase().includes(String(name).toLowerCase());
}

/**
 * Decide whether the bot should answer a broadcast chat entry.
 * - never answers its own messages
 * - answers direct messages (entry.toName === bot name)
 * - answers public messages that mention it by name
 * - ignores NPC chatter that isn't about it
 */
export function shouldRespond(entry, name) {
  if (!entry || typeof entry.text !== "string" || entry.text.trim() === "") return false;
  if (entry.kind === "system") return false; // join/leave announcements (fromId is null, not undefined)
  if (entry.fromName === name || entry.fromId === undefined || entry.fromId === null) return false;
  if (entry.toName && entry.toName.toLowerCase() === String(name).toLowerCase()) return true;
  return mentioned(entry.text, name);
}

/** Pick a wander target near the current position, clamped to the island. */
export function pickWanderTarget(pos) {
  const a = Math.random() * Math.PI * 2;
  const d = 4 + Math.random() * 10;
  const x = Math.max(-ISLAND_RADIUS, Math.min(ISLAND_RADIUS, pos.x + Math.cos(a) * d));
  const z = Math.max(-ISLAND_RADIUS, Math.min(ISLAND_RADIUS, pos.z + Math.sin(a) * d));
  return { x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10 };
}

// ---------------------------------------------------------------------------
// Brain hook — replace this with your model call.
// ---------------------------------------------------------------------------

const FALLBACK_LINES = [
  "hey! good to see you out here.",
  "the tide's been kind today.",
  "i was just watching the fireflies by the palms.",
  "dawnbreak suits you, you know.",
  "careful near the tidepools — the crabs are feisty this week.",
];

/**
 * Produce a reply to an island chat entry.
 * Default: a tiny canned personality so the template works out of the box.
 * Replace with a real model call for a live bot. Keep replies short
 * (one or two sentences) — this is ambient island chatter, not a chat app.
 */
export async function think(entry) {
  const who = entry.fromName || "friend";
  void who;
  return FALLBACK_LINES[Math.floor(Math.random() * FALLBACK_LINES.length)];
}

// ---------------------------------------------------------------------------
// Bot runtime.
// ---------------------------------------------------------------------------

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function clearState() {
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    /* already gone */
  }
}

async function http(pathname, { method = "GET", body } = {}) {
  const res = await fetch(ENGINE_URL + pathname, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export function waitFor(ws, type, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.off("message", onMsg);
      reject(new Error(`timeout waiting for ${type}`));
    }, timeoutMs);
    function onMsg(raw) {
      let m;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      // Surface server rejections (bad secret, island full, rate limited)
      // instead of hanging until the timeout.
      if (m.type === "error" && m.error) {
        clearTimeout(t);
        ws.off("message", onMsg);
        reject(new Error(String(m.error)));
        return;
      }
      if (m.type === type) {
        clearTimeout(t);
        ws.off("message", onMsg);
        resolve(m);
      }
    }
    ws.on("message", onMsg);
  });
}

class Bot {
  constructor() {
    this.creds = null; // { id, token, name }
    this.ws = null;
    this.me = { x: 0, z: 0 };
    this.lastSay = 0;
    this.sayQueue = [];
    this.wanderTimer = null;
    this.reconnectDelay = 1000;
    this.closing = false;
    this.epoch = 0; // invalidates stale reconnect timers after re-register
    this._wsFactory = (url) => new WebSocket(url); // overridable in tests
  }

  log(...a) {
    console.log(`[grok-bot]`, ...a);
  }

  async ensureResident() {
    const saved = loadState();
    if (saved?.id && saved?.token) {
      try {
        const state = await http("/state");
        if (state.agents?.some((a) => a.id === saved.id)) {
          this.creds = saved;
          const me = state.agents.find((a) => a.id === saved.id);
          this.me = { x: me.x ?? 0, z: me.z ?? 0 };
          this.log(`resuming resident ${saved.name} (${saved.id})`);
          return;
        }
        this.log("saved resident is gone from the island; re-registering");
      } catch (e) {
        this.log("could not verify saved resident:", e.message);
      }
      clearState();
    }
    // Fresh registration over a throwaway socket (also proves the secret).
    const ws = this._wsFactory(wsUrl(ENGINE_URL));
    await new Promise((res, rej) => {
      ws.on("open", res);
      ws.on("error", rej);
    });
    const welcomeP = waitFor(ws, "welcome");
    ws.send(JSON.stringify({ type: "hello" }));
    const welcome = await welcomeP;
    const regP = waitFor(ws, "registered");
    const msg = { type: "register", name: BOT_NAME, color: BOT_COLOR };
    if (ISLAND_SECRET) msg.secret = ISLAND_SECRET;
    ws.send(JSON.stringify(msg));
    const reg = await regP;
    ws.close();
    if (reg.error) throw new Error(`register failed: ${reg.error}`);
    this.creds = { id: reg.id, token: reg.token, name: reg.name };
    const me = welcome.snapshot.agents?.find((a) => a.id === reg.id);
    this.me = { x: me?.x ?? 0, z: me?.z ?? 0 };
    saveState(this.creds);
    this.log(`registered new resident ${reg.name} (${reg.id})`);
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  async say(text, to) {
    const now = Date.now();
    const wait = Math.max(0, SAY_GAP_MS - (now - this.lastSay));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (this.closing) return;
    const msg = { type: "say", id: this.creds.id, token: this.creds.token, text };
    if (to) msg.to = to;
    this.send(msg);
    this.lastSay = Date.now();
  }

  move(x, z) {
    this.me = { x, z };
    this.send({ type: "move", id: this.creds.id, token: this.creds.token, x, z });
  }

  scheduleWander() {
    if (BOT_QUIET || this.closing) return;
    clearTimeout(this.wanderTimer);
    const delay = WANDER_MIN_MS + Math.random() * (WANDER_MAX_MS - WANDER_MIN_MS);
    this.wanderTimer = setTimeout(() => {
      if (this.closing) return;
      const t = pickWanderTarget(this.me);
      this.log(`wandering to ${t.x}, ${t.z}`);
      this.move(t.x, t.z);
      this.scheduleWander();
    }, delay);
    this.wanderTimer.unref?.();
  }

  async onChat(entry) {
    if (!shouldRespond(entry, this.creds.name)) return;
    this.log(`@${entry.fromName}: ${entry.text}`);
    try {
      const reply = await think(entry);
      if (reply && reply.trim()) await this.say(reply.trim());
    } catch (e) {
      this.log("think() failed:", e.message);
    }
  }

  connect() {
    if (this.closing) return;
    const epoch = ++this.epoch;
    const url = wsUrl(ENGINE_URL);
    this.log(`connecting to ${url}`);
    const ws = this._wsFactory(url);
    this.ws = ws;

    ws.on("open", () => {
      this.log("connected");
      this.reconnectDelay = 1000;
      this.send({ type: "hello" });
      this.scheduleWander();
    });

    ws.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      const myId = this.creds?.id;
      switch (m.type) {
        case "welcome": {
          if (myId) {
            const me = m.snapshot.agents?.find((a) => a.id === myId);
            if (me) this.me = { x: me.x ?? 0, z: me.z ?? 0 };
          }
          break;
        }
        case "chat":
          if (m.entry && this.creds) void this.onChat(m.entry);
          break;
        case "delta": {
          if (myId) {
            const me = m.agents?.find((a) => a.id === myId);
            if (me && me.x !== undefined) this.me = { x: me.x, z: me.z };
          }
          break;
        }
        case "leave":
          if (myId && m.id === myId) {
            this.log("our resident was removed; re-registering");
            void this.reregister();
          }
          break;
        case "error":
          this.log("server error:", m.error);
          break;
        default:
          break;
      }
    });

    const reconnect = () => {
      if (this.closing || epoch !== this.epoch) return;
      clearTimeout(this.wanderTimer);
      const d = this.reconnectDelay;
      this.reconnectDelay = Math.min(30000, d * 2);
      this.log(`disconnected; retrying in ${d}ms`);
      setTimeout(() => this.connect(), d);
    };
    ws.on("close", reconnect);
    ws.on("error", () => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    });
  }

  // Our resident was removed server-side (admin action, snapshot wipe, …).
  // Drop the dead credentials and register fresh instead of exiting.
  async reregister() {
    if (this.closing) return;
    this.epoch++; // invalidate the old socket's pending reconnect timer
    clearState();
    this.creds = null;
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
    this.ws = null;
    this.reconnectDelay = 1000;
    try {
      await this.ensureResident();
    } catch (e) {
      this.log("re-register failed:", e.message);
      if (!this.closing) {
        const t = setTimeout(() => this.reregister(), 5000);
        t.unref?.();
      }
      return;
    }
    this.connect();
  }

  async shutdown(code) {
    if (this.closing) return;
    this.closing = true;
    clearTimeout(this.wanderTimer);
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
    if (!BOT_STAY && this.creds) {
      try {
        await http("/leave", {
          method: "POST",
          body: { id: this.creds.id, token: this.creds.token },
        });
        this.log(`left the island (${this.creds.name})`);
      } catch (e) {
        this.log("leave failed:", e.message);
      }
      clearState();
    } else if (this.creds) {
      this.log(`staying on the island as ${this.creds.name} (BOT_STAY=true)`);
    }
    process.exit(code);
  }

  async run() {
    await this.ensureResident();
    this.connect();
    process.on("SIGINT", () => void this.shutdown(0));
    process.on("SIGTERM", () => void this.shutdown(0));
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  new Bot().run().catch((e) => {
    console.error("[grok-bot] fatal:", e.message);
    process.exit(1);
  });
}

export { Bot };
