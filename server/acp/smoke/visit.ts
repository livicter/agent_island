#!/usr/bin/env node
// Scripted ACP client: initialize → session/new → two prompts → cancel/leave.
// Checks that the resident shows up on GET /state and is gone after cancel.
// ISLAND_SECRET is passed only in the agent subprocess environment.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";

const baseUrl = (process.env.ENGINE_URL || "http://localhost:8902").replace(/\/+$/, "");
const secret =
  process.env.ISLAND_SECRET || `acp-smoke-${randomBytes(16).toString("hex")}`;
const resident = "Kai";

type Noted = {
  kind: string;
  text?: string;
  name?: string;
  status?: string;
  stopReason?: string;
};

const notes: Noted[] = [];

function note(entry: Noted): void {
  notes.push(entry);
  const bits = [entry.kind];
  if (entry.name) bits.push(entry.name);
  if (entry.status) bits.push(entry.status);
  if (entry.stopReason) bits.push(entry.stopReason);
  if (entry.text) bits.push(entry.text);
  console.log(bits.join(" | "));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.error(`smoke failed: ${message}`);
    process.exitCode = 1;
    throw new Error(message);
  }
}

function containsSecret(value: unknown): boolean {
  return JSON.stringify(value).includes(secret);
}

async function engineReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function residentPresent(): Promise<boolean> {
  const res = await fetch(`${baseUrl}/state`);
  if (!res.ok) throw new Error(`GET /state -> HTTP ${res.status}`);
  const state = (await res.json()) as { agents?: Array<{ name?: string }> };
  return (state.agents ?? []).some((agent) => agent.name === resident);
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return check();
}

function observe(params: acp.SessionNotification): void {
  assert(!containsSecret(params), "session/update contained ISLAND_SECRET");
  const update = params.update;
  if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
    note({ kind: "agent_message_chunk", text: update.content.text });
    return;
  }
  if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text") {
    note({ kind: "agent_thought_chunk", text: update.content.text });
    return;
  }
  if (update.sessionUpdate === "tool_call") {
    note({
      kind: "tool_call",
      name: update.name ?? undefined,
      status: update.status ?? undefined,
      text: update.title,
    });
    return;
  }
  if (update.sessionUpdate === "tool_call_update") {
    note({ kind: "tool_call_update", status: update.status ?? undefined });
    return;
  }
  if (update.sessionUpdate === "plan") {
    note({ kind: "plan", text: `${update.entries.length} entries` });
  }
}

async function main(): Promise<void> {
  if (!(await engineReachable())) {
    console.error(
      `Engine unreachable at ${baseUrl}.\n` +
        `Start it, then re-run the smoke visit:\n` +
        `  node server/index.js\n` +
        `  cd server/acp && npm run build && npm run smoke`,
    );
    process.exit(2);
  }

  const agentPath = fileURLToPath(new URL("../agent.js", import.meta.url));
  const stderr: Buffer[] = [];
  const child = spawn(process.execPath, [agentPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ENGINE_URL: baseUrl,
      ISLAND_SECRET: secret,
    },
  });
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

  const output = Writable.toWeb(child.stdin!);
  const input = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(output, input);

  try {
    await acp
      .client({ name: "agent-island-smoke" })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        observe(ctx.params);
      })
      .connectWith(stream, async (ctx) => {
        const init = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "agent-island-smoke", version: "0.1.0" },
        });
        assert(!containsSecret(init), "initialize result contained ISLAND_SECRET");
        note({ kind: "initialize", text: `protocolVersion=${init.protocolVersion}` });
        assert(init.protocolVersion === acp.PROTOCOL_VERSION, "unexpected protocol version");

        const session = await ctx.request(acp.methods.agent.session.new, {
          cwd: process.cwd(),
          mcpServers: [],
          _meta: { name: resident, color: "#7ee0c3" },
        });
        assert(!containsSecret(session), "session/new result contained ISLAND_SECRET");
        note({ kind: "session/new", text: session.sessionId });
        assert(
          notes.some(
            (item) => item.kind === "agent_message_chunk" && item.text?.includes(`${resident} joined`),
          ),
          "missing join chunk",
        );
        assert(await residentPresent(), `${resident} did not appear on GET /state`);
        note({ kind: "state", text: `${resident} present` });

        const first = await ctx.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "Say hello to Pip and walk to the plaza" }],
        });
        assert(!containsSecret(first), "first prompt result contained ISLAND_SECRET");
        note({ kind: "session/prompt", stopReason: first.stopReason, text: "hello + plaza" });
        assert(first.stopReason === "end_turn", `first stopReason ${first.stopReason}`);

        const names = new Set(notes.filter((item) => item.kind === "tool_call").map((item) => item.name));
        assert(names.has("island_state"), "missing island_state");
        assert(names.has("island_say"), "missing island_say");
        assert(names.has("island_move"), "missing island_move");
        assert(
          notes.some((item) => item.kind === "tool_call_update" && item.status === "completed"),
          "missing completed tool_call_update",
        );

        const second = await ctx.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "What did Pip say back?" }],
        });
        assert(!containsSecret(second), "second prompt result contained ISLAND_SECRET");
        note({ kind: "session/prompt", stopReason: second.stopReason, text: "pip reply" });
        assert(second.stopReason === "end_turn", `second stopReason ${second.stopReason}`);
        assert(
          notes.some(
            (item) => item.kind === "agent_message_chunk" && /pip/i.test(item.text ?? ""),
          ),
          "Pip's reply was not surfaced",
        );

        await ctx.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
        note({ kind: "session/cancel" });

        const gone = await waitUntil(async () => {
          const present = await residentPresent();
          const left = notes.some((item) => item.kind === "tool_call" && item.name === "island_leave");
          return !present && left;
        }, 4000);
        assert(gone, `${resident} still present after cancel, or island_leave was not reported`);
        note({ kind: "state", text: `${resident} absent` });
      });
  } finally {
    const errText = Buffer.concat(stderr).toString("utf8");
    if (errText.trim()) {
      assert(!errText.includes(secret), "agent stderr contained ISLAND_SECRET");
      console.log("--- agent stderr ---");
      console.log(errText.trim());
    }
    child.kill("SIGTERM");
  }

  if (process.exitCode) return;
  console.log("smoke ok");
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes(secret)) {
    console.error("smoke failed: error text contained ISLAND_SECRET");
  } else {
    console.error("smoke failed:", message);
  }
  process.exit(process.exitCode && process.exitCode !== 0 ? process.exitCode : 1);
});
