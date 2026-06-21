import crypto from "node:crypto";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

import { toBase58 } from "@shared/base58";
import type { ConnectionFile, SharerAccount } from "@shared/types";

const SESSION_CACHE = path.join(os.homedir(), ".claude-share", "session.json");

function randomBytes(n: number): Uint8Array {
  return webcrypto.getRandomValues(new Uint8Array(n));
}

export type SessionStatus = "waiting" | "active" | "expired" | "revoked";

export interface MachineSession {
  id: string;
  startedAt: Date;
  lastActiveAt: Date;
  active: boolean;
}

export interface Machine {
  id: string;
  name: string;
  pairedAt: Date;
  sessions: Map<string, MachineSession>;
  proxyPass: string;
}

export type { ConnectionFile, SharerAccount } from "@shared/types";

export interface Session {
  id: string;
  /** Current pairing key — replaced each time a new pairing code is generated */
  key: Uint8Array;
  pairingCode: string;
  /** True after a machine successfully pairs with this code */
  pairingCodeUsed: boolean;
  sharedUntil: Date;
  machines: Map<string, Machine>;
  status: SessionStatus;
  createdAt: Date;
  pairingAttempts: Map<string, number>;
}

let currentSession: Session | null = null;

export function createSession(durationMs: number): Session {
  const key = randomBytes(32);
  currentSession = {
    id: crypto.randomUUID(),
    key,
    pairingCode: toBase58(key),
    pairingCodeUsed: false,
    sharedUntil: new Date(Date.now() + durationMs),
    machines: new Map(),
    status: "waiting",
    createdAt: new Date(),
    pairingAttempts: new Map(),
  };
  return currentSession;
}

export function getSession(): Session | null {
  return currentSession;
}

/** Generates a fresh pairing code + key, allowing one more machine to pair. */
export function regeneratePairingCode(session: Session): void {
  const newKey = randomBytes(32);
  session.key = newKey;
  session.pairingCode = toBase58(newKey);
  session.pairingCodeUsed = false;
  session.pairingAttempts.clear();
}

/** Encrypts a ConnectionFile for delivery to receiver. Returns hex-encoded blob. */
export function encryptConnectionFile(session: Session, file: ConnectionFile): string {
  const plaintext = new TextEncoder().encode(JSON.stringify(file));
  const nonce = randomBytes(24);
  const cipher = xchacha20poly1305(session.key, nonce);
  const ciphertext = cipher.encrypt(plaintext);
  return Buffer.from(nonce).toString("hex") + Buffer.from(ciphertext).toString("hex");
}

/** Constant-time pairing code check. Returns false if already used or brute-forced. */
export function checkPairingCode(session: Session, ip: string, code: string): boolean {
  if (session.pairingCodeUsed) return false;

  const attempts = session.pairingAttempts.get(ip) ?? 0;
  if (attempts >= 5) return false;

  const expected = Buffer.from(session.pairingCode.slice(0, 5), "utf8");
  const provided = Buffer.from(code.slice(0, 5).padEnd(5, "\0"), "utf8");
  const match = crypto.timingSafeEqual(expected, provided);

  if (!match) session.pairingAttempts.set(ip, attempts + 1);
  return match;
}

function deduplicateName(session: Session, baseName: string): string {
  const names = new Set([...session.machines.values()].map((m) => m.name));
  if (!names.has(baseName)) return baseName;
  let i = 2;
  while (names.has(`${baseName} (${i})`)) i++;
  return `${baseName} (${i})`;
}

/** Creates a Machine entry and burns the current pairing code (one-time use). */
export function addMachine(session: Session, name: string): Machine {
  const machine: Machine = {
    id: crypto.randomUUID(),
    name: deduplicateName(session, name),
    pairedAt: new Date(),
    sessions: new Map(),
    proxyPass: Buffer.from(randomBytes(16)).toString("hex"),
  };
  session.machines.set(machine.id, machine);
  session.pairingCodeUsed = true;
  session.status = "active";
  return machine;
}

/** Returns true if the Proxy-Authorization header matches any active machine. */
export function checkMachineAuth(session: Session, authHeader: string): boolean {
  for (const machine of session.machines.values()) {
    const expected = "Basic " + Buffer.from(`${machine.id}:${machine.proxyPass}`).toString("base64");
    if (authHeader === expected) return true;
  }
  return false;
}

/** Returns the machineId for a given Proxy-Authorization header, or null if not found. */
export function resolveMachineId(session: Session, authHeader: string): string | null {
  for (const machine of session.machines.values()) {
    const expected = "Basic " + Buffer.from(`${machine.id}:${machine.proxyPass}`).toString("base64");
    if (authHeader === expected) return machine.id;
  }
  return null;
}

export function addMachineSession(session: Session, machineId: string): MachineSession | null {
  const machine = session.machines.get(machineId);
  if (!machine) return null;
  const ms: MachineSession = {
    id: crypto.randomUUID(),
    startedAt: new Date(),
    lastActiveAt: new Date(),
    active: true,
  };
  machine.sessions.set(ms.id, ms);
  return ms;
}

export function endMachineSession(
  session: Session,
  machineId: string,
  sessionId: string,
): boolean {
  const ms = session.machines.get(machineId)?.sessions.get(sessionId);
  if (!ms) return false;
  ms.active = false;
  ms.lastActiveAt = new Date();
  return true;
}

export function heartbeatMachineSession(
  session: Session,
  machineId: string,
  sessionId: string,
): boolean {
  const ms = session.machines.get(machineId)?.sessions.get(sessionId);
  if (!ms?.active) return false;
  ms.lastActiveAt = new Date();
  return true;
}

export function isSessionExpired(session: Session): boolean {
  return Date.now() > session.sharedUntil.getTime();
}

export function destroySession(): void {
  if (currentSession) {
    currentSession.key.fill(0);
    currentSession = null;
  }
}

// ── Session persistence ────────────────────────────────────────────────────────

export function saveSession(session: Session): void {
  try {
    fs.mkdirSync(path.dirname(SESSION_CACHE), { recursive: true });
    const data = {
      id: session.id,
      key: Buffer.from(session.key).toString("hex"),
      pairingCode: session.pairingCode,
      pairingCodeUsed: session.pairingCodeUsed,
      sharedUntil: session.sharedUntil.toISOString(),
      createdAt: session.createdAt.toISOString(),
      machines: [...session.machines.entries()].map(([id, m]) => ({
        id,
        name: m.name,
        pairedAt: m.pairedAt.toISOString(),
        proxyPass: m.proxyPass,
      })),
    };
    fs.writeFileSync(SESSION_CACHE, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch {}
}

export function loadSession(): Session | null {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_CACHE, "utf8"));
    const sharedUntil = new Date(raw.sharedUntil);
    if (Date.now() >= sharedUntil.getTime()) return null; // expired

    const key = Uint8Array.from(Buffer.from(raw.key, "hex"));
    const machines = new Map<string, Machine>(
      (raw.machines ?? []).map((m: { id: string; name: string; pairedAt: string; proxyPass: string }) => [
        m.id,
        {
          id: m.id,
          name: m.name,
          pairedAt: new Date(m.pairedAt),
          sessions: new Map(),
          proxyPass: m.proxyPass,
        } satisfies Machine,
      ]),
    );

    currentSession = {
      id: raw.id,
      key,
      pairingCode: raw.pairingCode,
      pairingCodeUsed: raw.pairingCodeUsed ?? false,
      sharedUntil,
      machines,
      status: machines.size > 0 ? "active" : "waiting",
      createdAt: new Date(raw.createdAt),
      pairingAttempts: new Map(),
    };
    return currentSession;
  } catch {
    return null;
  }
}
