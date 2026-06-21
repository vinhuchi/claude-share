export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  requests: number;
}

const byMachine = new Map<string, TokenStats>();
let globalTotal: TokenStats = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  requests: 0,
};

const listeners = new Set<() => void>();

export function recordTokens(
  machineId: string,
  input: number,
  output: number,
  cacheRead = 0,
): void {
  const prev = byMachine.get(machineId) ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    requests: 0,
  };
  byMachine.set(machineId, {
    inputTokens: prev.inputTokens + input,
    outputTokens: prev.outputTokens + output,
    cacheReadTokens: prev.cacheReadTokens + cacheRead,
    requests: prev.requests + 1,
  });
  globalTotal = {
    inputTokens: globalTotal.inputTokens + input,
    outputTokens: globalTotal.outputTokens + output,
    cacheReadTokens: globalTotal.cacheReadTokens + cacheRead,
    requests: globalTotal.requests + 1,
  };
  listeners.forEach((fn) => fn());
}

export function getMachineStats(machineId: string): TokenStats {
  return (
    byMachine.get(machineId) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      requests: 0,
    }
  );
}

export function getTotalStats(): TokenStats {
  return { ...globalTotal };
}

export function subscribeTokens(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
