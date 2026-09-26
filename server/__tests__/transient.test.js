// server/__tests__/transient.test.js
// Tests for transient viewer residents (engine.spawnResident {transient}
// + WS register transient:true in server/net.js):
//   - transient spawn marks the agent and shows up in publicAgent
//   - saveToDisk/loadFromDisk exclude transient agents and their tokens
//   - WS register with transient:true removes the resident on socket close
//   - WS register without transient keeps the classic permanent behavior
//
// Run:  node --test server/__tests__/transient.test.js

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "island-transient-test-"));
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

// Resolve with the next WS message of the given type (rejects on timeout).
function nextMsg(ws, type, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMsg);
      reject(new Error("timeout waiting for ws message: " + type));
    }, timeoutMs);
    const onMsg = (raw) => {
      let m;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === type) {
        clearTimeout(timer);
        ws.off("message", onMsg);
        resolve(m);
      }
    };
    ws.on("message", onMsg);
  });
}

function connectWs(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

test("spawnResident({transient:true}) marks the agent; default stays permanent", () => {
  const e = makeEngine(19871);
  const t = e.spawnResident({ name: "Peeker", transient: true });
  const p = e.spawnResident({ name: "Settler" });
  assert.equal(e.getAgent(t.id).transient, true);
  assert.equal(e.getAgent(p.id).transient, false);
  assert.equal(e.publicAgent(e.getAgent(t.id)).transient, true);
  assert.equal(e.publicAgent(e.getAgent(p.id)).transient, false);
});

test("saveToDisk excludes transient agents and tokens; loadFromDisk drops them", () => {
  const port = 19872;
  const e = makeEngine(port);
  const t = e.spawnResident({ name: "Peeker", transient: true });
  const p = e.spawnResident({ name: "Settler" });
  e.saveToDisk();

  const snapFile = path.join(e.persistDir, `world-${port}.json`);
  const raw = JSON.parse(fs.readFileSync(snapFile, "utf8"));
  const ids = raw.agents.map((a) => a.id);
  assert.ok(!ids.includes(t.id), "transient agent must not be in snapshot");
  assert.ok(ids.includes(p.id), "permanent external must be in snapshot");
  const tokenIds = raw.tokens.map(([id]) => id);
  assert.ok(!tokenIds.includes(t.id), "transient token must not persist");
  assert.ok(tokenIds.includes(p.id), "permanent token must persist");

  const e2 = makeEngine(port);
  // point e2 at the same dir/port: reuse the snapshot file location
  e2.setPersistOpts({ dir: e.persistDir, port });
  assert.equal(e2.loadFromDisk(), true);
  assert.equal(e2.getAgent(t.id), null);
  assert.ok(e2.getAgent(p.id), "permanent external restored");
  assert.equal(e2.checkToken(p.id, e.tokens.get(p.id)), true);
});

test("WS register transient:true -> resident removed on socket close", async () => {
  const port = await freePort();
  const engine = makeEngine(port);
  const srv = start(engine, { port });
  try {
    const ws = await connectWs(port);
    ws.send(JSON.stringify({ type: "hello" }));
    await nextMsg(ws, "welcome");
    ws.send(JSON.stringify({ type: "register", name: "Peeker", transient: true }));
    const reg = await nextMsg(ws, "registered");
    assert.equal(reg.transient, true);
    assert.ok(reg.id.startsWith("ext-"));
    assert.ok(engine.getAgent(reg.id), "transient resident present while connected");
    assert.equal(engine.getAgent(reg.id).transient, true);

    ws.close();
    // poll: close handler removes the agent asynchronously on 'close'
    let gone = false;
    for (let i = 0; i < 50 && !gone; i++) {
      await new Promise((r) => setTimeout(r, 50));
      gone = !engine.getAgent(reg.id);
    }
    assert.ok(gone, "transient resident removed after socket close");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test("WS register without transient stays permanent across disconnect", async () => {
  const port = await freePort();
  const engine = makeEngine(port);
  const srv = start(engine, { port });
  try {
    const ws = await connectWs(port);
    ws.send(JSON.stringify({ type: "hello" }));
    await nextMsg(ws, "welcome");
    ws.send(JSON.stringify({ type: "register", name: "Settler" }));
    const reg = await nextMsg(ws, "registered");
    assert.equal(reg.transient, false);
    assert.ok(engine.getAgent(reg.id), "permanent resident present");

    ws.close();
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(engine.getAgent(reg.id), "permanent resident survives socket close");

    engine.saveToDisk();
    const raw = JSON.parse(
      fs.readFileSync(path.join(engine.persistDir, `world-${port}.json`), "utf8")
    );
    assert.ok(raw.agents.some((a) => a.id === reg.id), "permanent resident persisted");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
