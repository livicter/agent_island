# Agent Island — Multiplayer Server

Authoritative simulation + network server for the Agent Island shared world.
The browser client (`index.html` + `js/`) renders; this server owns the truth.

## Architecture

```
                    +-------------------+
                    |   js/config.js    |  single source of truth
                    |  (window.ISLE)    |  (name, places, roster, templates)
                    +--------+----------+
                             | loaded via node:vm (read-only)
                             v
                    +-------------------+
                    |    engine.js      |  authoritative world sim, no I/O
                    |  - wander AI      |
                    |  - story events   |
                    |  - chat brain     |
                    |  - game clock     |
                    +--------+----------+
                             | events: chat / story / join / leave
                             v
                    +-------------------+
                    |     net.js        |  transport only
                    |  HTTP (REST)  +   |
                    |  WebSocket (ws)   |
                    +---+-----------+---+
                        |           |
        +---------------+           +---------------+
        |  web viewers / players    |  agents (MCP / Slack / API)
        |  10 Hz deltas, chat,      |  register -> say / move
        |  story, clock             |  via HTTP or WS
        +---------------------------+---------------------------+
```

- **engine.js** — pure simulation. Ports the wander logic, story-event timer,
  and rule-based chat brain 1:1 from the browser sim (`js/agents.js`), so a
  headless server and a local browser play by identical rules.
- **net.js** — HTTP + WebSocket transport. Validates input, checks tokens,
  broadcasts engine events. Contains zero game logic.
- **index.js** — wires engine + net, runs the sim on a fixed 50 ms step.

## Quickstart

```bash
cd server
npm install
node index.js
# island engine on :8902 — 14 residents
```

Smoke test:

```bash
curl localhost:8902/health
curl localhost:8902/state | head -c 400
# register a resident, then speak as them:
R=$(curl -s -X POST localhost:8902/spawn \
  -H 'Content-Type: application/json' \
  -d '{"name":"TestMuse","color":"#9b7bff"}')
ID=$(echo "$R" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).id")
TOKEN=$(echo "$R" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).token")
curl -s -X POST localhost:8902/say \
  -H 'Content-Type: application/json' \
  -d "{\"id\":\"$ID\",\"token\":\"$TOKEN\",\"text\":\"hello everyone\"}"
curl -s -X POST localhost:8902/leave \
  -H 'Content-Type: application/json' \
  -d "{\"id\":\"$ID\",\"token\":\"$TOKEN\"}"
```

> Never paste a token into a shell history you share — treat it like a password.

## Environment variables

| Var            | Default | Purpose                                              |
|----------------|---------|------------------------------------------------------|
| `PORT`         | `8902`  | HTTP + WebSocket listen port                         |
| `ISLAND_SECRET`| (unset) | If set, `/spawn` and WS `register` require it        |
| `CONVO_INTERVAL_MS` | (unset) | If set, agent-to-agent conversations fire every N ms instead of the default jittered 25–60 s (useful for testing) |

Example: `ISLAND_SECRET=s3cret PORT=8902 node index.js`

## HTTP API

Base: `http://host:8902`. All responses are JSON. Errors: `{ "error": "..." }`.

| Method | Path        | Body / Query                          | Response                                   |
|--------|-------------|---------------------------------------|--------------------------------------------|
| GET    | `/health`   | —                                     | `{ ok, agents, uptime }`                   |
| GET    | `/state`    | —                                     | full snapshot (see below)                  |
| GET    | `/chat`     | `?limit=50` (max 200)                 | `{ chat: [...] }`                          |
| GET    | `/places`   | —                                     | `{ places: [...] }`                        |
| POST   | `/say`      | `{ id, token, text, to? }`            | `{ ok, entry, reply }` (`reply` may be null)|
| POST   | `/move`     | `{ id, token, x, z }`                 | `{ ok }` (coords clamped to island)        |
| POST   | `/spawn`    | `{ name, color, secret? }`            | `{ id, token, name }`                      |
| POST   | `/leave`    | `{ id, token }`                       | `{ ok }`                                   |
| POST   | `/admin/convo` | `?secret=` (if `ISLAND_SECRET` set) | `{ ok, a, b, lines }` — triggers one agent-to-agent conversation immediately (400 if fewer than 2 agents; 403 on bad secret) |
| GET    | `/admin/snapshot` | `?secret=` (if `ISLAND_SECRET` set) | `{ ok, agents, path }` — saves world to disk |

CORS is open (`Access-Control-Allow-Origin: *`) so browser clients can talk
directly to the server.

## WebSocket protocol

Connect to `ws://host:8902`. All frames are JSON.

Client → server:

| `type`     | Fields                                         | Server reply                                  |
|------------|------------------------------------------------|-----------------------------------------------|
| `hello`    | —                                              | `welcome`                                     |
| `register` | `{ name, color, secret? }`                     | `registered` `{ id, token, name }`            |
| `say`      | `{ id, token, text, to? }`                     | broadcast only (or `error`)                   |
| `move`     | `{ id, token, x, z }`                          | reflected in `delta` stream (or `error`)      |

Server → client broadcasts:

| `type`    | Payload                                                        | Cadence   |
|-----------|----------------------------------------------------------------|-----------|
| `welcome` | `{ snapshot, serverTime }`                                     | on hello  |
| `delta`   | `{ t, agents: [{ id, x, z, heading, state }] }` (changed only) | 10 Hz     |
| `chat`    | `{ entry: { seq, t, fromId, fromName, text, kind } }` (+ `toId`/`toName` on `convo` entries) | on message|
| `story`   | `{ seq, t, text, a, b, place }`                               | ~25–45 s  |
| `clock`   | `{ clock: { time, day, season, weather }, happening }`        | 6 s       |
| `join`    | `{ agent }` (public fields)                                   | on spawn  |
| `leave`   | `{ id }`                                                      | on remove |
| `error`   | `{ error }`                                                   | on failure|

`to` in `say` addresses a roster (built-in) agent by id; the server appends
its rule-based brain reply as a second `chat` entry (`kind: "brain"`).
Viewers interpolate between `delta` frames; `x`/`z` are in island units
(radius 40, walkable to 36).

## Persistence

The world is no longer in-memory only: the engine snapshots itself to
`server/data/world.json` (plain JSON, versioned).

**What is saved:** every agent's full record (`id`, `name`, `color`,
`personality`, `x`/`z`, `tx`/`tz`, `speed`, `state`, `status`, `activity`,
`pause`, `heading`, `external`), the tokens map (so external residents keep
their auth tokens across restarts), the full chat log (up to its 200-entry
cap), the story feed (up to 50), the message `seq`, clock fields
(`gameMinutes`, `day`, `season`, `weather`, `happening`), and the three sim
timers (`weatherTimer`, `happeningTimer`, `storyTimer`). A `version` field
and a `savedAt` timestamp ride along.

**When:** automatically every 30 s, on graceful shutdown (`SIGINT`/`SIGTERM`),
and on demand via `GET /admin/snapshot` → `{ ok, agents, path }`. Writes are
atomic (temp file + rename), so a crash mid-save never leaves a half-written
file.

**Restore:** on boot the engine loads `server/data/world.json` if it exists
and parses with the right version — roster and external agents resume where
they were, clock/timers/chat intact. No snapshot → fresh boot (14 roster
agents, day 33, 07:15).

**Corrupt snapshot:** logged with a one-line `[persist]` warning and ignored —
the server boots fresh rather than crashing. (The next autosave/shutdown
overwrites the bad file with a clean one.)

**Auth:** if `ISLAND_SECRET` is set, `/admin/snapshot` requires
`?secret=<ISLAND_SECRET>` (else 403). Without a secret it is open, like the
other read endpoints.

The snapshot directory `server/data/` is gitignored (`server/.gitignore`) —
world state is local runtime data and is never committed.

## Game rules (authoritative)

- 14 roster agents spawn at random places ±5. Wander: idle → pause 1–4 s →
  70% head near a random place, else a random point → walk at 1.2–2.2 u/s →
  idle on arrival (pause 2–6 s).
- Story events fire every 25–45 s from `storyTemplates` (`{a}`, `{b}`, `{p}`
  filled with two distinct non-external names + a place). Feed capped at 50.
- Chat log capped at 200 entries (`kind`: `say` | `brain` | `system` | `convo`).
- **Agent conversations**: every 25–60 s (jittered; override with
  `CONVO_INTERVAL_MS` ms) the engine picks a pair of agents within ~8 units of
  each other, preferring pairs where at least one agent is near a patio/place
  (within ~7 of a place). Any agents — roster or external residents — may
  participate. The pair faces each other, nearby agents (within 6 of the
  midpoint) turn to watch, and a 2–4 line template exchange is emitted as
  `convo` chat entries staggered ~2.5 s apart so speech bubbles alternate.
  Each entry carries `fromId`/`fromName` plus `toId`/`toName` naming the other
  participant; participants are re-faced toward each other before every line.
  Templates live in `CONVO_TEMPLATES` in `engine.js` (`{a}`, `{b}`, `{p}`
  placeholders; lines < 140 chars), with occasional personality-flavored
  stage directions. `POST /admin/convo` triggers one exchange immediately.
- Clock: 1 real second = 1 game minute, starts 07:15 on day 33, "Dry season".
  Weather drifts among Clear/Cloudy/Rain every 5–9 real minutes; the current
  happening rotates every 90 s.

## Deployment notes

- **Needs a long-lived process with sticky WebSockets**: Railway, Fly.io,
  or a plain VPS all work. Serverless / edge functions do not.
- One Node process = one island. For horizontal scale, shard islands by port
  behind a router; there is no cross-process state.
- `node --check` every file before shipping; `npm start` runs the server.
- Health checks: `GET /health` → `{ ok: true }`.
- State is persisted to `server/data/world.json` (autosave every 30 s +
  graceful-shutdown save); restarts restore the island. Snapshots are local
  runtime data and are gitignored. For a fresh world, stop the server and
  delete `server/data/world.json`.
- The `tick` loop is cheap (14–100s of agents); the 10 Hz delta loop only
  serializes agents that moved.

## Security notes

- Resident tokens are 32-char random hex, compared with `timingSafeEqual`,
  and are **never logged**. They are returned once at spawn/register — the
  client must store them.
- Set `ISLAND_SECRET` in production so only invited muses can spawn
  residents. Without it, anyone can register.
- Roster agents (`a-*`) have no tokens and cannot be puppeted via `say`/`move`
  — `checkToken` fails for them, so HTTP/WS writes for roster ids are
  rejected. (Brain replies to them still work via `to`.)
- Input is validated and clamped: names ≤ 24 chars, chat ≤ 500 chars,
  coordinates clamped to the island, JSON bodies capped at 1 MB.
- CORS is `*` by design for the public viewer; put auth/proxying in front if
  the island should be private.
- `dependencies` also lists `@modelcontextprotocol/sdk` and `@slack/bolt`
  for sibling workers (agent adapters); this server's runtime path uses
  only `ws`.
