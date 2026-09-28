#!/usr/bin/env node
// server/slack.js — Slack bridge for Agent Island (Socket Mode).
//
// A resident lives on the island and mirrors conversation between a
// Slack channel and the island chat.
//
// Env:
//   SLACK_BOT_TOKEN    xoxb-... bot token
//   SLACK_APP_TOKEN    xapp-... app-level token (Socket Mode)
//   SLACK_CHANNEL      channel ID to bridge (e.g. C0123456789)
//   SLACK_RESIDENT_NAME  island resident name (default "Slackbot")
//   SLACK_RELAY_ALL    "true" to relay all island chat, "false" (default) to
//                      relay only messages that mention the resident name or
//                      are brain/narrative entries
//   SLACK_STAY         "true" to keep the resident on the island across
//                      bridge restarts (default "false": leave on shutdown)
//   ISLAND_SECRET      passed through on /spawn when the engine requires it
//   ENGINE_URL         engine HTTP base (default http://localhost:8902)
//   DATA_DIR           snapshot/state directory (default server/data)
//
// The resident's {id, token} are saved to server/data/slack-bridge.json so a
// restart resumes the same resident instead of spawning duplicates — the
// same persistence pattern as server/grok-bot.js.
//
// Run: node server/slack.js

import boltPkg from "@slack/bolt";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const { App } = boltPkg;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE =
  process.env.SLACK_STATE_FILE ||
  path.join(process.env.DATA_DIR || path.join(HERE, "data"), "slack-bridge.json");

// ---------------------------------------------------------------------------
// Resident persistence (exported for unit tests; mirrors grok-bot.js).
// ---------------------------------------------------------------------------

/** Load saved {id, token, name} or null when absent/unparseable. */
export function loadState(file = STATE_FILE) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    return s && typeof s.id === "string" && typeof s.token === "string" ? s : null;
  } catch {
    return null;
  }
}

/** Persist {id, token, name} for resume across restarts. */
export function saveState(state, file = STATE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
}

/** Forget saved credentials (after leaving the island). */
export function clearState(file = STATE_FILE) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

/** True when the /state snapshot still contains our resident id. */
export function snapshotHasResident(snapshot, id) {
  return Array.isArray(snapshot?.agents) && snapshot.agents.some((a) => a?.id === id);
}

/**
 * Resume the saved resident when its credentials are still valid, otherwise
 * spawn fresh and save the new credentials. `engineCall` is (path, opts) ->
 * JSON. Returns {id, token, name, resumed}.
 */
export async function resolveResident(engineCall, { name, secret, file = STATE_FILE }) {
  const saved = loadState(file);
  if (saved) {
    try {
      const state = await engineCall("/state");
      if (snapshotHasResident(state, saved.id)) {
        return {
          id: saved.id,
          token: saved.token,
          name: saved.name || name,
          resumed: true,
          lastSeq: saved.lastSeq ?? -1,
        };
      }
    } catch {
      /* fall through to spawn */
    }
  }
  const spawned = await engineCall("/spawn", {
    method: "POST",
    body: { name, ...(secret ? { secret } : {}) },
  });
  const creds = { id: spawned.id, token: spawned.token, name: spawned.name };
  saveState(creds, file);
  return { ...creds, resumed: false, lastSeq: -1 };
}

// ---------------------------------------------------------------------------
// Pure mapping helpers (exported for unit tests; no network here).
// ---------------------------------------------------------------------------

/** Format one island chat entry for Slack. */
export function formatIslandToSlack(entry) {
  const name = entry.from ?? entry.fromName ?? entry.name ?? "Island";
  const text = entry.text ?? "";
  const recipient = entry.toName ?? entry.to ?? null;
  if (recipient) return `*${name}* → *${recipient}*: ${text}`;
  return `*${name}*: ${text}`;
}

/**
 * Decide whether a raw Slack `message` event should be relayed to the island.
 * Ignores bot messages and non-text/subtype events; thread replies included.
 */
export function shouldRelaySlackEvent(event, channel) {
  if (!event || event.type !== "message") return false;
  if (event.channel !== channel) return false;
  if (event.bot_id) return false;
  if (event.subtype && event.subtype !== "thread_broadcast") return false;
  if (typeof event.text !== "string" || event.text.trim() === "") return false;
  return true;
}

/** True if an island chat entry was posted by our own resident. */
export function isOwnMessage(entry, residentId) {
  return (entry.fromId ?? entry.from_id ?? entry.agentId) === residentId;
}

/**
 * True if an island chat entry came from Slack (relay echo guard).
 * Slack-originated messages are prefixed with "<@U...>" by this bridge.
 */
export function isFromSlack(entry) {
  const text = entry.text ?? "";
  return /^<@[\w]+>/.test(text.trim());
}

/**
 * Decide whether an island chat entry should be relayed to Slack.
 */
export function shouldRelayIslandEntry(entry, { residentId, residentName, relayAll }) {
  if (!entry || typeof entry.text !== "string" || entry.text.trim() === "") return false;
  if (isOwnMessage(entry, residentId)) return false;
  if (isFromSlack(entry)) return false;
  if (relayAll) return true;
  const text = entry.text.toLowerCase();
  if (residentName && text.includes(residentName.toLowerCase())) return true;
  if (entry.kind === "brain") return true;
  return false;
}

/** Build the island-bound text for a Slack message event. */
export function formatSlackToIsland(event) {
  return `<@${event.user}>: ${event.text}`;
}

// ---------------------------------------------------------------------------
// Bridge runtime.
// ---------------------------------------------------------------------------

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const APP_TOKEN = process.env.SLACK_APP_TOKEN;
const CHANNEL = process.env.SLACK_CHANNEL;
const RESIDENT_NAME = process.env.SLACK_RESIDENT_NAME || "Slackbot";
const RELAY_ALL = String(process.env.SLACK_RELAY_ALL || "false").toLowerCase() === "true";
const ENGINE_URL = process.env.ENGINE_URL || "http://localhost:8902";
const ISLAND_SECRET = process.env.ISLAND_SECRET || "";
const STAY = String(process.env.SLACK_STAY || "").toLowerCase() === "true";
// Island -> Slack poll interval. 2s default: each poll is one tiny local
// GET, so this is the dominant latency knob for island->Slack messages.
const POLL_MS = Math.max(500, parseInt(process.env.SLACK_POLL_MS || "2000", 10));
const HTTP_TIMEOUT_MS = parseInt(process.env.SLACK_HTTP_TIMEOUT_MS || "10000", 10);
// Slack Web API calls (auth.test, chat.postMessage) have no timeout by
// default — a stalled connection would hang the bridge silently.
const SLACK_API_TIMEOUT_MS = parseInt(process.env.SLACK_API_TIMEOUT_MS || "15000", 10);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** True for errors that retrying won't fix (bad credentials, not blips). */
export function isAuthError(err) {
  const m = String(err?.message ?? err ?? "").toLowerCase();
  return /invalid secret|bad token|unauthorized|forbidden|invalid_auth|token_revoked|account_inactive/.test(m);
}

/** Print usage and exit (also used by --help). */
export function printHelp() {
  console.log(`slack.js — Agent Island <-> Slack bridge (Socket Mode + island polling).

Usage:  SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... SLACK_CHANNEL=C... \\
          ISLAND_SECRET=... node server/slack.js [--help]

Environment:
  SLACK_BOT_TOKEN        bot token (xoxb-...) — required
  SLACK_APP_TOKEN        app-level token (xapp-...) for Socket Mode — required
  SLACK_CHANNEL          channel ID to relay — required
  SLACK_RESIDENT_NAME    island resident name (default "Slackbot")
  SLACK_RELAY_ALL        "true" relays all island chat (default: mentions + brain replies)
  SLACK_STAY             "true" keeps the resident on exit (default: leave)
  SLACK_POLL_MS          island poll interval ms (default 2000, min 500)
  SLACK_HTTP_TIMEOUT_MS  cap on engine round-trips (default 10000)
  SLACK_API_TIMEOUT_MS   cap on Slack API calls (default 15000)
  ENGINE_URL             engine HTTP base (default http://localhost:8902)
  ISLAND_SECRET          required when the engine sets one
  SLACK_STATE_FILE       credential file (default <server/data>/slack-bridge.json)

Behavior: spawns (or resumes) one persistent island resident, relays Slack
messages to the island in real time via Socket Mode, and polls the island
for new chat to post back. Slack messages appear on the island as
"<@U123>: text"; the resident shows island replies in Slack. Ctrl-C leaves
the island unless SLACK_STAY=true.`);
}

async function engine(path, { method = "GET", body = null } = {}) {
  const res = await fetch(`${ENGINE_URL}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : null,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`engine ${path} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function main() {
  if (process.argv.includes("--help")) {
    printHelp();
    process.exit(0);
  }
  if (!BOT_TOKEN || !APP_TOKEN) {
    console.warn(
      "[slack-bridge] SLACK_BOT_TOKEN and SLACK_APP_TOKEN are not both set. " +
        "See server/integrations.md for Slack app setup. Bridge not started."
    );
    process.exit(0);
  }
  if (!CHANNEL) {
    console.warn("[slack-bridge] SLACK_CHANNEL is not set. Bridge not started.");
    process.exit(0);
  }
  process.on("unhandledRejection", (e) =>
    console.warn("[slack-bridge] unhandled rejection:", e?.message ?? e)
  );

  // Reach the engine (retry 3x), then spawn our resident.
  let health = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      health = await engine("/health");
      break;
    } catch (err) {
      console.warn(`[slack-bridge] engine unreachable (attempt ${attempt}/3): ${err.message}`);
      if (attempt < 3) await sleep(2000);
    }
  }
  if (!health) {
    console.warn("[slack-bridge] engine unreachable after 3 attempts; bridge not started.");
    process.exit(0);
  }

  // Resume the previous resident when its credentials are still valid;
  // otherwise spawn fresh. Saved {id, token} live in slack-bridge.json —
  // the same persistence pattern as server/grok-bot.js — so restarts never
  // accumulate duplicate residents. Transient failures retry with backoff;
  // auth failures (bad ISLAND_SECRET) exit immediately.
  let res = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      res = await resolveResident(engine, { name: RESIDENT_NAME, secret: ISLAND_SECRET });
      break;
    } catch (err) {
      lastErr = err;
      if (isAuthError(err)) {
        console.error(`[slack-bridge] fatal: ${err.message} — check ISLAND_SECRET.`);
        process.exit(1);
      }
      console.warn(`[slack-bridge] resident setup failed (attempt ${attempt}/5): ${err.message}`);
      if (attempt < 5) await sleep(Math.min(15000, 2000 * 2 ** (attempt - 1)));
    }
  }
  if (!res) {
    console.error(`[slack-bridge] fatal: could not set up island resident: ${lastErr?.message}`);
    process.exit(1);
  }
  const residentId = res.id;
  const residentToken = res.token;
  const residentName = res.name;
  // On resume, continue from the last relayed message so a bridge restart
  // doesn't re-post pre-restart mentions to Slack. A fresh spawn relays
  // recent history once (lastSeq = -1).
  let lastSeq = res.lastSeq ?? -1;
  const creds = { id: residentId, token: residentToken, name: residentName };
  function persistState() {
    saveState({ ...creds, lastSeq });
  }
  console.log(
    res.resumed
      ? `[slack-bridge] resumed resident "${residentName}" (${residentId}).`
      : `[slack-bridge] spawned resident "${residentName}" on the island.`
  );

  const app = new App({
    token: BOT_TOKEN,
    appToken: APP_TOKEN,
    socketMode: true,
    clientOptions: { timeout: SLACK_API_TIMEOUT_MS },
  });

  // Fail fast on a bad Slack token with a clear message, instead of a
  // cryptic Socket Mode failure after startup.
  try {
    const auth = await app.client.auth.test();
    console.log(`[slack-bridge] slack auth ok as @${auth.user} (team ${auth.team})`);
  } catch (err) {
    console.error(`[slack-bridge] fatal: slack auth failed: ${err.message} — check SLACK_BOT_TOKEN.`);
    process.exit(1);
  }

  // Slack -> island
  app.event("message", async ({ event, say }) => {
    try {
      if (!shouldRelaySlackEvent(event, CHANNEL)) return;
      await engine("/say", {
        method: "POST",
        body: { id: residentId, token: residentToken, text: formatSlackToIsland(event) },
      });
    } catch (err) {
      console.warn("[slack-bridge] slack->island relay failed:", err.message);
    }
  });

  // Island -> Slack (polling)
  let stopping = false;
  async function poll() {
    const t0 = Date.now();
    try {
      const raw = await engine(`/chat?limit=20`);
      const entries = Array.isArray(raw) ? raw : raw.chat ?? [];
      for (const entry of entries) {
        const seq = entry.seq ?? entry.id;
        if (typeof seq === "number" && seq <= lastSeq) continue;
        if (typeof seq === "number" && seq > lastSeq) lastSeq = seq;
        if (
          shouldRelayIslandEntry(entry, {
            residentId,
            residentName: RESIDENT_NAME,
            relayAll: RELAY_ALL,
          })
        ) {
          await app.client.chat.postMessage({
            channel: CHANNEL,
            text: formatIslandToSlack(entry),
            mrkdwn: true,
          });
        }
      }
    } catch (err) {
      console.warn("[slack-bridge] island poll failed:", err.message);
    } finally {
      const dt = Date.now() - t0;
      if (dt > 5000) console.warn(`[slack-bridge] slow island poll: ${dt}ms`);
      persistState();
      if (!stopping) setTimeout(poll, POLL_MS);
    }
  }

  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`\n[slack-bridge] ${signal} received, shutting down...`);
    // Don't let a hung Socket Mode connection stall shutdown.
    await Promise.race([app.stop().catch(() => {}), sleep(5000)]);
    if (!STAY) {
      try {
        await engine("/leave", {
          method: "POST",
          body: { id: residentId, token: residentToken },
        });
        console.log("[slack-bridge] resident left the island.");
      } catch (err) {
        console.warn("[slack-bridge] leave failed:", err.message);
      }
      clearState();
    } else {
      persistState();
      console.log("[slack-bridge] SLACK_STAY=true — resident stays on the island.");
    }
    process.exit(0);
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await app.start();
  console.log(
    `[slack-bridge] listening on ${CHANNEL} (poll ${POLL_MS}ms, ` +
      `${RELAY_ALL ? "relaying all island chat" : "relaying mentions + brain replies"}, ` +
      `stay=${STAY}). Ctrl-C to stop.`
  );
  poll();
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop());
if (isMain) {
  main().catch((err) => {
    console.error("[slack-bridge] fatal:", err.message);
    process.exit(1);
  });
}
