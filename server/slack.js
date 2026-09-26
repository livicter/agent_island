#!/usr/bin/env node
// server/slack.js — Slack bridge for Agent Island (Socket Mode).
//
// A chibi resident lives on the island and mirrors conversation between a
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
//   ENGINE_URL         engine HTTP base (default http://localhost:8902)
//
// Run: node server/slack.js

import boltPkg from "@slack/bolt";
const { App } = boltPkg;

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
const POLL_MS = 4000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function engine(path, { method = "GET", body = null } = {}) {
  const res = await fetch(`${ENGINE_URL}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : null,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`engine ${path} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function main() {
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

  const spawned = await engine("/spawn", { method: "POST", body: { name: RESIDENT_NAME } });
  const residentId = spawned.id;
  const residentToken = spawned.token;
  console.log(`[slack-bridge] spawned resident "${spawned.name}" on the island.`);

  const app = new App({ token: BOT_TOKEN, appToken: APP_TOKEN, socketMode: true });

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
  let lastSeq = -1;
  async function poll() {
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
      setTimeout(poll, POLL_MS);
    }
  }

  await app.start();
  console.log(
    `[slack-bridge] listening on ${CHANNEL} (relayAll=${RELAY_ALL}). Ctrl-C to stop.`
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
