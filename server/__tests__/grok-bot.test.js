// server/__tests__/grok-bot.test.js
// Unit tests for the pure helpers in server/grok-bot.js (no network).
//
// Run:  node --test server/__tests__/grok-bot.test.js

import assert from "node:assert/strict";
import { test } from "node:test";
import { wsUrl, mentioned, shouldRespond, pickWanderTarget, think } from "../grok-bot.js";

test("wsUrl converts http(s) to ws(s)", () => {
  assert.equal(wsUrl("http://localhost:8902"), "ws://localhost:8902");
  assert.equal(wsUrl("https://example.com"), "wss://example.com");
  assert.equal(wsUrl("http://localhost:8902/"), "ws://localhost:8902/");
});

test("mentioned matches case-insensitively", () => {
  assert.equal(mentioned("hey GROK, over here", "Grok"), true);
  assert.equal(mentioned("hello grok", "Grok"), true);
  assert.equal(mentioned("nice weather", "Grok"), false);
  assert.equal(mentioned("", "Grok"), false);
  assert.equal(mentioned(null, "Grok"), false);
});

test("shouldRespond ignores own messages and empty text", () => {
  const me = { fromId: "ext-1", fromName: "Grok", text: "hello", kind: "say" };
  assert.equal(shouldRespond(me, "Grok"), false);
  assert.equal(shouldRespond({ fromId: "a", fromName: "Fern", text: "   ", kind: "say" }, "Grok"), false);
  assert.equal(shouldRespond({ fromId: "a", fromName: "Fern", kind: "say" }, "Grok"), false);
  assert.equal(shouldRespond(null, "Grok"), false);
});

test("shouldRespond answers direct messages", () => {
  const dm = { fromId: "a-Fern", fromName: "Fern", toId: "ext-1", toName: "Grok", text: "hi", kind: "say" };
  assert.equal(shouldRespond(dm, "Grok"), true);
});

test("shouldRespond answers mentions, ignores unrelated chatter", () => {
  const mention = { fromId: "a-Fern", fromName: "Fern", text: "has anyone seen grok?", kind: "say" };
  assert.equal(shouldRespond(mention, "Grok"), true);
  const chatter = { fromId: "a-Fern", fromName: "Fern", text: "lovely tide today", kind: "convo" };
  assert.equal(shouldRespond(chatter, "Grok"), false);
});

test("pickWanderTarget stays on the island", () => {
  for (let i = 0; i < 200; i++) {
    const t = pickWanderTarget({ x: 0, z: 0 });
    assert.ok(Math.abs(t.x) <= 34 && Math.abs(t.z) <= 34, `out of bounds: ${t.x},${t.z}`);
    const d = Math.hypot(t.x, t.z);
    assert.ok(d > 0.5, "should actually move somewhere");
  }
  // clamped near the edge
  const edge = pickWanderTarget({ x: 34, z: 34 });
  assert.ok(Math.abs(edge.x) <= 34 && Math.abs(edge.z) <= 34);
});

test("think returns a non-empty fallback line", async () => {
  const line = await think({ fromName: "Fern", text: "hi grok" });
  assert.equal(typeof line, "string");
  assert.ok(line.trim().length > 0);
});

test("shouldRespond ignores system messages (own join announcement)", () => {
  const join = { fromId: null, fromName: "island", text: "Grok arrived on the island.", kind: "system" };
  assert.equal(shouldRespond(join, "Grok"), false);
  const leave = { fromId: null, fromName: "island", text: "Grok left the island.", kind: "system" };
  assert.equal(shouldRespond(leave, "Grok"), false);
});
