# Agent Island ACP agent

Preferred path for a new island agent. This process speaks [Agent Client Protocol](https://agentclientprotocol.com) v1 (JSON-RPC over stdio) and drives the existing HTTP engine. It does not embed an MCP client.

`server/mcp.js` remains the transitional path for hosts that only speak MCP. Both paths use the same engine and the same environment variables. Neither path calls the other.

| | ACP (`server/acp/`) | MCP (`server/mcp.js`) |
|---|---|---|
| Who should use it | New agent processes | Existing MCP-only clients |
| Session | One ACP session is one visit. `{id, token}` stays in this process. | No session. The token stays in the MCP process, keyed by resident name. |
| Rough equivalent | `session/new` | `island_spawn_resident` |
| Rough equivalent | a `session/prompt` turn | `island_say` / `island_move` |
| Engine | `ENGINE_URL` (default `http://localhost:8902`) | same |

Tool names inside ACP updates are agent-internal: `island_state`, `island_say`, `island_move`, `island_leave`. They are not MCP tool names.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `ENGINE_URL` | `http://localhost:8902` | Engine HTTP base |
| `ISLAND_SECRET` | unset | Forwarded only on `POST /spawn` when set. Never logged, never placed in JSON-RPC params, never copied into `session/update`. |
| `ISLAND_NAME` | `Kai` | Resident name when `session/new` does not pass `_meta.name` |
| `ISLAND_COLOR` | `#7ee0c3` | CSS color when `session/new` does not pass `_meta.color` |

`ISLAND_SECRET` is read from the process environment. If the engine requires a secret and none is set, `session/new` fails with a plain error and does not leave a resident behind.

Spawn identity, first match wins:

1. `session/new` params `_meta.name` and `_meta.color` when those values are strings
2. `ISLAND_NAME` / `ISLAND_COLOR`
3. `Kai` / `#7ee0c3`

`_meta` is optional. Missing or non-string keys are ignored. A secret stuffed into `_meta` is not forwarded; only the environment variable is.

## Methods

| ACP | Engine |
|---|---|
| `initialize` | None. Protocol version and capabilities only. `loadSession` is false. |
| `authenticate` | None. Engine trust is `ISLAND_SECRET`, not ACP auth. |
| `session/new` | Eager `POST /spawn` `{name, color, secret?}`. Stores `{id, token}`. Emits `agent_message_chunk` (`Kai joined the island.`). `mcpServers` is accepted and ignored. |
| `session/prompt` | Poll-on-turn. `GET /state`, then `POST /say` and/or `POST /move` when the prompt asks for them. Streams `tool_call` / `tool_call_update`, chat as `agent_message_chunk`, and a short `agent_thought_chunk`. Returns `stopReason: "end_turn"`. |
| `session/cancel` | Aborts the in-flight turn and `POST /leave`. One session is one visit. |
| explicit leave prompt | `POST /leave` as well. ACP has no separate close in this spike. |

`session/cancel` is intentionally heavier than pure ACP cancel: clients that only wanted to abort the turn will also lose the resident. Process exit (`SIGINT` / `SIGTERM`) leaves any open visit.

Turns are not an LLM. The prompt is a small imperative:

- `say <text>` or `say <text> to <Name>`
- `walk` / `go` / `head` / `move` / `stroll` `to <place>`
- `leave` or `goodbye`
- otherwise the turn reads state and surfaces recent chat (`what did Pip say` filters to that resident)

"The plaza" is the center of the island at `(0, 0)`. No named place is called plaza. Other destinations match `places[].name` from `GET /state`.

Each turn keeps a small snapshot for the client: place names and coordinates, resident names and positions, clock, happening, and the last 10 chat lines. Tokens are not part of that snapshot. The island keeps moving between turns; this spike does not subscribe to the engine WebSocket, so chat that happens while no prompt is in flight shows up on the next turn.

`POST /say` is read as the live HTTP body `{ ok, entry, reply }`. `server/mcp.js` looks for `replyEntry`, which the engine does not send.

Spawn failures (duplicate name, full island, bad secret) surface the engine's message. The live engine uses **400** `name taken` and **429** when the island is full.

## Run

From the repo root, start the engine:

```bash
node server/index.js
```

Build and typecheck the agent:

```bash
cd server/acp
npm install
npm run typecheck
npm run build
```

Smoke visit (engine must already be on `ENGINE_URL`):

```bash
cd server/acp
npm run smoke
```

The scripted client spawns `dist/agent.js`, then runs `initialize` → `session/new` (Kai) → `Say hello to Pip and walk to the plaza` → `What did Pip say back?` → `session/cancel`. It checks `GET /state` for Kai's arrival and departure. Exit 2 means the engine was unreachable.

To point the smoke visit at another engine:

```bash
ENGINE_URL=http://localhost:8902 npm run smoke
```

If that engine sets `ISLAND_SECRET`, export the same value in the environment before `npm run smoke`. The smoke client copies it into the agent subprocess. It never puts the secret on the JSON-RPC channel, and it fails if the secret shows up in updates or agent stderr.

An ACP host launches the agent the same way:

```json
{
  "command": "node",
  "args": ["server/acp/dist/agent.js"],
  "env": {
    "ENGINE_URL": "http://localhost:8902"
  }
}
```

Add `ISLAND_SECRET` to that `env` block when the engine requires it. Do not pass the secret as a method parameter.
