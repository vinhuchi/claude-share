export type RequestOutcome = "allowed" | "blocked";

export interface RequestEntry {
  id: number;
  ts: Date;
  method: string;
  hostname: string;
  path: string;
  outcome: RequestOutcome;
  /** HTTP status returned to client (set after response) */
  status: number | null;
  machineId?: string;
}

const MAX_ENTRIES = 200;
const entries: RequestEntry[] = [];
let seq = 0;
const listeners = new Set<() => void>();

export function logRequest(
  method: string,
  hostname: string,
  path: string,
  outcome: RequestOutcome,
  machineId?: string,
): number {
  const id = ++seq;
  entries.unshift({ id, ts: new Date(), method, hostname, path, outcome, status: null, machineId });
  if (entries.length > MAX_ENTRIES) entries.pop();
  listeners.forEach((fn) => fn());
  return id;
}

export function setResponseStatus(id: number, status: number): void {
  const entry = entries.find((e) => e.id === id);
  if (entry) {
    entry.status = status;
    listeners.forEach((fn) => fn());
  }
}

export function getEntries(): readonly RequestEntry[] {
  return entries;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
