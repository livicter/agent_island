// server/__tests__/spawn-limits.test.js
// Tests for spawn protection in server/net.js:
//   - MAX_EXTERNAL_RESIDENTS cap enforced on POST /spawn and WS register
//   - per-client spawn rate limiting on POST /spawn
//
// Run:  node --test server/__tests__/spawn-limits.test.js

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import engineMod from "../engine.js";
import netMod from "../net.js";
import WebSocket from "ws";

const { Engine } = engineMod;
const { start } = netMod;

delete process.env.ISLAND_SECRET; // tests must not require a secret

function makeEngine(port) {
  const e = new Engine();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "island-spawnlimit-test-"));
  e.setPersistOpts({ dir, port });
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

async function postSpawn(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/spawn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test("POST /spawn enforces the MAX_EXTERNAL_RESIDENTS cap", async () => {
  process.env.MAX_EXTERNAL_RESIDENTS = "3";
  try {
    const port = await freePort();
    const e = makeEngine(port);
    // fill to capacity directly (bypasses HTTP rate limiting)
    for (let i = 0; i < 3; i++) e.spawnResident({ name: "Filler" + i });
    const ns = start(e, { port });
    try {
      const { status, json } = await postSpawn(port, { name: "TooMany" });
      assert.equal(status, 429);
      assert.match(json.error, /island full/);
      assert.equal(e.order.filter((id) => e.agents[id].external).length, 3);
    } finally {
      await new Promise((r) => ns.close(r));
    }
  } finally {
    delete process.env.MAX_EXTERNAL_RESIDENTS;
  }
});

test("POST /spawn is rate-limited per client", async () => {
  const port = await freePort();
  const e = makeEngine(port);
  const ns = start(e, { port });
  try {
    const first = await postSpawn(port, { name: "First" });
    assert.equal(first.status, 200);
    const second = await postSpawn(port, { name: "Second" });
    assert.equal(second.status, 429);
    assert.match(second.json.error, /rate limited/);
  } finally {
    await new Promise((r) => ns.close(r));
  }
});

test("WS register is rejected when the island is full", async () => {
  process.env.MAX_EXTERNAL_RESIDENTS = "1";
  try {
    const port = await freePort();
    const e = makeEngine(port);
    e.spawnResident({ name: "Only" }); // fill the single slot directly
    const ns = start(e, { port });
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    try {
      await new Promise((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      });
      const err = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout waiting for error")), 5000);
        ws.on("message", (raw) => {
          const m = JSON.parse(String(raw));
          if (m.type === "error") {
            clearTimeout(timer);
            resolve(m);
          }
        });
        ws.send(JSON.stringify({ type: "register", name: "Late" }));
      });
      assert.match(err.error, /island full/);
    } finally {
      ws.close();
      await new Promise((r) => ns.close(r));
    }
  } finally {
    delete process.env.MAX_EXTERNAL_RESIDENTS;
  }
});
