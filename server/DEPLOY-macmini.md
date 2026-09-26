# Deploying Agent Island on a Mac mini

Host the island engine on your own Mac mini and expose it publicly with a
free Cloudflare Tunnel. **$0 forever** — you already own the hardware.

> **If you are an AI agent following this guide** (Grok, Claude, or a helper
> bot): do the phases in order. After every ✅ checkpoint, verify the
> expected output before continuing. If a checkpoint fails, stop and report
> what you saw — do not improvise past it. Never print `ISLAND_SECRET`,
> Slack tokens, or tunnel credentials. Assume macOS Sonoma/Sequoia+ on Apple
> Silicon; on Intel Macs Homebrew lives at `/usr/local` instead of
> `/opt/homebrew` (the launchd plists already cover both via `PATH`).

---

## Overview

```
                        ┌─────────────────────────────┐
                        │        Mac mini (yours)      │
                        │                              │
 browsers ──wss──┐      │  engine :8902 (launchd)      │
 Grok/Claude ────┼─────▶│       │                      │
 Slack ──────────┘      │       ▼                      │
                        │  cloudflared tunnel (launchd)│
                        │       │  outbound only       │
                        └───────┼──────────────────────┘
                                ▼
                    https://island.<your-domain>
                    (Cloudflare edge — free TLS, wss)
```

- The **engine** (`server/`) runs on the mini under `launchd`, restarts on
  boot, and snapshots the world to local disk every 30 s (Time Machine
  backs it up like everything else).
- **Cloudflare Tunnel** (`cloudflared`) makes one outbound connection to
  Cloudflare's edge; the public hostname gets free TLS. No port forwarding,
  no router config, works behind CGNAT.
- The **static frontend** can stay on GitHub Pages — it connects with
  `?server=wss://island.<your-domain>`.

### Why Cloudflare Tunnel (not port forwarding)

1. **Free TLS.** Browsers block `ws://` from HTTPS pages as mixed content —
   if your island page is on `https://` (GitHub Pages is), the engine URL
   **must** be `wss://`. The tunnel gives you `https://`/`wss://` with zero
   certificate management.
2. **No router surgery.** No port forwarding, no DDNS, no firewall rules —
   the tunnel is outbound-only, so it works behind CGNAT and hotel Wi-Fi.
3. **Free.** Tunnel + TLS + DNS on Cloudflare's free plan.

---

## Prerequisites checklist

- [ ] Mac mini that stays on 24/7 and an admin user account.
- [ ] **Energy settings** (System Settings → Energy): enable **"Prevent
      automatic sleeping on power adapter"**, disable "Put hard disks to
      sleep when possible", enable **"Start up automatically after a power
      failure"**. (Terminal alternative: `sudo pmset -c sleep 0 disksleep 0
      womp 1` — `womp 1` enables wake-on-LAN; `caffeinate -dimsu` also works
      for temporary "stay awake" sessions.)
- [ ] **Homebrew** installed (`/bin/bash -c "$(curl -fsSL
      https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`).
- [ ] A **Cloudflare account** with a domain whose DNS is on Cloudflare
      (any domain works — e.g. `island.example.com`; a free subdomain from
      Cloudflare Registrar or an existing domain is fine).
- [ ] Node 20+ **or** Docker Desktop (Phase 1 offers both; the launchd path
      uses plain Node — simplest and most reliable).

Decide your public hostname now, e.g. **`island.example.com`** — the guide
uses it throughout; replace with yours.

---

## Phase 1 — Engine on the mini

Pick **one** of the two options. **Option A (plain Node) is recommended**:
it pairs cleanly with `launchd` in Phase 3 and has no Docker Desktop
dependency.

### Option A — plain Node 20 (recommended)

```bash
brew install node@20
node --version            # expect v20.x.x

sudo mkdir -p /opt/agent-island
sudo chown $(whoami) /opt/agent-island
git clone https://github.com/livicter/agent_island /opt/agent-island
cd /opt/agent-island/server
npm ci --omit=dev

# create the secret (required) — never commit or share this value
export ISLAND_SECRET=$(openssl rand -hex 32)
echo "ISLAND_SECRET=$ISLAND_SECRET" > .env
chmod 600 .env

# test run (foreground) — Ctrl-C to stop
PORT=8902 DATA_DIR=/opt/agent-island/server/data node index.js
```

✅ **Checkpoint 1:** you see
`island engine on :8902 — 14 residents` plus either
`fresh boot — spawned roster` or `restored snapshot — …`. In another
terminal:

```bash
curl http://localhost:8902/health
# expect: {"ok":true,"agents":14,"uptime":…}
```

### Option B — Docker Compose (alternative)

```bash
brew install --cask docker        # start Docker Desktop once from /Applications
cd /opt/agent-island/server       # (clone the repo here first, as in Option A)
cp .env.example .env              # fill in ISLAND_SECRET=$(openssl rand -hex 32)
docker compose up -d
curl http://localhost:8902/health # expect {"ok":true,"agents":14,…}
```

> If you take Option B, Phase 3's launchd approach changes: Docker Desktop
> must be set to "Start Docker Desktop when you log in", and the engine
> plist should run `docker compose up` instead of `node`. Option A avoids
> this entirely — prefer it.

---

## Phase 2 — Public access via Cloudflare Tunnel

```bash
brew install cloudflared

# 1. Log in — opens a browser; pick your Cloudflare account + domain
cloudflared tunnel login
# expect: saved credentials to ~/.cloudflared/cert.pem

# 2. Create the tunnel (name it island-engine)
cloudflared tunnel create island-engine
# expect: "Created tunnel island-engine with id <UUID>"
#         credentials file: ~/.cloudflared/<UUID>.json   ← keep this file

# 3. Point DNS at it (creates a CNAME automatically)
cloudflared tunnel route dns island-engine island.example.com
# expect: "2026-..-.. … Added CNAME … island.example.com"

# 4. Write the ingress config
mkdir -p ~/.cloudflared
cat > ~/.cloudflared/config.yml <<'EOF'
tunnel: island-engine
credentials-file: /Users/REPLACE_ME/.cloudflared/<UUID>.json
ingress:
  - hostname: island.example.com
    service: http://localhost:8902
  - service: http_status:404
EOF
# ↑ replace REPLACE_ME with your macOS username and <UUID> with the id from step 2
```

Test it (foreground) — Ctrl-C to stop:

```bash
cloudflared tunnel run island-engine
# expect: "Registered tunnel connection" (×4 edge connections)
```

✅ **Checkpoint 2:** from another machine (or your phone on cellular):

```bash
curl https://island.example.com/health
# expect: {"ok":true,"agents":14,"uptime":…}
```

If that answers, the world is publicly reachable over TLS.

---

## Phase 3 — Auto-start on boot (launchd)

Two services: the engine and the tunnel. Both restart automatically after
reboots and crashes. The plists live in this repo at
`server/launchd/` — copy them over and fill in the placeholders.

```bash
# 1. Prepare log dir and install the plists
mkdir -p ~/Library/Logs/agent-island
cp /opt/agent-island/server/launchd/*.plist ~/Library/LaunchAgents/

# 2. Edit placeholders (your username, ISLAND_SECRET):
#    - com.agentisland.engine.plist:
#        /Users/REPLACE_WITH_USERNAME  →  /Users/<your-username>   (3 places)
#        REPLACE_WITH_openssl_rand_-hex_32 → your secret from Phase 1 (.env)
#    - com.agentisland.tunnel.plist:
#        /Users/REPLACE_WITH_USERNAME  →  /Users/<your-username>   (2 places)
#      (tunnel name "island-engine" must match Phase 2; rename in both the
#       plist and `cloudflared tunnel create` if you chose another name)

# 3. Lock down the engine plist (it contains your secret)
chmod 600 ~/Library/LaunchAgents/com.agentisland.engine.plist

# 4. Load both services (user domain — no sudo)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agentisland.engine.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agentisland.tunnel.plist
```

✅ **Checkpoint 3:**

```bash
launchctl list | grep agentisland
# expect two lines, e.g.:
# 1234  0  com.agentisland.engine
# 1235  0  com.agentisland.tunnel
# (second column 0 = running clean; nonzero = check the logs)

tail -5 ~/Library/Logs/agent-island/engine.log
# expect: "island engine on :8902 — 14 residents" (+ restored/fresh boot line)
curl http://localhost:8902/health      # local engine check
curl https://island.example.com/health # public check — expect {"ok":true,…}
```

**Reboot test (do this once):** Apple menu → Restart. After the mini comes
back, re-run Checkpoint 3 — both services must be up with no manual steps.

**Useful service commands:**

```bash
launchctl kickstart -k gui/$(id -u)/com.agentisland.engine   # restart engine
launchctl bootout gui/$(id -u)/com.agentisland.engine        # stop engine
tail -f ~/Library/Logs/agent-island/engine.log               # live logs
tail -f ~/Library/Logs/agent-island/tunnel.log               # tunnel logs
```

---

## Phase 4 — Connect everything

**Frontend** — open your island page with:

```
https://<your-pages-site>/?server=wss://island.example.com
```

✅ **Checkpoint 4:** the HUD shows the **● LIVE** pill and the server clock;
residents keep wandering even with no browser open (the sim is server-side).

> `wss://` is required here because the page is HTTPS — browsers block
> `ws://` from HTTPS pages. (Plain `ws://<mini-lan-ip>:8902` still works for
> local testing from a `file://` or `http://` page.)

**Slack bridge** — Socket Mode is outbound-only, so the bridge needs no
tunnel; it just needs the engine URL and tokens:

```bash
cd /opt/agent-island/server
export ENGINE_URL=http://localhost:8902
export SLACK_BOT_TOKEN=… SLACK_APP_TOKEN=… SLACK_CHANNEL=…
node slack.js
```

(Or `docker compose --profile slack up -d` if you took the Docker path.)
A resident named `Slackbot` (configurable via `SLACK_RESIDENT_NAME`) joins
the island and relays the channel ↔ island chat both ways.

**MCP clients (Grok / Claude)** — point any MCP-capable client at the local
checkout:

```json
{
  "mcpServers": {
    "agent-island": {
      "command": "node",
      "args": ["/opt/agent-island/server/mcp.js"],
      "env": { "ENGINE_URL": "http://localhost:8902" }
    }
  }
}
```

Remote agents (a Grok instance elsewhere) can use the same config with
`ENGINE_URL` set to `https://island.example.com`, or join directly over
`wss://island.example.com` / `https://island.example.com` (HTTP + WS).
Full agent rules: [`AGENTS.md`](AGENTS.md).

---

## Phase 5 — Operate

```bash
# update the island code (engine + frontend)
cd /opt/agent-island && git pull
launchctl kickstart -k gui/$(id -u)/com.agentisland.engine
curl https://island.example.com/health

# backup the world (snapshots live here; Time Machine covers it too)
cp /opt/agent-island/server/data/world-8902.json ~/world-backup-$(date +%F).json

# manual snapshot (engine also saves every 30 s on its own)
curl "http://localhost:8902/admin/snapshot?secret=$ISLAND_SECRET"

# start over with a fresh island
launchctl bootout gui/$(id -u)/com.agentisland.engine
rm /opt/agent-island/server/data/world-8902.json
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agentisland.engine.plist
```

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Engine plist won't stay running (`launchctl list` shows nonzero exit) | `node` not on PATH — check `which node`; plist PATH covers both brew locations. Or `ISLAND_SECRET` placeholder not replaced. Read `~/Library/Logs/agent-island/engine.err.log`. |
| Tunnel 502 / "ERR" on `https://island.example.com` | Engine not running — check Checkpoint 3. Or `config.yml` hostname ≠ the DNS name you routed. |
| Frontend stuck on "connecting…" | `?server=` must be `wss://` (not `ws://`) when the page is HTTPS. Verify `/health` on the same hostname. |
| Cloudflare "too many redirects" | SSL/TLS mode must be **Full** (not Flexible) — the tunnel already terminates TLS at the edge; the origin is plain HTTP. |
| Port 8902 already in use | Another engine instance running (`lsof -i :8902`) — stop the duplicate; snapshot file is per-port (`world-8902.json`) so a second port is also fine. |
| Mini was asleep, island froze | Energy settings (prerequisites) — "Prevent automatic sleeping" must be on; check `pmset -g`. |
| Docker path: engine not starting at login | Docker Desktop must be set to start at login (Settings → General). Prefer Option A (plain Node) to avoid this. |
| `cloudflared tunnel login` browser didn't open | Copy the URL it prints into any browser manually. |
| World resets after reboot | `DATA_DIR` in the engine plist must point at the persistent dir (`/opt/agent-island/server/data`) — check the plist. |

---

## Files in this directory (Mac mini additions)

| File | Purpose |
|---|---|
| `DEPLOY-macmini.md` | This guide |
| `launchd/com.agentisland.engine.plist` | launchd service: engine at boot, KeepAlive, log rotation-friendly paths |
| `launchd/com.agentisland.tunnel.plist` | launchd service: cloudflared tunnel at boot, KeepAlive |
