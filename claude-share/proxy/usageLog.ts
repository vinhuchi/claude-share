import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Append-only usage ledger. Unlike tokenCounter (running totals per machine),
// this records one timestamped event per billed /v1/messages response so the
// dashboard can break usage down by day/week, by model (Fable etc.), and by
// Claude's rolling 5-hour rate-limit window. Kept forever (no prune).
const USAGE_LOG = path.join(os.homedir(), ".claude-share", "usage-events.jsonl");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WINDOW_5H = 5 * HOUR;

export interface UsageEvent {
  ts: number; // epoch ms
  machineId: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface UsageBucket {
  key: string;
  start: number;
  end: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
}

export interface ModelUsage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
}

// Cap the ledger so a long-running (esp. Unlimited) share doesn't grow it
// without bound — readUsageEvents() reads the whole file synchronously on the
// dashboard hot path, so an ever-growing file slowly wedges the event loop.
const MAX_BYTES = 8 * 1024 * 1024; // ~8MB
let appendsSinceCheck = 0;

function maybePrune(): void {
  if (++appendsSinceCheck < 200) return;
  appendsSinceCheck = 0;
  try {
    if (fs.statSync(USAGE_LOG).size <= MAX_BYTES) return;
    const lines = fs.readFileSync(USAGE_LOG, "utf8").split("\n").filter(Boolean);
    const kept = lines.slice(Math.floor(lines.length / 2)); // drop oldest half
    fs.writeFileSync(USAGE_LOG, kept.join("\n") + "\n", { mode: 0o600 });
  } catch {}
}

export function recordUsageEvent(ev: UsageEvent): void {
  try {
    fs.mkdirSync(path.dirname(USAGE_LOG), { recursive: true });
    fs.appendFileSync(USAGE_LOG, JSON.stringify(ev) + "\n", { mode: 0o600 });
    maybePrune();
  } catch {}
}

export function readUsageEvents(sinceMs = 0): UsageEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(USAGE_LOG, "utf8");
  } catch {
    return [];
  }
  const out: UsageEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as UsageEvent;
      if (typeof ev.ts === "number" && ev.ts >= sinceMs) out.push(ev);
    } catch {}
  }
  return out;
}

function emptyBucket(key: string, start: number, end: number): UsageBucket {
  return { key, start, end, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
}

function addToBucket(b: UsageBucket, ev: UsageEvent): void {
  b.input += ev.input;
  b.output += ev.output;
  b.cacheRead += ev.cacheRead;
  b.cacheWrite += ev.cacheWrite;
  b.requests += 1;
}

function localDateKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** One bucket per local calendar day for the last `days` days (oldest first). */
export function dailyBuckets(events: UsageEvent[], days = 7): UsageBucket[] {
  const buckets: UsageBucket[] = [];
  const byKey = new Map<string, UsageBucket>();
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    const start = d.getTime();
    const key = localDateKey(start);
    const b = emptyBucket(key, start, start + DAY);
    buckets.push(b);
    byKey.set(key, b);
  }
  for (const ev of events) {
    const b = byKey.get(localDateKey(ev.ts));
    if (b) addToBucket(b, ev);
  }
  return buckets;
}

/** Totals per model, biggest first. */
export function byModel(events: UsageEvent[]): ModelUsage[] {
  const map = new Map<string, ModelUsage>();
  for (const ev of events) {
    const model = ev.model || "unknown";
    let m = map.get(model);
    if (!m) {
      m = { model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
      map.set(model, m);
    }
    m.input += ev.input;
    m.output += ev.output;
    m.cacheRead += ev.cacheRead;
    m.cacheWrite += ev.cacheWrite;
    m.requests += 1;
  }
  return [...map.values()].sort(
    (a, b) => b.input + b.output - (a.input + a.output),
  );
}

/** Rolling 5-hour windows aligned to the epoch, most recent first. */
export function windows5h(events: UsageEvent[], count = 12): UsageBucket[] {
  const map = new Map<number, UsageBucket>();
  for (const ev of events) {
    const start = Math.floor(ev.ts / WINDOW_5H) * WINDOW_5H;
    let b = map.get(start);
    if (!b) {
      b = emptyBucket(new Date(start).toISOString(), start, start + WINDOW_5H);
      map.set(start, b);
    }
    addToBucket(b, ev);
  }
  return [...map.values()].sort((a, b) => b.start - a.start).slice(0, count);
}
