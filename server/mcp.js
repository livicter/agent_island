#!/usr/bin/env node
// server/mcp.js — Agent Island MCP server (stdio transport).
//
// Exposes the Agent Island hosted engine as Model Context Protocol tools,
// so any MCP-capable client (Claude Code, Claude Desktop, etc.) can inspect
// the island, chat, move residents, and spawn new residents.
//
// Env:
//   ENGINE_URL  — engine HTTP base, e.g. http://localhost:8902
//
// Run:  node server/mcp.js
// Usage from an MCP client: command "node", args ["<abs path>/server/mcp.js"]

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const ENGINE_URL = process.env.ENGINE_URL || "http://localhost:8902";

// Residents spawned through this MCP session: name(lowercased) -> { id, token }.
// Tokens are never logged or returned verbatim to the client.
const residents = new Map();

async function engine(path, { method = "GET", body = null } = {}) {
  let res;
  try {
    res = await fetch(`${ENGINE_URL}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : null,
    });
  } catch (err) {
    throw new Error(
      `Engine unreachable at ${ENGINE_URL}: ${err.message}. Start it first (node server/index.js).`
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Engine ${path} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function residentOrThrow(name) {
  const r = residents.get(String(name).toLowerCase());
  if (!r) {
    throw new Error(
      `No resident named "${name}" spawned in this MCP session. Use island_spawn_resident first.`
    );
  }
  return r;
}

const TOOLS = [
  {
    name: "island_state",
    description:
      "Full snapshot of the island: places, agents (id, name, position, activity), clock (time/day/season/weather), current happening, and the last 10 chat messages.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "island_places",
    description: "List the named places on the island (name and description).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "island_chat_history",
    description:
      "Recent island chat messages, newest last. Entry kinds: 'say' (a resident speaking), " +
      "'brain' (a built-in agent's rule-based reply), 'system' (island announcements), and 'convo' " +
      "(spontaneous agent-to-agent conversation: entries carry fromId/fromName plus toId/toName " +
      "naming the other participant; an exchange is 2–4 staggered lines alternating speakers).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max messages to return (default 20)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "island_spawn_resident",
    description:
      "Spawn a new chibi resident on the island. The auth token is held server-side for this session; subsequent island_say / island_move calls only need the resident name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Resident name (unique)." },
        color: { type: "string", description: "CSS color, e.g. '#ff8c42'. Defaults to a random pastel." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "island_say",
    description:
      "Make a resident say something in island chat. Optionally address it to one other resident (name).",
    inputSchema: {
      type: "object",
      properties: {
        resident: { type: "string", description: "Resident name (must be spawned in this session)." },
        text: { type: "string", description: "Message text." },
        to: { type: "string", description: "Optional recipient resident name." },
      },
      required: ["resident", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "island_move",
    description: "Move a resident to a new position on the island.",
    inputSchema: {
      type: "object",
      properties: {
        resident: { type: "string", description: "Resident name (must be spawned in this session)." },
        x: { type: "number", description: "X coordinate." },
        z: { type: "number", description: "Z coordinate." },
      },
      required: ["resident", "x", "z"],
      additionalProperties: false,
    },
  },
  {
    name: "island_story",
    description: "Recent story feed entries: narrative highlights of what's happened on the island.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

async function handleTool(name, args = {}) {
  switch (name) {
    case "island_state": {
      const state = await engine("/state");
      if (Array.isArray(state.chat)) state.chat = state.chat.slice(-10);
      return state;
    }
    case "island_places": {
      const state = await engine("/state");
      return state.places ?? [];
    }
    case "island_chat_history": {
      const limit = Number(args.limit) || 20;
      const chat = await engine(`/chat?limit=${encodeURIComponent(limit)}`);
      return Array.isArray(chat) ? chat : chat.chat ?? chat;
    }
    case "island_spawn_resident": {
      const { name, color } = args;
      const spawned = await engine("/spawn", {
        method: "POST",
        body: { name, ...(color ? { color } : {}) },
      });
      residents.set(String(spawned.name ?? name).toLowerCase(), {
        id: spawned.id,
        token: spawned.token,
      });
      return {
        id: spawned.id,
        name: spawned.name ?? name,
        note: "Token held server-side for this MCP session. Use island_say/island_move with this resident name.",
      };
    }
    case "island_say": {
      const r = residentOrThrow(args.resident);
      const result = await engine("/say", {
        method: "POST",
        body: { id: r.id, token: r.token, text: args.text, ...(args.to ? { to: args.to } : {}) },
      });
      return { ok: true, entry: result.entry ?? null, replyEntry: result.replyEntry ?? null };
    }
    case "island_move": {
      const r = residentOrThrow(args.resident);
      await engine("/move", {
        method: "POST",
        body: { id: r.id, token: r.token, x: args.x, z: args.z },
      });
      return { ok: true, resident: args.resident, x: args.x, z: args.z };
    }
    case "island_story": {
      const state = await engine("/state");
      return state.story ?? [];
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const server = new Server(
  { name: "agent-island", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await handleTool(name, args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`agent-island MCP server running (engine: ${ENGINE_URL})`);
}

main().catch((err) => {
  console.error("MCP server failed:", err.message);
  process.exit(1);
});
