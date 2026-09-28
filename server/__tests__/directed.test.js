// server/__tests__/directed.test.js
// Tests for directed chat: engine.say(id, text, {to}) where `to` may be an
// agent id or a resident name (case-insensitive). The entry records
// toId/toName; a roster target yields a brain reply addressed back.
//
// Run:  node --test server/__tests__/directed.test.js

import assert from "node:assert/strict";
import { test } from "node:test";
import engineMod from "../engine.js";

const { Engine } = engineMod;

function makeEngine() {
  const e = new Engine();
  e.spawnRoster();
  return e;
}

test("say with `to` as a roster name yields a brain reply", () => {
  const e = makeEngine();
  const r = e.spawnResident({ name: "Prober", color: "#fff" });
  const { entry, replyEntry } = e.say(r.id, "hello there", { to: "Fern" });
  assert.equal(entry.toId, "a-Fern");
  assert.equal(entry.toName, "Fern");
  assert.ok(replyEntry, "expected a brain reply");
  assert.equal(replyEntry.fromId, "a-Fern");
  assert.equal(replyEntry.toId, r.id);
  assert.equal(replyEntry.toName, "Prober");
  assert.equal(replyEntry.kind, "brain");
});

test("say `to` is case-insensitive and also accepts an id", () => {
  const e = makeEngine();
  const r = e.spawnResident({ name: "Prober", color: "#fff" });
  const byName = e.say(r.id, "hi", { to: "fErN" });
  assert.equal(byName.entry.toId, "a-Fern");
  const byId = e.say(r.id, "hi", { to: "a-Fern" });
  assert.equal(byId.entry.toId, "a-Fern");
  assert.ok(byId.replyEntry, "expected a brain reply");
});

test("say with `to` naming an external resident records the recipient, no brain reply", () => {
  const e = makeEngine();
  const a = e.spawnResident({ name: "Prober", color: "#fff" });
  const b = e.spawnResident({ name: "Buddy", color: "#000" });
  const { entry, replyEntry } = e.say(a.id, "hey buddy", { to: "Buddy" });
  assert.equal(entry.toId, b.id);
  assert.equal(entry.toName, "Buddy");
  assert.equal(replyEntry, null);
});

test("say with unknown `to` behaves as public chat", () => {
  const e = makeEngine();
  const r = e.spawnResident({ name: "Prober", color: "#fff" });
  const { entry, replyEntry } = e.say(r.id, "hello?", { to: "Nobody Here" });
  assert.equal(entry.toId, undefined);
  assert.equal(entry.toName, undefined);
  assert.equal(replyEntry, null);
});

test("public say has no toId/toName", () => {
  const e = makeEngine();
  const r = e.spawnResident({ name: "Prober", color: "#fff" });
  const { entry } = e.say(r.id, "hello everyone");
  assert.equal(entry.toId, undefined);
  assert.equal(entry.toName, undefined);
});
