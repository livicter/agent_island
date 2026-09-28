// server/__tests__/grok-bot.test.js
// Unit tests for the pure helpers in server/grok-bot.js (no network).
//
// Run:  node --test server/__tests__/grok-bot.test.js

import assert from "node:assert/strict";
import { test } from "node:test";
import { wsUrl, mentioned, shouldRespond, pickWanderTarget, think, waitFor, Bot } from "../grok-bot.js";

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

test("waitFor resolves on the awaited message type", async () => {
  const { EventEmitter } = await import("node:events");
  const ws = new EventEmitter();
  const p = waitFor(ws, "registered", 1000);
  ws.emit("message", JSON.stringify({ type: "welcome", snapshot: {} }));
  ws.emit("message", JSON.stringify({ type: "registered", id: "ext-1" }));
  const m = await p;
  assert.equal(m.id, "ext-1");
});

test("waitFor rejects with the server error instead of hanging", async () => {
  const { EventEmitter } = await import("node:events");
  const ws = new EventEmitter();
  const p = waitFor(ws, "registered", 5000);
  ws.emit("message", JSON.stringify({ type: "error", error: "invalid secret" }));
  await assert.rejects(p, /invalid secret/);
});

test("waitFor times out when nothing arrives", async () => {
  const { EventEmitter } = await import("node:events");
  const ws = new EventEmitter();
  await assert.rejects(waitFor(ws, "registered", 20), /timeout waiting for registered/);
});

test("reregister drops dead creds and registers fresh", async () => {
  const { EventEmitter } = await import("node:events");
  const bot = new Bot();
  bot.creds = { id: "ext-old", token: "tok-old", name: "Grok" };
  const oldWs = new EventEmitter();
  let closed = false;
  oldWs.close = () => { closed = true; oldWs.emit("close"); };
  bot.ws = oldWs;
  const epochBefore = bot.epoch;
  // stub the network registration: pretend the engine hands us a new resident
  bot.ensureResident = async () => {
    bot.creds = { id: "ext-new", token: "tok-new", name: "Grok" };
  };
  // fake socket factory for the fresh connect()
  const newWs = new EventEmitter();
  newWs.close = () => {};
  newWs.send = () => {};
  newWs.readyState = 1;
  const seen = [];
  bot._wsFactory = (url) => { seen.push(url); return newWs; };
  // silence logs
  bot.log = () => {};
  await bot.reregister();
  assert.equal(closed, true);
  assert.equal(bot.creds.id, "ext-new");
  assert.ok(bot.epoch > epochBefore, "epoch advanced to invalidate stale reconnect");
  assert.equal(bot.ws, newWs);
  assert.ok(seen.length >= 1, "connect() opened a fresh socket");
});

test("isAuthError distinguishes credential failures from blips", async () => {
  const { isAuthError } = await import("../grok-bot.js");
  assert.equal(isAuthError(new Error("invalid secret")), true);
  assert.equal(isAuthError(new Error("register failed: bad token")), true);
  assert.equal(isAuthError(new Error("HTTP 403 /spawn")), false); // 403 alone isn't proof
  assert.equal(isAuthError(new Error("fetch failed")), false);
  assert.equal(isAuthError(new Error("engine websocket open timed out after 10000ms")), false);
  assert.equal(isAuthError(null), false);
});

test("withTimeout resolves fast promises untouched", async () => {
  const { withTimeout } = await import("../grok-bot.js");
  assert.equal(await withTimeout(Promise.resolve("ok"), 1000, "x"), "ok");
});

test("withTimeout rejects a hung promise with a labelled error", async () => {
  const { withTimeout } = await import("../grok-bot.js");
  await assert.rejects(withTimeout(new Promise(() => {}), 20, "think()"), /think\(\) timed out after 20ms/);
});

test("withTimeout propagates the inner rejection", async () => {
  const { withTimeout } = await import("../grok-bot.js");
  await assert.rejects(withTimeout(Promise.reject(new Error("boom")), 1000, "x"), /boom/);
});

test("errText unwraps AggregateError (happy-eyeballs connection failures)", async () => {
  const { errText } = await import("../grok-bot.js");
  const agg = new AggregateError([new Error("connect ECONNREFUSED ::1:8903"), new Error("connect ECONNREFUSED 127.0.0.1:8903")], "");
  assert.match(errText(agg), /ECONNREFUSED/);
  assert.equal(errText(new Error("boom")), "boom");
  assert.equal(errText(null), "unknown error");
});
