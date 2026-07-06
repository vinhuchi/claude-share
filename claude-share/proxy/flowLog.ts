import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Full request/response recorder for debugging + replay. OFF by default because
// it writes complete prompts and model responses to disk. Toggle from the Dev
// tab. Only the most recent MAX_FLOWS are kept.
const FLOW_DIR = path.join(os.homedir(), ".claude-share", "flows");
const MAX_FLOWS = 100;

let recording = false;
// When off (default), /v1/messages flows (which carry the actual prompts and
// model output) are NOT recorded — only the other API calls (usage, profile,
// models, telemetry, etc.). Turn on to also capture messages for replay.
let includeMessages = false;

export function isRecording(): boolean {
  return recording;
}

export function setRecording(on: boolean): boolean {
  recording = on;
  return recording;
}

export function isIncludingMessages(): boolean {
  return includeMessages;
}

export function setIncludeMessages(on: boolean): boolean {
  includeMessages = on;
  return includeMessages;
}

export interface Flow {
  id: string;
  ts: number;
  machineId?: string;
  method: string;
  path: string;
  model: string;
  status: number;
  beta?: string;
  reqBody: string;
  resBody: string;
}

function flowFilename(flow: Flow): string {
  return `${flow.ts}-${flow.id}.json`;
}

function listFlowFiles(): string[] {
  try {
    // ts-prefixed names sort chronologically; newest first.
    return fs
      .readdirSync(FLOW_DIR)
      .filter((f) => /^\d+-[A-Za-z0-9]+\.json$/.test(f))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function pruneFlows(): void {
  for (const f of listFlowFiles().slice(MAX_FLOWS)) {
    try {
      fs.unlinkSync(path.join(FLOW_DIR, f));
    } catch {}
  }
}

export function saveFlow(flow: Flow): void {
  try {
    fs.mkdirSync(FLOW_DIR, { recursive: true });
    fs.writeFileSync(path.join(FLOW_DIR, flowFilename(flow)), JSON.stringify(flow), {
      mode: 0o600,
    });
    pruneFlows();
  } catch {}
}

export interface FlowSummary {
  file: string;
  id: string;
  ts: number;
  method: string;
  path: string;
  model: string;
  status: number;
  size: number;
}

export function listFlows(): FlowSummary[] {
  const out: FlowSummary[] = [];
  for (const file of listFlowFiles()) {
    try {
      const full = path.join(FLOW_DIR, file);
      const size = fs.statSync(full).size;
      const flow = JSON.parse(fs.readFileSync(full, "utf8")) as Flow;
      out.push({
        file,
        id: flow.id,
        ts: flow.ts,
        method: flow.method,
        path: flow.path,
        model: flow.model,
        status: flow.status,
        size,
      });
    } catch {}
  }
  return out;
}

/** Guarded read — `file` must be a bare recorder filename (no path segments). */
export function readFlow(file: string): Flow | null {
  if (!/^\d+-[A-Za-z0-9]+\.json$/.test(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(FLOW_DIR, file), "utf8")) as Flow;
  } catch {
    return null;
  }
}
