import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { platform } from "@shared/platforms";
import type { OAuthCredentials } from "@shared/platforms";
import { logger } from "../logger";

// ── Multi-account support ──────────────────────────────────────────────────────
//
// The sharer can expose several Claude accounts, each living in its own
// CLAUDE_CONFIG_DIR (e.g. ~/.claude, ~/.claude-acc2). A receiver picks one at
// launch and the MITM injects THAT account's token for its requests.
//
// Accounts come from CLAUDE_ACCOUNTS (comma-separated config dirs). If unset we
// fall back to the single default account (~/.claude / the platform store), so
// existing single-account setups are unchanged.

// If the cached token has less than this left, re-read the on-disk credentials
// (which the sharer's live Claude CLI keeps fresh) before injecting it.
const STALE_THRESHOLD_MS = 60_000;

export interface AccountMeta {
  id: string;
  email: string | null;
  plan: string | null;
}

interface Account {
  id: string;
  configDir: string;
  isDefault: boolean;
  creds: OAuthCredentials | null;
  email: string | null;
  plan: string | null;
  refreshTimer: NodeJS.Timeout | null;
  rereadInFlight: Promise<void> | null;
}

const accounts = new Map<string, Account>();
let defaultId = "default";

function expandDir(dir: string): string {
  const d = dir.trim();
  return d.startsWith("~") ? path.join(os.homedir(), d.slice(1)) : d;
}

function idForDir(dir: string, index: number): string {
  const base = path.basename(dir);
  if (base === ".claude") return "default";
  const stripped = base.replace(/^\.claude[-_]?/, "");
  return stripped || `acc${index}`;
}

function discoverAccounts(): { id: string; configDir: string; isDefault: boolean }[] {
  const env = process.env.CLAUDE_ACCOUNTS?.trim();
  const defaultDir = path.join(os.homedir(), ".claude");
  if (!env) {
    return [{ id: "default", configDir: defaultDir, isDefault: true }];
  }
  const seen = new Set<string>();
  return env
    .split(",")
    .map((d) => expandDir(d))
    .filter((d) => d && !seen.has(d) && seen.add(d))
    .map((dir, i) => ({
      id: idForDir(dir, i),
      configDir: dir,
      isDefault: dir === defaultDir,
    }));
}

// Read the OAuth creds for an account. Prefer the config dir's .credentials.json
// (works for every extra account on Linux/Windows); fall back to the platform
// store for the default account (covers macOS Keychain).
async function readCreds(acc: {
  configDir: string;
  isDefault: boolean;
}): Promise<OAuthCredentials | null> {
  try {
    const p = path.join(acc.configDir, ".credentials.json");
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    if (j?.claudeAiOauth?.accessToken) return j.claudeAiOauth;
  } catch {}
  if (acc.isDefault) {
    try {
      return await platform().readOAuthCredentials();
    } catch {}
  }
  return null;
}

function readInfo(configDir: string): { email: string | null; plan: string | null } {
  try {
    const j = JSON.parse(
      fs.readFileSync(path.join(configDir, ".claude.json"), "utf8"),
    ) as Record<string, any>;
    const o = j.oauthAccount ?? {};
    return {
      email: o.emailAddress ?? j.userEmail ?? null,
      plan: o.organizationType ?? o.subscriptionType ?? null,
    };
  } catch {
    return { email: null, plan: null };
  }
}

// Run 'claude -p HI' to trigger Claude CLI's internal OAuth refresh flow. This is
// headless and updates the credentials file for the account's config dir.
// Windows npm installs "claude" as a .cmd shim — execFile can't exec that
// without a shell.
function spawnClaudeRefresh(configDir: string, isDefault: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (!isDefault) env.CLAUDE_CONFIG_DIR = configDir;
    const child = execFile(
      "claude",
      ["-p", "HI"],
      { timeout: 60_000, shell: process.platform === "win32", env },
      (err) => (err?.killed ? reject(new Error("Claude refresh timed out")) : resolve()),
    );
    child.stdout?.resume();
    child.stderr?.resume();
  });
}

// Claude Code manages the OAuth refresh cycle and writes the updated token back
// to each config dir's credential store. We re-read before expiry so we're never
// caught with a stale token; if the CLI hasn't refreshed it, we spawn a headless
// Claude process for that account to trigger the refresh.
function scheduleReread(acc: Account): void {
  if (acc.refreshTimer) clearTimeout(acc.refreshTimer);
  const ms = Math.max((acc.creds?.expiresAt ?? 0) - Date.now() - 5 * 60 * 1000, 60_000);
  acc.refreshTimer = setTimeout(async () => {
    try {
      let cur = await readCreds(acc);
      if (cur && cur.expiresAt - Date.now() < 5 * 60 * 1000) {
        logger.info(`[token] account ${acc.id} expiring — spawning Claude to refresh`);
        try {
          await spawnClaudeRefresh(acc.configDir, acc.isDefault);
          cur = await readCreds(acc);
        } catch (e) {
          logger.error(`[token] refresh spawn failed for ${acc.id}`, e);
        }
      }
      if (cur) acc.creds = cur;
      scheduleReread(acc);
    } catch (err) {
      logger.error(`[token] reread failed for ${acc.id}`, err);
      acc.refreshTimer = setTimeout(() => scheduleReread(acc), 60_000);
      acc.refreshTimer.unref();
    }
  }, ms);
  acc.refreshTimer.unref();
}

export async function initToken(): Promise<void> {
  accounts.clear();
  const discovered = discoverAccounts();
  defaultId = discovered.find((d) => d.isDefault)?.id ?? discovered[0]?.id ?? "default";
  for (const d of discovered) {
    const info = readInfo(d.configDir);
    const acc: Account = {
      id: d.id,
      configDir: d.configDir,
      isDefault: d.isDefault,
      creds: await readCreds(d),
      email: info.email,
      plan: info.plan,
      refreshTimer: null,
      rereadInFlight: null,
    };
    accounts.set(acc.id, acc);
    if (acc.creds) scheduleReread(acc);
    else logger.warn(`[token] account ${acc.id} (${acc.configDir}) has no credentials`);
  }
  logger.info(`[token] loaded ${accounts.size} account(s): ${[...accounts.keys()].join(", ")}`);
}

function resolve(accountId?: string): Account {
  const acc = (accountId && accounts.get(accountId)) || accounts.get(defaultId);
  if (!acc) throw new Error("Token not initialized — call initToken() first");
  return acc;
}

export function getAccessToken(accountId?: string): string {
  const acc = resolve(accountId);
  if (!acc.creds) throw new Error(`No credentials for account ${acc.id}`);
  return acc.creds.accessToken;
}

// Inject path for the proxy. The on-disk credential store is the source of truth
// (the sharer's live Claude CLI refreshes it); the in-memory snapshot only
// updates on the reread timer, so it can lag. When it's within STALE_THRESHOLD_MS
// of expiry, re-read the file so the proxy never injects a rotated-out token.
export async function getFreshAccessToken(accountId?: string): Promise<string> {
  const acc = resolve(accountId);
  if (!acc.creds) throw new Error(`No credentials for account ${acc.id}`);
  if (acc.creds.expiresAt - Date.now() < STALE_THRESHOLD_MS) {
    if (!acc.rereadInFlight) {
      acc.rereadInFlight = readCreds(acc)
        .then((fresh) => {
          if (fresh) acc.creds = fresh;
        })
        .catch((err) => logger.error(`[token] inline reread failed for ${acc.id}`, err))
        .finally(() => {
          acc.rereadInFlight = null;
        });
    }
    await acc.rereadInFlight;
  }
  return acc.creds.accessToken;
}

export function listAccounts(): AccountMeta[] {
  return [...accounts.values()]
    .filter((a) => a.creds)
    .map((a) => ({ id: a.id, email: a.email, plan: a.plan }));
}

export function hasAccount(accountId: string): boolean {
  return accounts.has(accountId) && !!accounts.get(accountId)!.creds;
}

export function getSubscriptionType(accountId?: string): string {
  return resolve(accountId).creds?.subscriptionType ?? "unknown";
}

export function stopTokenRefresh(): void {
  for (const acc of accounts.values()) {
    if (acc.refreshTimer) clearTimeout(acc.refreshTimer);
  }
  accounts.clear();
}
