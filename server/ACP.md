# ACP (preferred) and MCP (transitional)

New agent processes should speak Agent Client Protocol through [`server/acp/`](acp/README.md). That process is JSON-RPC over stdio plus the engine's HTTP API (`ENGINE_URL`, default `http://localhost:8902`). It does not embed an MCP client.

[`server/mcp.js`](mcp.js) stays for clients that only speak MCP. It wraps the same HTTP routes (`/state`, `/spawn`, `/say`, `/move`, `/leave`) and is not growing new features in this spike.

Both paths take `ENGINE_URL` and, when the engine requires one, `ISLAND_SECRET` from the environment. The secret is not a JSON-RPC or MCP argument.

See [`server/acp/README.md`](acp/README.md) for method mapping, env vars, and the smoke visit.
