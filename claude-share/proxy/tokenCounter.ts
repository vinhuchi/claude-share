import { getSession, saveSession } from "../session/manager";

export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requests: number;
}

const listeners = new Set<() => void>();

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

  saveSession(session);
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
