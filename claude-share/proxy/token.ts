import { execFile } from "node:child_process";
import { platform } from "@shared/platforms";
import type { OAuthCredentials } from "@shared/platforms";
import { logger } from "../logger";

// In-memory only — token never written to disk
let cached: OAuthCredentials | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

// If the cached token has less than this left, re-read the on-disk credentials
// (which the sharer's live Claude CLI keeps fresh) before injecting it.
const STALE_THRESHOLD_MS = 60_000;
// Coalesce concurrent re-reads so a burst of proxied requests triggers one read.
let rereadInFlight: Promise<void> | null = null;

function spawnClaudeForRefresh(): Promise<void> {
  return new Promise((resolve, reject) => {
    // Run 'claude -p HI' to trigger Claude CLI's internal OAuth refresh flow.
    // This is headless and updates the system keychain/credentials.
    // Windows npm installs "claude" as a .cmd shim — execFile can't exec that
    // without a shell (unlike claude-connect/launch.ts's spawn, which already sets this).
    const child = execFile("claude", ["-p", "HI"], { timeout: 60_000, shell: process.platform === "win32" }, (err) => {
      if (err?.killed) {
        reject(new Error("Claude process timed out after 60s"));
      } else {
        resolve();
      }
    });
    child.stdout?.resume();
    child.stderr?.resume();
  });
}

// Claude Code manages the OAuth refresh cycle on the sharer's machine and writes
// the updated token back to its credential store. We re-read before expiry so
// we're never caught with a stale token. If the CLI hasn't run to refresh it,
// we spawn a headless Claude process to trigger the refresh automatically.
function scheduleTokenReread(creds: OAuthCredentials): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  const msUntilReread = Math.max(
    creds.expiresAt - Date.now() - 5 * 60 * 1000,
    60_000,
  );
  refreshTimer = setTimeout(async () => {
    try {
      let current = await platform().readOAuthCredentials();
      
      // If the token is expired or close to expiry (less than 5 minutes remaining), trigger refresh
      if (current.expiresAt - Date.now() < 5 * 60 * 1000) {
        logger.info("[token] access token expiring soon, spawning Claude to refresh...");
        try {
          await spawnClaudeForRefresh();
          // Read again after refresh attempts
          current = await platform().readOAuthCredentials();
        } catch (spawnErr) {
          logger.error("[token] spawn Claude for refresh failed", spawnErr);
        }
      }

      cached = current;
      scheduleTokenReread(cached);
    } catch (err) {
      logger.error("[token] credential re-read failed", err);
      refreshTimer = setTimeout(() => scheduleTokenReread(creds), 60_000);
      refreshTimer.unref();
    }
  }, msUntilReread);
  refreshTimer.unref();
}

export async function initToken(): Promise<void> {
  cached = await platform().readOAuthCredentials();
  scheduleTokenReread(cached);
}

export function getAccessToken(): string {
  if (!cached)
    throw new Error("Token not initialized — call initToken() first");
  return cached.accessToken;
}

// Inject path for the proxy. The on-disk credential store is the source of
// truth (the sharer's live Claude CLI refreshes it); the in-memory `cached`
// snapshot only updates on the reread timer, so it can lag behind the file and
// go stale between ticks. When it's within STALE_THRESHOLD_MS of expiry, re-read
// the file so the proxy never injects a token the CLI has already rotated out.
export async function getFreshAccessToken(): Promise<string> {
  if (!cached)
    throw new Error("Token not initialized — call initToken() first");

  if (cached.expiresAt - Date.now() < STALE_THRESHOLD_MS) {
    if (!rereadInFlight) {
      rereadInFlight = platform()
        .readOAuthCredentials()
        .then((fresh) => {
          if (fresh) cached = fresh;
        })
        .catch((err) => {
          logger.error("[token] inline credential re-read failed", err);
        })
        .finally(() => {
          rereadInFlight = null;
        });
    }
    await rereadInFlight;
  }

  return cached.accessToken;
}

export function getSubscriptionType(): string {
  return cached?.subscriptionType ?? "unknown";
}

export function stopTokenRefresh(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  cached = null;
}
