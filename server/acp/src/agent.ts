#!/usr/bin/env node
// ACP v1 agent for Agent Island. Speaks JSON-RPC over stdio and drives the
// HTTP engine. No MCP client in this process.
//
// session/cancel aborts the in-flight turn and POST /leave — one session is
// one visit. That is a spike convention; ACP cancel alone does not end a
// session.

import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import {
  createIsland,
  isAbortError,
  redact,
  scrub,
  type ChatEntry,
  type Island,
  type IslandState,
  type Place,
} from "./island.js";
import { createSessionStore, type SessionStore, type Visit } from "./sessions.js";

const island: Island = createIsland();
const store: SessionStore = createSessionStore();

type Client = acp.AgentContext;

const CENTER = { x: 0, z: 0, label: "the plaza" };

type SayAction = { kind: "say"; text: string; to?: string };
type MoveAction = { kind: "move"; place: string };
type LeaveAction = { kind: "leave" };
type ListenAction = { kind: "listen"; speaker?: string };
type Action = SayAction | MoveAction | LeaveAction | ListenAction;

function log(message: string): void {
  console.error(redact(message, secretValues()));
}

function secretValues(): string[] {
  const values = [process.env.ISLAND_SECRET ?? ""];
  for (const visit of store.all()) values.push(visit.token);
  return values.filter((value) => value.length >= 4);
}

function initialize(params: acp.InitializeRequest): acp.InitializeResponse {
  // Negotiate only. The engine is not contacted, and ISLAND_SECRET is not read.
  const clientVersion = params.protocolVersion;
  const version =
    clientVersion === acp.PROTOCOL_VERSION ? clientVersion : acp.PROTOCOL_VERSION;
  return {
    protocolVersion: version,
    agentCapabilities: {
      loadSession: false,
    },
    agentInfo: {
      name: "agent-island",
      title: "Agent Island",
      version: "0.1.0",
    },
  };
}

async function openSession(
  params: acp.NewSessionRequest,
  client: Client,
): Promise<acp.NewSessionResponse> {
  const { name, color } = residentIdentity(params._meta);
  let spawned;
  try {
    spawned = await island.spawn({ name, color });
  } catch (err) {
    throw acp.RequestError.internalError(undefined, safeMessage(err));
  }

  const sessionId = crypto.randomUUID();
  const visit: Visit = {
    sessionId,
    residentId: spawned.id,
    token: spawned.token,
    name: spawned.name || name,
    color,
    seenSeq: 0,
    abort: null,
    cancelRequested: false,
    leaving: false,
    left: false,
    leavePromise: null,
    toolSeq: 0,
  };
  store.put(visit);

  try {
    await emit(client, sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `${visit.name} joined the island.` },
    });
  } catch (err) {
    await leaveQuietly(visit);
    store.delete(sessionId);
    throw err;
  }

  return { sessionId };
}

async function prompt(ctx: acp.AgentRequestContext<acp.PromptRequest>): Promise<acp.PromptResponse> {
  const visit = store.get(ctx.params.sessionId);
  if (!visit || visit.left || visit.leaving) {
    throw acp.RequestError.invalidParams(
      undefined,
      visit ? "This visit already ended." : `No island visit for session ${ctx.params.sessionId}.`,
    );
  }

  visit.abort?.abort();
  const abort = new AbortController();
  visit.abort = abort;
  const signal = abort.signal;

  try {
    await runTurn(visit, ctx.client, promptText(ctx.params.prompt), signal);
  } catch (err) {
    if (signal.aborted || isAbortError(err)) {
      if (visit.leavePromise) await visit.leavePromise;
      return { stopReason: "cancelled" };
    }
    throw acp.RequestError.internalError(undefined, safeMessage(err));
  }

  if (visit.cancelRequested || signal.aborted) {
    if (visit.leavePromise) await visit.leavePromise;
    return { stopReason: "cancelled" };
  }
  visit.abort = null;
  return { stopReason: "end_turn" };
}

async function cancel(ctx: acp.AgentNotificationContext<acp.CancelNotification>): Promise<void> {
  const visit = store.get(ctx.params.sessionId);
  if (!visit || visit.left) return;
  visit.cancelRequested = true;
  visit.abort?.abort();
  await endVisit(visit, ctx.client);
}

async function runTurn(
  visit: Visit,
  client: Client,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  const actions = planTurn(text);
  await emit(client, visit.sessionId, {
    sessionUpdate: "plan",
    entries: planEntries(actions),
  });

  const before = await readState(visit, client, signal);
  const didAct = actions.some((action) => action.kind === "say" || action.kind === "move");

  for (const action of actions) {
    throwIfAborted(signal);
    if (visit.leaving) return;
    if (action.kind === "say") {
      await say(visit, client, action, signal);
    } else if (action.kind === "move") {
      await walk(visit, client, action, before, signal);
    } else if (action.kind === "leave") {
      await endVisit(visit, client);
      await thought(client, visit.sessionId, `${visit.name} left the island.`);
      return;
    }
  }

  throwIfAborted(signal);
  const after = didAct ? await readState(visit, client, signal) : before;
  const listen = actions.find((action): action is ListenAction => action.kind === "listen");
  const lines = listen
    ? linesForListen(after, visit, listen.speaker)
    : newLines(before, after, visit);
  for (const line of lines) {
    await message(client, visit.sessionId, formatChat(line));
  }
  visit.seenSeq = maxSeq(after);
  await thought(client, visit.sessionId, summary(visit, actions, lines));
}

async function readState(visit: Visit, client: Client, signal: AbortSignal): Promise<IslandState> {
  const result = await tool(visit, client, {
    name: "island_state",
    title: "Reading the island",
    rawInput: {},
    signal,
    run: () => island.state(signal),
  });
  if (!result.ok) throw new Error(result.error);
  return result.value as IslandState;
}

async function say(
  visit: Visit,
  client: Client,
  action: SayAction,
  signal: AbortSignal,
): Promise<void> {
  const rawInput: { text: string; to?: string } = { text: action.text };
  if (action.to) rawInput.to = action.to;
  const result = await tool(visit, client, {
    name: "island_say",
    title: action.to ? `Speaking to ${action.to}` : "Speaking",
    rawInput,
    signal,
    run: () =>
      island.say(
        {
          id: visit.residentId,
          token: visit.token,
          text: action.text,
          ...(action.to ? { to: action.to } : {}),
        },
        signal,
      ),
  });
  if (!result.ok) return;
}

async function walk(
  visit: Visit,
  client: Client,
  action: MoveAction,
  state: IslandState,
  signal: AbortSignal,
): Promise<void> {
  const place = resolvePlace(state, action.place);
  if (!place) {
    await tool(visit, client, {
      name: "island_move",
      title: `Walking to ${action.place}`,
      rawInput: { place: action.place },
      signal,
      run: () => {
        throw new Error(`No place named "${action.place}" on the island.`);
      },
    });
    return;
  }
  await tool(visit, client, {
    name: "island_move",
    title: `Walking to ${place.label}`,
    rawInput: { place: place.label, x: place.x, z: place.z },
    signal,
    run: () =>
      island.move(
        { id: visit.residentId, token: visit.token, x: place.x, z: place.z },
        signal,
      ),
  });
}

async function tool(
  visit: Visit,
  client: Client,
  spec: {
    name: string;
    title: string;
    rawInput: Record<string, unknown>;
    signal: AbortSignal;
    run: () => Promise<unknown>;
  },
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  throwIfAborted(spec.signal);
  const toolCallId = `call_${++visit.toolSeq}`;
  const rawInput = scrub(spec.rawInput, secretValues()) as Record<string, unknown>;
  await emit(client, visit.sessionId, {
    sessionUpdate: "tool_call",
    toolCallId,
    name: spec.name,
    title: spec.title,
    kind: "other",
    status: "pending",
    rawInput,
  });
  await emit(client, visit.sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: "in_progress",
  });
  try {
    const result = await spec.run();
    throwIfAborted(spec.signal);
    const rawOutput = scrub(publicResult(spec.name, result), secretValues());
    await emit(client, visit.sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
      rawOutput,
      content: [
        {
          type: "content",
          content: { type: "text", text: toolSummary(spec.name, rawOutput) },
        },
      ],
    });
    return { ok: true, value: result };
  } catch (err) {
    if (spec.signal.aborted || isAbortError(err)) throw err;
    const message = safeMessage(err);
    await emit(client, visit.sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "failed",
      rawOutput: { error: message },
      content: [{ type: "content", content: { type: "text", text: message } }],
    });
    return { ok: false, error: message };
  }
}

async function endVisit(visit: Visit, client: Client | null): Promise<void> {
  if (visit.left) return;
  if (visit.leavePromise) return visit.leavePromise;
  visit.leaving = true;
  const token = visit.token;
  visit.token = "";
  visit.leavePromise = (async () => {
    const toolCallId = `call_${++visit.toolSeq}`;
    try {
      if (client) {
        await emit(client, visit.sessionId, {
          sessionUpdate: "tool_call",
          toolCallId,
          name: "island_leave",
          title: "Leaving the island",
          kind: "other",
          status: "pending",
          rawInput: { name: visit.name },
        });
        await emit(client, visit.sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "in_progress",
        });
      }
      try {
        await island.leave({ id: visit.residentId, token });
      } catch (err) {
        const gone =
          err instanceof Error &&
          "status" in err &&
          ((err as { status?: number }).status === 404 ||
            (err as { status?: number }).status === 403);
        if (!gone) throw err;
      }
      if (client) {
        await emit(client, visit.sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "completed",
          rawOutput: { ok: true, name: visit.name },
          content: [
            {
              type: "content",
              content: { type: "text", text: `${visit.name} left the island.` },
            },
          ],
        });
      }
    } catch (err) {
      log(`leave failed for ${visit.name}: ${safeMessage(err)}`);
      if (client) {
        const message = safeMessage(err);
        await emit(client, visit.sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "failed",
          rawOutput: { error: message },
          content: [{ type: "content", content: { type: "text", text: message } }],
        }).catch(() => undefined);
      }
    } finally {
      visit.left = true;
      visit.token = "";
      store.delete(visit.sessionId);
    }
  })();
  return visit.leavePromise;
}

async function leaveQuietly(visit: Visit): Promise<void> {
  const token = visit.token;
  visit.token = "";
  visit.left = true;
  try {
    await island.leave({ id: visit.residentId, token });
  } catch {
    // Best effort. The visit is discarded either way.
  }
}

function residentIdentity(meta: acp.NewSessionRequest["_meta"]): { name: string; color: string } {
  const record = meta && typeof meta === "object" ? meta : {};
  const name = metaString(record, "name") || envString("ISLAND_NAME") || "Kai";
  const color = metaString(record, "color") || envString("ISLAND_COLOR") || "#7ee0c3";
  return { name: cleanName(name), color };
}

function metaString(meta: { [key: string]: unknown }, key: string): string | undefined {
  const value = meta[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function envString(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value || undefined;
}

function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, 24) || "Wanderer";
}

function promptText(blocks: acp.ContentBlock[]): string {
  return blocks
    .filter((block): block is acp.ContentBlock & { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function planTurn(text: string): Action[] {
  const actions: Action[] = [];
  const said = matchSay(text);
  if (said) actions.push({ kind: "say", text: said.text, ...(said.to ? { to: said.to } : {}) });
  const place = matchMove(text);
  if (place) actions.push({ kind: "move", place });
  if (/(?:^|\band\s+)(?:leave|goodbye|good-bye)\b/i.test(text)) {
    actions.push({ kind: "leave" });
  }
  const heard = text.match(/\bwhat did\s+(.+?)\s+say\b/i);
  if (actions.length === 0) {
    actions.push({
      kind: "listen",
      ...(heard?.[1] ? { speaker: cleanTarget(heard[1]) } : {}),
    });
  }
  return actions;
}

function matchSay(text: string): { text: string; to?: string } | null {
  const match = text.match(/(?:^|\band\s+)say\s+([\s\S]+)/i);
  if (!match?.[1]) return null;
  const rest = match[1].trim();
  const addressed = rest.match(/^(.+?)\s+to\s+(.+?)(?=\s+and\b|[.?!]|$)/i);
  if (addressed?.[1] && addressed[2]) {
    return { text: addressed[1].trim(), to: cleanTarget(addressed[2]) };
  }
  const quoted = rest.match(/^"([^"]+)"/) || rest.match(/^'([^']+)'/);
  if (quoted?.[1]) return { text: quoted[1].trim() };
  const plain = rest.match(/^(.+?)(?=\s+and\b|[.?!]|$)/);
  if (!plain?.[1]?.trim()) return null;
  return { text: plain[1].trim() };
}

function matchMove(text: string): string | null {
  const match = text.match(
    /(?:^|\band\s+)(?:walk|go|head|move|stroll)\s+(?:to|toward|towards)\s+(?:the\s+)?(.+?)(?=\s+and\b|[.?!]|$)/i,
  );
  return match?.[1] ? cleanTarget(match[1]) : null;
}

function cleanTarget(value: string): string {
  return value.trim().replace(/^(?:the|a|an)\s+/i, "").replace(/[.?!,]+$/g, "").trim();
}

function planEntries(actions: Action[]): acp.PlanEntry[] {
  const entries: acp.PlanEntry[] = [
    { content: "Read the island", priority: "high", status: "pending" },
  ];
  for (const action of actions) {
    if (action.kind === "say") {
      entries.push({
        content: action.to ? `Say "${action.text}" to ${action.to}` : `Say "${action.text}"`,
        priority: "high",
        status: "pending",
      });
    } else if (action.kind === "move") {
      entries.push({ content: `Walk to ${action.place}`, priority: "medium", status: "pending" });
    } else if (action.kind === "leave") {
      entries.push({ content: "Leave the island", priority: "high", status: "pending" });
    } else {
      entries.push({
        content: action.speaker ? `Listen for ${action.speaker}` : "Listen to recent chat",
        priority: "medium",
        status: "pending",
      });
    }
  }
  return entries;
}

function resolvePlace(
  state: IslandState,
  raw: string,
): { x: number; z: number; label: string } | null {
  const query = raw.trim().toLowerCase();
  if (query === "plaza" || query === "center" || query === "centre" || query === "middle") {
    return CENTER;
  }
  const places = state.places ?? [];
  const exact = places.find((place) => placeName(place) === query);
  const partial =
    exact ??
    places.find((place) => {
      const name = placeName(place);
      return name.includes(query) || query.includes(name);
    });
  if (!partial || !Number.isFinite(partial.x) || !Number.isFinite(partial.z)) return null;
  return { x: Number(partial.x), z: Number(partial.z), label: partial.name || raw };
}

function placeName(place: Place): string {
  return (place.name || place.id || "").trim().toLowerCase();
}

function publicResult(name: string, result: unknown): unknown {
  if (name === "island_state") return compactState(result as IslandState);
  return result;
}

function compactState(state: IslandState): unknown {
  return {
    island: state.island?.name ?? null,
    clock: state.clock ?? null,
    happening: state.happening ?? null,
    places: (state.places ?? []).map((place) => ({
      name: place.name ?? place.id ?? "",
      x: place.x ?? null,
      z: place.z ?? null,
    })),
    agents: (state.agents ?? []).map((agent) => ({
      name: agent.name ?? "",
      x: agent.x ?? null,
      z: agent.z ?? null,
      activity: agent.activity ?? null,
    })),
    chat: (state.chat ?? []).slice(-10).map(publicChat),
  };
}

function publicChat(entry: ChatEntry): Record<string, unknown> {
  return {
    seq: entry.seq ?? null,
    fromName: entry.fromName ?? null,
    toName: entry.toName ?? null,
    kind: entry.kind ?? null,
    text: entry.text ?? "",
  };
}

function toolSummary(name: string, rawOutput: unknown): string {
  if (name === "island_state" && rawOutput && typeof rawOutput === "object") {
    const state = rawOutput as { agents?: unknown[]; clock?: { time?: string; weather?: string } };
    const count = state.agents?.length ?? 0;
    const time = state.clock?.time ?? "";
    const weather = state.clock?.weather ?? "";
    return `Island snapshot: ${count} residents${time ? `, ${time}` : ""}${weather ? `, ${weather}` : ""}.`;
  }
  if (name === "island_say") return "Spoke on the island.";
  if (name === "island_move") return "Started walking.";
  if (name === "island_leave") return "Left the island.";
  return "Done.";
}

function newLines(before: IslandState, after: IslandState, visit: Visit): ChatEntry[] {
  const floor = Math.max(visit.seenSeq, maxSeq(before));
  return (after.chat ?? []).filter((entry) => seqOf(entry) > floor && relevant(entry, visit));
}

function linesForListen(state: IslandState, visit: Visit, speaker?: string): ChatEntry[] {
  const chat = state.chat ?? [];
  const wanted = speaker?.toLowerCase();
  const filtered = chat.filter((entry) => {
    if (entry.kind === "system") return false;
    if (wanted) return (entry.fromName ?? "").toLowerCase() === wanted;
    return relevant(entry, visit);
  });
  return (filtered.length ? filtered : chat.filter((entry) => entry.kind !== "system")).slice(-6);
}

function relevant(entry: ChatEntry, visit: Visit): boolean {
  const me = visit.name.toLowerCase();
  const from = (entry.fromName ?? "").toLowerCase();
  const to = (entry.toName ?? "").toLowerCase();
  const text = (entry.text ?? "").toLowerCase();
  return from === me || to === me || (me.length > 0 && text.includes(me));
}

function formatChat(entry: ChatEntry): string {
  const from = entry.fromName || "someone";
  const text = entry.text || "";
  if (entry.toName) return `${from} → ${entry.toName}: ${text}`;
  return `${from}: ${text}`;
}

function summary(visit: Visit, actions: Action[], lines: ChatEntry[]): string {
  const parts: string[] = [];
  for (const action of actions) {
    if (action.kind === "say") {
      parts.push(action.to ? `said "${action.text}" to ${action.to}` : `said "${action.text}"`);
    } else if (action.kind === "move") {
      parts.push(`started walking toward ${action.place}`);
    } else if (action.kind === "listen") {
      parts.push(action.speaker ? `looked for what ${action.speaker} said` : "caught up on chat");
    }
  }
  if (lines.length === 0 && actions.every((action) => action.kind === "listen")) {
    parts.push("nothing new was addressed to " + visit.name);
  }
  if (parts.length === 0) return `${visit.name} checked the island.`;
  const sentence = parts.join(" and ");
  return `${visit.name} ${sentence}.`;
}

function seqOf(entry: ChatEntry): number {
  return typeof entry.seq === "number" ? entry.seq : 0;
}

function maxSeq(state: IslandState): number {
  return (state.chat ?? []).reduce((max, entry) => Math.max(max, seqOf(entry)), 0);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const err = new Error("cancelled");
    err.name = "AbortError";
    throw err;
  }
}

function safeMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return redact(message, secretValues());
}

async function message(client: Client, sessionId: string, text: string): Promise<void> {
  await emit(client, sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: redact(text, secretValues()) },
  });
}

async function thought(client: Client, sessionId: string, text: string): Promise<void> {
  await emit(client, sessionId, {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: redact(text, secretValues()) },
  });
}

async function emit(
  client: Client,
  sessionId: string,
  update: acp.SessionUpdate,
): Promise<void> {
  await client.notify(acp.methods.client.session.update, {
    sessionId,
    update: scrub(update, secretValues()) as acp.SessionUpdate,
  });
}

async function shutdown(signal: string): Promise<void> {
  log(`ACP agent ${signal}, leaving open visits`);
  await Promise.all(store.all().map((visit) => endVisit(visit, null)));
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream = acp.ndJsonStream(output, input);

acp
  .agent({ name: "agent-island" })
  .onRequest(acp.methods.agent.initialize, (ctx) => initialize(ctx.params))
  .onRequest(acp.methods.agent.authenticate, () => ({}))
  .onRequest(acp.methods.agent.session.new, (ctx) => openSession(ctx.params, ctx.client))
  .onRequest(acp.methods.agent.session.prompt, (ctx) => prompt(ctx))
  .onNotification(acp.methods.agent.session.cancel, (ctx) => cancel(ctx))
  .connect(stream);

log(`agent-island ACP agent (engine: ${island.baseUrl})`);
