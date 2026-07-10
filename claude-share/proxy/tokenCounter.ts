import { getSession, saveSession } from "../session/manager";

export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requests: number;
}

const listeners = new Set<() => void>();

// recordTokens runs in the response flush of every billed /v1/messages, and
// saveSession does a synchronous writeFileSync — writing on every message stalls
// the event loop under load. Coalesce into at most one write per few seconds;
// the in-memory stats are always current, only their persistence is debounced.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(session: ReturnType<typeof getSession>): void {
  if (!session || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const s = getSession();
    if (s) saveSession(s);
  }, 5000);
  saveTimer.unref?.();
}

/** Persist any pending debounced save immediately (call on shutdown). */
export function flushPendingSave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const s = getSession();
  if (s) saveSession(s);
}

export function recordTokens(
  machineId: string,
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
): void {
  const session = getSession();
  if (!session) return;

  const machine = session.machines.get(machineId);
  if (!machine) return;

  machine.stats = {
    inputTokens: machine.stats.inputTokens + input,
    outputTokens: machine.stats.outputTokens + output,
    cacheReadTokens: machine.stats.cacheReadTokens + cacheRead,
    cacheWriteTokens: machine.stats.cacheWriteTokens + cacheWrite,
    requests: machine.stats.requests + 1,
  };

  scheduleSave(session);
  listeners.forEach((fn) => fn());
}

export function getMachineStats(machineId: string): TokenStats {
  const session = getSession();
  if (!session) {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 };
  }
  const machine = session.machines.get(machineId);
  if (!machine) {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 };
  }
  return { ...machine.stats };
}

export function getTotalStats(): TokenStats {
  const session = getSession();
  if (!session) {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 };
  }
  const total: TokenStats = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    requests: 0,
  };
  for (const m of session.machines.values()) {
    total.inputTokens += m.stats.inputTokens;
    total.outputTokens += m.stats.outputTokens;
    total.cacheReadTokens += m.stats.cacheReadTokens;
    total.cacheWriteTokens += m.stats.cacheWriteTokens;
    total.requests += m.stats.requests;
  }
  return total;
}

export function subscribeTokens(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
