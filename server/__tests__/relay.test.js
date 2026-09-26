// server/__tests__/relay.test.js
// Unit tests for the Slack bridge mapping helpers (server/slack.js).
// No tokens, no network: pure functions with fake events/entries.
//
// Run:  node --test server/__tests__/relay.test.js

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatIslandToSlack,
  shouldRelaySlackEvent,
  isOwnMessage,
  isFromSlack,
  shouldRelayIslandEntry,
  formatSlackToIsland,
} from "../slack.js";

const CHANNEL = "C123CHANNEL";

test("formatIslandToSlack formats *Name*: text", () => {
  assert.equal(formatIslandToSlack({ from: "Momo", text: "hello island" }), "*Momo*: hello island");
});

test("formatIslandToSlack falls back to Island name", () => {
  assert.equal(formatIslandToSlack({ text: "waves" }), "*Island*: waves");
});

test("formatIslandToSlack formats recipient as *A* → *B*: text", () => {
  assert.equal(
    formatIslandToSlack({ from: "Miso", toName: "Michelle", text: "soup?" }),
    "*Miso* → *Michelle*: soup?"
  );
});

test("formatIslandToSlack accepts legacy `to` key as recipient", () => {
  assert.equal(
    formatIslandToSlack({ from: "Pip", to: "bozo", text: "trade you tide glass" }),
    "*Pip* → *bozo*: trade you tide glass"
  );
});

test("formatIslandToSlack prefers toName over to", () => {
  assert.equal(
    formatIslandToSlack({ fromName: "Miso", toName: "Michelle", to: "Pip", text: "soup?" }),
    "*Miso* → *Michelle*: soup?"
  );
});

test("shouldRelaySlackEvent accepts a plain channel message", () => {
  const event = { type: "message", channel: CHANNEL, user: "U1", text: "hi there" };
  assert.equal(shouldRelaySlackEvent(event, CHANNEL), true);
});

test("shouldRelaySlackEvent ignores other channels", () => {
  const event = { type: "message", channel: "COTHER", user: "U1", text: "hi" };
  assert.equal(shouldRelaySlackEvent(event, CHANNEL), false);
});

test("shouldRelaySlackEvent ignores bot messages", () => {
  const event = { type: "message", channel: CHANNEL, bot_id: "B1", text: "bot says hi" };
  assert.equal(shouldRelaySlackEvent(event, CHANNEL), false);
});

test("shouldRelaySlackEvent ignores subtype events (edits, joins)", () => {
  for (const subtype of ["message_changed", "channel_join", "bot_message"]) {
    const event = { type: "message", channel: CHANNEL, user: "U1", subtype, text: "x" };
    assert.equal(shouldRelaySlackEvent(event, CHANNEL), false, subtype);
  }
});

test("shouldRelaySlackEvent ignores empty text", () => {
  const event = { type: "message", channel: CHANNEL, user: "U1", text: "   " };
  assert.equal(shouldRelaySlackEvent(event, CHANNEL), false);
});

test("shouldRelaySlackEvent allows thread replies", () => {
  const event = {
    type: "message",
    channel: CHANNEL,
    user: "U1",
    text: "replying",
    thread_ts: "123.456",
  };
  assert.equal(shouldRelaySlackEvent(event, CHANNEL), true);
});

test("isOwnMessage matches resident id", () => {
  assert.equal(isOwnMessage({ fromId: "agent-1" }, "agent-1"), true);
  assert.equal(isOwnMessage({ fromId: "agent-2" }, "agent-1"), false);
});

test("isFromSlack detects <@U...> prefix", () => {
  assert.equal(isFromSlack({ text: "<@U123>: hello" }), true);
  assert.equal(isFromSlack({ text: "hello" }), false);
  assert.equal(isFromSlack({ text: "  <@U123>: hi" }), true);
});

test("shouldRelayIslandEntry skips own messages", () => {
  const entry = { fromId: "agent-1", from: "Slackbot", text: "echo" };
  const opts = { residentId: "agent-1", residentName: "Slackbot", relayAll: true };
  assert.equal(shouldRelayIslandEntry(entry, opts), false);
});

test("shouldRelayIslandEntry skips slack-originated echo", () => {
  const entry = { fromId: "agent-9", from: "Other", text: "<@U123>: hi" };
  const opts = { residentId: "agent-1", residentName: "Slackbot", relayAll: true };
  assert.equal(shouldRelayIslandEntry(entry, opts), false);
});

test("shouldRelayIslandEntry with relayAll relays ordinary chat", () => {
  const entry = { fromId: "agent-2", from: "Momo", text: "sunny today" };
  const opts = { residentId: "agent-1", residentName: "Slackbot", relayAll: true };
  assert.equal(shouldRelayIslandEntry(entry, opts), true);
});

test("shouldRelayIslandEntry without relayAll relays name mentions (case-insensitive)", () => {
  const entry = { fromId: "agent-2", from: "Momo", text: "Hey SLACKBOT, come here" };
  const opts = { residentId: "agent-1", residentName: "Slackbot", relayAll: false };
  assert.equal(shouldRelayIslandEntry(entry, opts), true);
});

test("shouldRelayIslandEntry without relayAll relays brain entries", () => {
  const entry = { fromId: "agent-2", from: "Momo", text: "muses about tides", kind: "brain" };
  const opts = { residentId: "agent-1", residentName: "Slackbot", relayAll: false };
  assert.equal(shouldRelayIslandEntry(entry, opts), true);
});

test("shouldRelayIslandEntry without relayAll skips unrelated chat", () => {
  const entry = { fromId: "agent-2", from: "Momo", text: "sunny today" };
  const opts = { residentId: "agent-1", residentName: "Slackbot", relayAll: false };
  assert.equal(shouldRelayIslandEntry(entry, opts), false);
});

test("formatSlackToIsland prefixes with user mention", () => {
  assert.equal(
    formatSlackToIsland({ user: "U123", text: "hello island" }),
    "<@U123>: hello island"
  );
});
