// Thin HTTP client for the island engine. Mirrors the routes in server/net.js.
// ISLAND_SECRET is read from the environment and attached only on POST /spawn.
// It is never logged and never returned to callers of this module's errors
// after redaction.

export type ChatEntry = {
  seq?: number;
  fromId?: string | null;
  fromName?: string;
  toId?: string | null;
  toName?: string;
  text?: string;
  kind?: string;
  source?: string;
};

export type Place = {
  id?: string;
  name?: string;
  x?: number;
  y?: number;
  z?: number;
};

export type PublicAgent = {
  id?: string;
  name?: string;
  x?: number;
  z?: number;
  activity?: string;
  state?: string;
  external?: boolean;
  transient?: boolean;
};

export type IslandState = {
  island?: { name?: string; code?: string; tagline?: string };
  places?: Place[];
  agents?: PublicAgent[];
  clock?: { time?: string; day?: number; season?: string; weather?: string };
  happening?: string;
  chat?: ChatEntry[];
  story?: Array<{ text?: string }>;
};

export type SpawnedResident = {
  id: string;
  token: string;
  name: string;
};

export type SayResult = {
  ok: boolean;
  entry: ChatEntry | null;
  reply: ChatEntry | null;
};

export class IslandError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "IslandError";
    this.status = status;
  }
}

export type Island = {
  readonly baseUrl: string;
  state(signal?: AbortSignal): Promise<IslandState>;
  spawn(
    body: { name: string; color?: string },
    signal?: AbortSignal,
  ): Promise<SpawnedResident>;
  say(
    body: { id: string; token: string; text: string; to?: string },
    signal?: AbortSignal,
  ): Promise<SayResult>;
  move(
    body: { id: string; token: string; x: number; z: number },
    signal?: AbortSignal,
  ): Promise<{ ok: boolean }>;
  leave(
    body: { id: string; token: string },
    signal?: AbortSignal,
  ): Promise<{ ok: boolean }>;
};

export function createIsland(env: NodeJS.ProcessEnv = process.env): Island {
  const baseUrl = (env.ENGINE_URL || "http://localhost:8902").replace(/\/+$/, "");
  const secret = env.ISLAND_SECRET || "";

  async function call(
    path: string,
    method: "GET" | "POST",
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new IslandError(
        redact(
          `Engine unreachable at ${baseUrl}: ${message}. Start it first (node server/index.js).`,
          [secret],
        ),
      );
    }

    const text = await res.text().catch(() => "");
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = text.slice(0, 200);
      }
    }

    if (!res.ok) {
      throw new IslandError(failureMessage(path, res.status, parsed, secret), res.status);
    }
    return parsed ?? {};
  }

  return {
    baseUrl,

    state(signal) {
      return call("/state", "GET", null, signal).then(asState);
    },

    async spawn(body, signal) {
      const payload: { name: string; color?: string; secret?: string } = {
        name: body.name,
      };
      if (body.color) payload.color = body.color;
      if (secret) payload.secret = secret;
      const spawned = asRecord(await call("/spawn", "POST", payload, signal));
      const id = asString(spawned.id);
      const token = asString(spawned.token);
      const name = asString(spawned.name) || body.name;
      if (!id || !token) {
        throw new IslandError("Engine /spawn returned no resident id.");
      }
      return { id, token, name };
    },

    async say(body, signal) {
      const payload: { id: string; token: string; text: string; to?: string } = {
        id: body.id,
        token: body.token,
        text: body.text,
      };
      if (body.to) payload.to = body.to;
      // Live HTTP contract (server/net.js): { ok, entry, reply }.
      // server/mcp.js reads replyEntry, which the engine does not send.
      const result = asRecord(await call("/say", "POST", payload, signal));
      return {
        ok: result.ok !== false,
        entry: asChat(result.entry),
        reply: asChat(result.reply),
      };
    },

    async move(body, signal) {
      await call(
        "/move",
        "POST",
        { id: body.id, token: body.token, x: body.x, z: body.z },
        signal,
      );
      return { ok: true };
    },

    async leave(body, signal) {
      await call("/leave", "POST", { id: body.id, token: body.token }, signal);
      return { ok: true };
    },
  };
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** Drop token/secret fields and replace any copied secret substrings. */
export function scrub(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redact(value, secrets);
  if (typeof value === "number" || typeof value === "boolean" || value == null) {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item, secrets));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "token" || key === "secret" || key === "password") continue;
      out[key] = scrub(item, secrets);
    }
    return out;
  }
  return null;
}

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

function failureMessage(
  path: string,
  status: number,
  body: unknown,
  secret: string,
): string {
  const detail = errorDetail(body);
  if (path === "/spawn" && status === 403 && /invalid secret/i.test(detail)) {
    return secret
      ? "Engine rejected the spawn secret."
      : "The island requires ISLAND_SECRET and none is set.";
  }
  const suffix = detail ? `: ${detail}` : "";
  return redact(`Engine ${path} -> HTTP ${status}${suffix}`, [secret]);
}

function errorDetail(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 200);
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string") return error.slice(0, 200);
  }
  return "";
}

function asState(value: unknown): IslandState {
  return (value && typeof value === "object" ? value : {}) as IslandState;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asChat(value: unknown): ChatEntry | null {
  if (!value || typeof value !== "object") return null;
  return value as ChatEntry;
}
