// Pluggable resident brain: template fallback, and a fake provider.
// Run: node --test server/__tests__/llm.test.js

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import engineMod from "../engine.js";

const { Engine } = engineMod;

function makeEngine() {
  const e = new Engine();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "island-llm-"));
  e.setPersistOpts({ dir, port: 1 });
  e.spawnRoster();
  return e;
}

test("template brain without a key; provider text when a key is set; fallback on failure", async () => {
  delete process.env.LLM_API_KEY;
  const e = makeEngine();
  const me = e.spawnResident({ name: "Koda" });
  let called = false;
  const offline = await e.say(me.id, "hello", {
    to: "a-Pip",
    fetchImpl: async () => { called = true; return { ok: true, json: async () => ({}) }; },
  });
  assert.equal(called, false);
  assert.equal(offline.replyEntry.source, "template");
  assert.match(offline.replyEntry.text, /Pip/);

  process.env.LLM_API_KEY = "test-not-a-secret";
  process.env.LLM_BASE_URL = "http://127.0.0.1:9/v1";
  try {
    const live = await e.say(me.id, "hello", {
      to: "a-Pip",
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "the tide knows your name" } }] }),
      }),
    });
    assert.equal(live.replyEntry.source, "llm");
    assert.equal(live.replyEntry.text, "the tide knows your name");

    const fell = await e.say(me.id, "hello again", {
      to: "a-Pip",
      fetchImpl: async () => { throw new Error("down"); },
    });
    assert.equal(fell.replyEntry.source, "template");
    assert.match(fell.replyEntry.text, /Pip/);
  } finally {
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;
  }
});
