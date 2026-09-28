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

test("say with `to` as a roster name yields a brain reply", async () => {
  const e = makeEngine();
  const r = e.spawnResident({ name: "Prober", color: "#fff" });
  const { entry, replyEntry } = await e.say(r.id, "hello there", { to: "Fern" });
  assert.equal(entry.toId, "a-Fern");
  assert.equal(entry.toName, "Fern");
  assert.ok(replyEntry, "expected a brain reply");
  assert.equal(replyEntry.fromId, "a-Fern");
  assert.equal(replyEntry.toId, r.id);
  assert.equal(replyEntry.toName, "Prober");
  assert.equal(replyEntry.kind, "brain");
});

test("say `to` is case-insensitive and also accepts an id", async () => {
  const e = makeEngine();
  const r = e.spawnResident({ name: "Prober", color: "#fff" });
  const byName = await e.say(r.id, "hi", { to: "fErN" });
  assert.equal(byName.entry.toId, "a-Fern");
  const byId = await e.say(r.id, "hi", { to: "a-Fern" });
  assert.equal(byId.entry.toId, "a-Fern");
  assert.ok(byId.replyEntry, "expected a brain reply");
});

test("say with `to` naming an external resident records the recipient, no brain reply", async () => {
  const e = makeEngine();
  const a = e.spawnResident({ name: "Prober", color: "#fff" });
  const b = e.spawnResident({ name: "Buddy", color: "#000" });
  const { entry, replyEntry } = await e.say(a.id, "hey buddy", { to: "Buddy" });
  assert.equal(entry.toId, b.id);
  assert.equal(entry.toName, "Buddy");
  assert.equal(replyEntry, null);
});

test("say with unknown `to` behaves as public chat", async () => {
  const e = makeEngine();
  const r = e.spawnResident({ name: "Prober", color: "#fff" });
  const { entry, replyEntry } = await e.say(r.id, "hello?", { to: "Nobody Here" });
  assert.equal(entry.toId, undefined);
  assert.equal(entry.toName, undefined);
  assert.equal(replyEntry, null);
});

test("public say has no toId/toName", async () => {
  const e = makeEngine();
  const r = e.spawnResident({ name: "Prober", color: "#fff" });
  const { entry } = await e.say(r.id, "hello everyone");
  assert.equal(entry.toId, undefined);
  assert.equal(entry.toName, undefined);
});

test("autonomous conversations never put words in an external resident's mouth", () => {
  const e = makeEngine();
  const r = e.spawnResident({ name: "Botty", color: "#ffffff" });
  const bot = e.agents[r.id];
  const npc = e.agents["a-Fern"];
  // park the bot right next to an NPC so proximity would once have paired them
  bot.x = npc.x;
  bot.z = npc.z;
  for (let i = 0; i < 300; i++) {
    const pair = e._pickConvoPair();
    if (pair) {
      assert.ok(!pair.a.external && !pair.b.external, "pair included an external resident");
    }
  }
  // admin trigger fallback also stays NPC-only
  for (const id of e.order) {
    e.agents[id].x = (Math.random() - 0.5) * 60;
    e.agents[id].z = (Math.random() - 0.5) * 60;
  }
  e.convoQueue = [];
  e.triggerConversation();
  assert.ok(e.convoQueue.length > 0, "expected fallback convo lines");
  for (const q of e.convoQueue) {
    assert.notEqual(q.entry.fromId, r.id, "convo line spoken by the bot");
  }
});
