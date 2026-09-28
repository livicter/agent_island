// Real sim moments and the since-last-visit digest.
// Run: node --test server/__tests__/moments.test.js

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import engineMod from "../engine.js";
import netMod from "../net.js";

const { Engine } = engineMod;
const { start } = netMod;

delete process.env.ISLAND_SECRET;

function makeEngine() {
  const e = new Engine();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "island-moments-"));
  e.setPersistOpts({ dir, port: 1 });
  e.spawnRoster();
  return e;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

test("presence moment describes a real resident, not a story template", () => {
  const e = makeEngine();
  const ev = e._fireStoryEvent();
  assert.ok(ev);
  assert.equal(ev.kind, "presence");
  assert.match(ev.text, / is /);
  const names = e.order.map((id) => e.agents[id].name);
  assert.ok(names.some((n) => ev.text.startsWith(n + " is ")));
  assert.match(ev.text, / near /);
});

test("momentsSince returns only events after the timestamp", () => {
  const e = makeEngine();
  const old = e._pushMoment("old mark", { kind: "sim" });
  old.t = 1000;
  e._pushMoment("new weather mark", { kind: "weather" });
  const digest = e.momentsSince(1000);
  assert.equal(digest.moments.length, 1);
  assert.match(digest.summary, /new weather mark/);
  const first = e.momentsSince(0);
  assert.equal(first.moments.length, 1);
  assert.equal(first.moments[0].text, "new weather mark");
});

test("GET /moments reports an arrival", async () => {
  const e = makeEngine();
  const port = await freePort();
  const srv = start(e, { port });
  try {
    e.spawnResident({ name: "Koda" });
    const res = await fetch(`http://127.0.0.1:${port}/moments?since=1`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.moments.some((m) => m.text === "Koda arrived on the island."));
    assert.match(body.summary, /Koda arrived/);
    assert.equal(typeof body.agents, "number");
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});
