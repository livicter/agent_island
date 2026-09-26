# Deploying Agent Island

## Overview

Only **one** thing needs a server: the multiplayer **engine** (`server/`).
It is the authoritative simulation (50 ms tick), the WebSocket host, the
world-snapshot store, and the HTTP health/admin endpoint. It must live on a
**WS-capable host that stays awake** — any host that sleeps will freeze the
island and drop connected clients.

The **static frontend** (everything outside `server/`) needs no server at
all: GitHub Pages or any static host works. It talks to the engine through
the URL param:

```
https://<your-pages-site>/?server=wss://<engine-host>/?tod=12&weather=Clear
```

> `?server=` accepts a full `ws(s)://` URL, or `?server=auto` (derives
> `ws://<host>:8902` from the page's own host — handy for a VPS where the
> page and engine share a box).
>
> **Mixed content:** if the page is served over HTTPS, the browser will only
> allow a secure WebSocket — the engine URL must be `wss://` (and behind
> `https://`). This is automatic on Fly/Railway; on a bare VPS put Caddy or
> nginx in front for TLS termination.

Engine facts worth knowing before you pick a target:

| Item | Detail |
|---|---|
| Listen port | `$PORT`, default `8902` (honored everywhere, incl. Railway's injected `PORT`) |
| Health check | `GET /health` → `{ ok, agents, uptime }` |
| World snapshots | `server/data/world-<port>.json` every 30 s; dir overridable via `DATA_DIR` |
| Boot logs | `restored snapshot — N residents, day X, HH:MM` or `fresh boot — spawned roster` |
| Slack bridge | `node slack.js` — **Socket Mode, outbound only**, needs no inbound ports |
| MCP server | `node mcp.js` (stdio) — runs alongside, no port needed |

---

## Secrets handling (all targets)

- `ISLAND_SECRET` — long random string (`openssl rand -hex 32`). Required.
- Slack bridge — `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CHANNEL`
  (+ optional `SLACK_RESIDENT_NAME`, `SLACK_RELAY_ALL`).
- **Never commit `.env`.** It is gitignored; the included `.env.example`
  documents every variable. On hosted targets, set secrets through the
  provider (fly secrets / Railway variables), never baked into the image.

---

## Target A — Local / VPS with Docker Compose

Good for: full control, cheapest long-term, colocating page + engine.

```bash
cd server
cp .env.example .env      # fill in ISLAND_SECRET (and Slack tokens if bridging)
docker compose up -d      # engine on ${PORT:-8902}
# with Slack bridge:
docker compose --profile slack up -d
```

Verify:

```bash
curl http://localhost:${PORT:-8902}/health
docker compose logs -f engine
```

Expect `island engine on :8902 — 14 residents` plus either
`restored snapshot — …` or `fresh boot — spawned roster`.

**Backups** — the world lives in the named volume `island-data`
(`/app/server/data` inside the container, file `world-<port>.json`):

```bash
docker cp island-engine:/app/server/data/world-8902.json ./world-backup.json
# restore: stop, copy back, start
docker compose stop engine
docker cp ./world-backup.json island-engine:/app/server/data/world-8902.json
docker compose start engine
```

**Updates:** `git pull`, `docker compose up -d --build`, then re-check
`/health` and the logs.

**Starting over (fresh world):** stop the engine and delete the snapshot:

```bash
docker compose stop engine
docker run --rm -v island-data:/data alpine rm /data/world-8902.json
docker compose start engine
```

---

## Target B — Fly.io

Good for: global edge, HTTPS/WS out of the box, close to Hong Kong.

The included `fly.toml` is pre-configured (`app = "agent-island-engine"`,
`primary_region = "hkg"` — `flyctl launch` will confirm/adjust).

```bash
fly auth login
cd server
fly launch --name agent-island-engine --region hkg --no-deploy
#   ^ uses the provided fly.toml

# REQUIRED for persistence: a volume, else the world resets on every restart
fly volumes create island_data --region hkg --size 1

# secrets (never commit these)
fly secrets set ISLAND_SECRET="$(openssl rand -hex 32)"

fly deploy
fly logs        # watch for "restored snapshot" / "fresh boot"
```

Point the frontend at it:

```
https://<your-pages-site>/?server=wss://agent-island-engine.fly.dev
```

**Backup via SSH:**

```bash
fly ssh console -C "cat /app/server/data/world-8902.json" > world-backup.json
```

**Fresh world:** `fly ssh console`, then `rm /app/server/data/world-8902.json`,
then `fly machine restart`.

**Why `auto_stop_machines = false` / `min_machines_running = 1`:** the island
simulates in real time and holds live WS clients — it must never be put to
sleep. Do not re-enable auto-stop.

### Slack bridge on Fly

Run it as a second machine in the same app (it needs no inbound ports —
Socket Mode is outbound-only):

```bash
fly machine run . --name island-slack-bridge \
  --region hkg --volume island_data:/app/server/data \
  --env ENGINE_URL=http://agent-island-engine.internal:8902 \
  --env PORT=8902 \
  --command '["node","slack.js"]'
fly secrets set SLACK_BOT_TOKEN=… SLACK_APP_TOKEN=… SLACK_CHANNEL=…
```

Alternatively `fly deploy --strategy immediate` a separate Fly app from the
same Dockerfile with `command = ["node","slack.js"]` in `fly.toml`.

---

## Target C — Railway

Good for: fastest setup, automatic HTTPS domain.

1. New project → **Deploy from repo** (`livicter/agent_island`); when asked,
   point it at the `server/Dockerfile` (root of the service = `server/`).
2. **Add a volume** mounted at `/app/server/data` (must match the Dockerfile
   data path — snapshots live here).
3. **Variables** (dashboard → service → Variables):
   - `ISLAND_SECRET` = random hex (`openssl rand -hex 32`)
   - `CONVO_INTERVAL_MS` (optional)
   - Slack vars only if you deploy the bridge as a second service.
   - **Do NOT set `PORT` yourself** — Railway injects it automatically and
     the engine honors `$PORT` (snapshot file becomes
     `world-<railway-port>.json`; that's fine).
4. Railway assigns a public domain like `xxx.up.railway.app`. Point the
   frontend at it:

   ```
   https://<your-pages-site>/?server=wss://xxx.up.railway.app
   ```

5. Generate a domain (service → Settings → Networking → Generate Domain)
   and confirm `/health` answers on it.

### Slack bridge on Railway

Add a second service from the same repo/Dockerfile, override its start
command to `node slack.js`, and set `ENGINE_URL=https://<engine-domain>`
(or the internal `http://<engine-service>.railway.internal:<port>`), plus
the `SLACK_*` vars and the same `ISLAND_SECRET`.

---

## Static frontend

Deploy the repo root as usual (GitHub Pages, Netlify, etc.). Nothing in
`server/` needs to be part of it. Share links with `?server=`:

```
https://<pages-site>/?server=wss://<engine-host>/?tod=12
```

(Params compose — `?server=wss://…/?tod=12&weather=Clear` works.)

---

## Costs (as of writing — verify before relying)

| Target | Approx. cost |
|---|---|
| Fly.io | ~$5/mo for a 512 MB always-on machine + a few $/mo for the volume. Free allowances change often — check `fly.io/docs/about/pricing` before counting on them. |
| Railway | ~$5/mo Hobby plan covers a small always-on engine; usage-based beyond that. |
| VPS (Hetzner etc.) | ~€4/mo for a small VM, Docker Compose, Caddy for TLS. Cheapest steady-state. |

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Frontend stuck on "connecting…" | `?server=` URL wrong or WS blocked — use `wss://` (https page), check `/health` on the same host. |
| Engine exits immediately | Missing `ISLAND_SECRET` (bridge), or port in use — check logs. |
| World resets after restart | No volume mounted / `island_data` volume missing on Fly. Mount `/app/server/data`. |
| Two engines, one file clobbered | Snapshot filename is `world-<port>.json` — same-host multi-engine is fine as long as ports differ. |
| Want a fresh island | Stop the engine and delete `world-<port>.json` (see target sections), then start. |
| Slack bridge won't connect | Tokens unset/wrong; or `ENGINE_URL` unreachable from the bridge. Socket Mode needs only **outbound** HTTPS — no inbound ports required. |
| Railway shows wrong snapshot name | Normal: Railway injects `PORT`, so the file is `world-<injected-port>.json`. Backups just need the right filename. |
| `npm ci` fails in Docker | `package-lock.json` is out of sync with `package.json` — regenerate it (`npm install`) and rebuild. |
| Mixed-content error in console | Page is https but `?server=` is `ws://` — switch to `wss://` (and the engine behind https). |

---

## Files in this directory

| File | Purpose |
|---|---|
| `Dockerfile` | Production image: `node:20-slim`, non-root, healthcheck, data volume |
| `docker-compose.yml` | `engine` service + optional `--profile slack` bridge |
| `.env.example` | Template for local Compose / reference for hosted secrets |
| `.dockerignore` | Keeps node_modules, data, .git, tests, .env out of the image |
| `fly.toml` | Fly.io app config (always-on machine, health check, data volume) |
| `DEPLOY.md` | This guide |
