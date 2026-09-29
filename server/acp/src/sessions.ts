// One ACP session is one island visit: the resident id and token stay here
// and are never copied into session/update payloads.

export type Visit = {
  sessionId: string;
  residentId: string;
  token: string;
  name: string;
  color: string;
  /** Highest chat seq already incorporated into a previous turn. */
  seenSeq: number;
  abort: AbortController | null;
  /** Set only by session/cancel, so an explicit leave turn still ends as end_turn. */
  cancelRequested: boolean;
  /** Set as soon as leave begins, so a second cancel does not spawn another. */
  leaving: boolean;
  left: boolean;
  leavePromise: Promise<void> | null;
  toolSeq: number;
};

export type SessionStore = {
  get(sessionId: string): Visit | undefined;
  put(visit: Visit): void;
  delete(sessionId: string): void;
  all(): Visit[];
};

export function createSessionStore(): SessionStore {
  const sessions = new Map<string, Visit>();
  return {
    get(sessionId) {
      return sessions.get(sessionId);
    },
    put(visit) {
      sessions.set(visit.sessionId, visit);
    },
    delete(sessionId) {
      sessions.delete(sessionId);
    },
    all() {
      return [...sessions.values()];
    },
  };
}
