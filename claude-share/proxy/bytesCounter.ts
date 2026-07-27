// Per-machine bandwidth counters for the dashboard. Kept in-memory only (never
// written to session.json): these are live traffic figures that reset on a
// sharer restart and re-accumulate as clients keep using the proxy. Fed by the
// MITM, which samples each tunnel socket's wire bytes (see mitm.ts).

export interface ByteStats {
  /** bytes received FROM the client (uploads: requests + TLS/framing overhead) */
  up: number;
  /** bytes sent TO the client (downloads: responses) */
  down: number;
}

const byteMap = new Map<string, ByteStats>();

export function recordBytes(machineId: string, up: number, down: number): void {
  if (up <= 0 && down <= 0) return;
  const b = byteMap.get(machineId);
  if (b) {
    b.up += Math.max(0, up);
    b.down += Math.max(0, down);
  } else {
    byteMap.set(machineId, { up: Math.max(0, up), down: Math.max(0, down) });
  }
}

export function getMachineBytes(machineId: string): ByteStats {
  const b = byteMap.get(machineId);
  return b ? { ...b } : { up: 0, down: 0 };
}

export function getTotalBytes(): ByteStats {
  const total: ByteStats = { up: 0, down: 0 };
  for (const b of byteMap.values()) {
    total.up += b.up;
    total.down += b.down;
  }
  return total;
}
