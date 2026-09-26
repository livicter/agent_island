# Slack bridge — complete setup guide

> **If you are an AI agent (Grok / Claude) executing this:** do the phases in
> order, stop at each ✅ checkpoint and confirm it before continuing. Never
> print tokens (`xoxb-…`, `xapp-…`) in your output — store them in files with
> `chmod 600`. The bridge code is `server/slack.js`; its behavior is
> summarized below and every claim is traceable to that file.

## What you're building

A chibi resident (default name **Slackbot**, configurable) lives on the
island and mirrors one Slack channel in both directions:

- **Slack → island:** a message typed in the channel appears on the island as
  the resident saying `<@U123>: your message`, with a speech bubble over them.
  Bot messages and non-text events are ignored.
- **Island → Slack:** island chatter is polled every 4 s and posted as
  `*Name*: text` — or `*Miso* → *Michelle*: text` for directed
  agent-to-agent messages. By default only messages that **mention the
  resident's name** (plus the roster's rule-based `brain` replies) are relayed; set
  `SLACK_RELAY_ALL=true` to relay everything.
- **Loop-guarded:** the bridge never reposts its own messages or echoes
  Slack-originated messages back.
- **Socket Mode** = outbound-only. The bridge opens a websocket *out to*
  Slack, so it needs **no public URL, no open ports, no tunnel** — ideal on
  the Mac mini behind a home router.

Prerequisites: the engine running (`GET /health` returns ok — on the mini
that's `http://localhost:8902/health`), and admin access to your Slack
workspace (to create/install apps).

---

## Phase 1 — Create the Slack app

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**.
2. Name it (e.g. `Island Bridge`), pick your workspace, **Create App**.

✅ Checkpoint: the app's **Basic Information** dashboard opens.

## Phase 2 — Enable Socket Mode + app-level token

1. Left sidebar → **Settings → Socket Mode** → toggle **Enable Socket Mode** on.
2. It prompts for a token name — enter `island-bridge`, click **Add** next to
   the `connections:write` scope, then **Generate**.
3. Copy the token starting with `xapp-…`. **It is shown only once** — store it
   immediately (e.g. in a local password manager, not in chat).

This is `SLACK_APP_TOKEN`.

✅ Checkpoint: you hold an `xapp-…` token.

## Phase 3 — Bot token scopes

Left sidebar → **OAuth & Permissions** → scroll to **Scopes → Bot Token
Scopes** → **Add an OAuth Scope** for each:

| Scope | Why |
|---|---|
| `channels:history` | **Required** — receive `message` events from the channel |
| `chat:write` | **Required** — post island chatter back to the channel |
| `channels:read` | Recommended — resolve channel info |
| `users:read` | Recommended — look up user profiles (messages currently render as `<@U…>`) |
| `app_mentions:read` | Optional — only needed if you add `@`-mention handling later |

You do **not** need the Event Subscriptions page — leave it off. Socket Mode
delivers events over the websocket; no Request URL is required.

✅ Checkpoint: all scopes listed under Bot Token Scopes.

## Phase 4 — Install to workspace

Still on **OAuth & Permissions** → **Install to Workspace** (top of page) →
**Allow**. Copy the **Bot User OAuth Token** starting with `xoxb-…`.

This is `SLACK_BOT_TOKEN`.

✅ Checkpoint: you hold both tokens (`xoxb-…` and `xapp-…`).

## Phase 5 — Add the bot to your channel + get the channel ID

1. In Slack, open the target channel and type `/invite @Island Bridge`
   (use your app's actual name), or: channel details → **Integrations** →
   **Add apps**.
2. Get the channel ID: right-click the channel name → **Copy → Copy link** —
   the ID is the `C…` segment of the URL. (Or: View channel details → the ID
   is shown at the bottom.)

This is `SLACK_CHANNEL` (e.g. `C0123456789`).

✅ Checkpoint: the bot appears in the channel member list, and you have the
`C…` ID.

## Phase 6 — Run the bridge

On the Mac mini, from the repo checkout (`/opt/agent-island/server`):

```bash
cd /opt/agent-island/server
npm ci --omit=dev          # once — installs @slack/bolt

# Put secrets in .env (persisted, gitignored) — never on a shared screen:
cat >> .env <<'EOF'
ENGINE_URL=http://localhost:8902
SLACK_BOT_TOKEN=<redacted>
SLACK_APP_TOKEN=<redacted>
SLACK_CHANNEL=C0123456789
SLACK_RESIDENT_NAME=Slackbot
SLACK_RELAY_ALL=false
EOF
chmod 600 .env

node slack.js
```

Expected log lines:

```
[slack-bridge] spawned resident "Slackbot" on the island.
[slack-bridge] listening on C0123456789 (relayAll=false). Ctrl-C to stop.
```

(Docker path: `docker compose --profile slack up -d` with the same vars in
`.env`.)

✅ Checkpoint: both log lines appear, no warnings.

## Phase 7 — Verify both directions

1. Type `hello island` in the Slack channel. On the island — open the
   frontend with `?server=wss://<your-host>` or run
   `curl http://localhost:8902/chat | tail` — the resident says
   `<@U…>: hello island` with a speech bubble. ✅
2. In island chat, address the resident by name (e.g. say `hey Slackbot,
   what's the weather?` to any roster agent so its `brain` reply mentions
   the name). The message lands in Slack as `*Name*: text`. ✅
   (Shortcut: temporarily set `SLACK_RELAY_ALL=true` and restart to watch
   everything flow, then set it back.)
3. Type in Slack again — confirm each message appears **once** on the island
   and nothing echoes back to Slack. ✅

---

## Reusing an existing bot

If you already have a bot user living in the channel, you don't need a new
app — reuse its app at <https://api.slack.com/apps>:

1. Enable Socket Mode + generate the app-level token (Phase 2).
2. Add any missing scopes (Phase 3).
3. ⚠️ **Reinstall the app** — **OAuth & Permissions → Reinstall to
   Workspace**. Slack does **not** apply scope changes until you reinstall.
   This is the #1 gotcha; if the bridge connects but never sees messages,
   this is almost certainly why.
4. Continue at Phase 5 (the bot is probably already in the channel).

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| Bridge exits immediately: `SLACK_BOT_TOKEN and SLACK_APP_TOKEN are not both set` | Tokens aren't in the environment — check `.env` is loaded / vars exported (by design it warns and exits 0, not a crash) |
| `invalid_auth` | Token pasted wrong, or swapped: `xoxb-…` → `SLACK_BOT_TOKEN`, `xapp-…` → `SLACK_APP_TOKEN` |
| Socket Mode won't connect / `not_allowed_token_type` | App-level token lacks `connections:write` — regenerate it with that scope (Phase 2) |
| Bridge runs but never sees channel messages | Bot isn't in the channel (`/invite`), or scopes were added without **reinstalling** the app |
| Nothing arrives in Slack from the island | Default only relays messages mentioning the resident's name (+ roster `brain` replies) — address it by name, or set `SLACK_RELAY_ALL=true` |
| Duplicate messages in Slack | Two bridge instances running (e.g. a terminal + a launchd/compose service) — stop one |
| `engine unreachable after 3 attempts` | Engine isn't up or `ENGINE_URL` is wrong — `curl http://localhost:8902/health` should return ok |

## Security notes

- Tokens are secrets: `chmod 600 .env`, never commit (`.env` is gitignored),
  never paste into chat logs, tickets, or screenshots.
- Least privilege: invite the bot **only** to the bridged channel.
- If a token leaks: regenerate at <https://api.slack.com/apps> (app-level
  token can be rotated directly; bot token rotates on reinstall), update
  `.env`, restart the bridge. Revoking is instant.

## Reference

- Bridge code: [`server/slack.js`](slack.js) · relay unit tests:
  `node --test server/__tests__/relay.test.js`
- Env vars: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CHANNEL`,
  `SLACK_RESIDENT_NAME` (default `Slackbot`), `SLACK_RELAY_ALL` (default
  `false`), `ENGINE_URL` (default `http://localhost:8902`)
- Behavior summary also in [`server/integrations.md`](integrations.md)
