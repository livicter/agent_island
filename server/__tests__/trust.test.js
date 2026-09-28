// Caps, rate limits, and token-bound say/move.
// Run: node --test server/__tests__/trust.test.js

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "island-trust-"));
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

test("permanent name cannot impersonate a roster resident or a twin", () => {
  const e = makeEngine();
  assert.throws(() => e.spawnResident({ name: "Pip" }), /name taken/);
  assert.throws(() => e.spawnResident({ name: " pip " }), /name taken/);
  const a = e.spawnResident({ name: "Koda" });
  assert.equal(a.name, "Koda");
  assert.throws(() => e.spawnResident({ name: "koda" }), /name taken/);
  const t1 = e.spawnResident({ name: "Traveler", transient: true });
  const t2 = e.spawnResident({ name: "Traveler", transient: true });
  assert.notEqual(t1.id, t2.id);
});

test("say and move require the resident token; roster ids cannot speak", async () => {
  const e = makeEngine();
  const port = await freePort();
  const srv = start(e, { port });
  const born = e.spawnResident({ name: "Koda" });
  const token = e.tokens.get(born.id);
  try {
    const sayBad = await fetch(`http://127.0.0.1:${port}/say`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: born.id, token: "nope", text: "hi" }),
    });
    assert.equal(sayBad.status, 403);
    const sayAsPip = await fetch(`http://127.0.0.1:${port}/say`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "a-Pip", token, text: "I am Pip" }),
    });
    assert.equal(sayAsPip.status, 403);
    const sayOk = await fetch(`http://127.0.0.1:${port}/say`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: born.id, token, text: "hello" }),
    });
    assert.equal(sayOk.status, 200);
    const again = await fetch(`http://127.0.0.1:${port}/say`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: born.id, token, text: "spam" }),
    });
    assert.equal(again.status, 429);
    const moveBad = await fetch(`http://127.0.0.1:${port}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: born.id, token: "nope", x: 1, z: 1 }),
    });
    assert.equal(moveBad.status, 403);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test("spawn is capped per IP and rejects a full island", async () => {
  const prev = process.env.SPAWN_MAX;
  const prevCap = process.env.MAX_EXTERNAL;
  process.env.SPAWN_MAX = "2";
  process.env.MAX_EXTERNAL = "1";
  const e = makeEngine();
  const port = await freePort();
  const srv = start(e, { port });
  try {
    const first = await fetch(`http://127.0.0.1:${port}/spawn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "One" }),
    });
    assert.equal(first.status, 200);
    const full = await fetch(`http://127.0.0.1:${port}/spawn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Two" }),
    });
    assert.equal(full.status, 400);
    const body = await full.json();
    assert.match(body.error, /island is full/);
  } finally {
    if (prev === undefined) delete process.env.SPAWN_MAX;
    else process.env.SPAWN_MAX = prev;
    if (prevCap === undefined) delete process.env.MAX_EXTERNAL;
    else process.env.MAX_EXTERNAL = prevCap;
    await new Promise((resolve) => srv.close(resolve));
  }
});
