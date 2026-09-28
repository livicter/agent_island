// Browser and server must share one wander step and one chat brain.
// Run: node --test server/__tests__/sim-core.test.js

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sim from "../../js/sim-core.js";
import engineMod from "../engine.js";

const { Engine } = engineMod;

test("stepAgent walks toward the target and stops inside 0.4", () => {
  const agent = {
    x: 0, z: 0, tx: 5, tz: 0, state: "walking", speed: 2,
    pause: 0, heading: 0, status: "idle", activity: "idle",
  };
  sim.stepAgent(agent, 1, { places: [], radius: 40 });
  assert.ok(agent.x > 1.9 && agent.x < 2.1);
  assert.equal(agent.state, "walking");
  sim.stepAgent(agent, 2, { places: [], radius: 40 });
  assert.ok(Math.abs(agent.x - 5) < 1e-9);
  sim.stepAgent(agent, 0.1, { places: [], radius: 40 });
  assert.equal(agent.state, "idle");
});

test("engine.chatBrain is the shared module, not a second copy", () => {
  const e = new Engine();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "island-sim-"));
  e.setPersistOpts({ dir, port: 1 });
  e.spawnRoster();
  const pip = e.getAgent("a-Pip");
  pip.status = "idle";
  const ctx = {
    agent: pip,
    text: "hello",
    islandName: "Dawnbreak",
    places: [],
    others: [pip],
    fallbacks: ["fallback"],
  };
  assert.equal(e.chatBrain("a-Pip", "hello"), sim.chatReply(ctx));
  assert.match(e.chatBrain("a-Pip", "hello"), /I'm Pip/);
});
