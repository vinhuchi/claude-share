import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";

import * as p from "@clack/prompts";

import { platform } from "@shared/platforms";
import { resetTerminalModes } from "@shared/terminal";
import { apiFetch } from "./fetch";
import { logger } from "./logger";
import { buildProxyUrl, clearActiveConnection } from "./storage";
import type { SharerAccount } from "./types";

const execFileAsync = promisify(execFile);

// ── Connect settings ──────────────────────────────────────────────────────────

const DEFAULT_DENY_RULES = [
  "Read(**/.env*)",
  "Read(**/.git/**)",
];

function collectEnvFiles(dir: string, depth = 0, results: string[] = []): string[] {
  if (depth > 5) return results;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
        collectEnvFiles(path.join(dir, entry.name), depth + 1, results);
      } else if (entry.isFile() && /^\.env($|\.)/.test(entry.name)) {
        results.push(path.join(dir, entry.name).replace(/\\/g, "/"));
      }
    }
  } catch {}
  return results;
}

export function ensureConnectSettings(cwd?: string): string {
  const connectDir = path.join(os.homedir(), ".claude-connect");
  const settingsPath = path.join(connectDir, "settings.json");

  if (!fs.existsSync(connectDir)) {
    fs.mkdirSync(connectDir, { recursive: true, mode: 0o700 });
  }

  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {}

  const perms = (settings["permissions"] as Record<string, unknown>) ?? {};
  const deny = new Set<string>((perms["deny"] as string[]) ?? []);

  for (const rule of DEFAULT_DENY_RULES) deny.add(rule);

  if (cwd) {
    for (const absPath of collectEnvFiles(cwd)) {
      deny.add(`Read(${absPath})`);
    }
  }

  settings["permissions"] = { ...perms, deny: [...deny] };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });

  return settingsPath;
}

// ── Onboarding ────────────────────────────────────────────────────────────────

export function checkAndShowClaudeSettings(): void {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {}

  const perms = (settings["permissions"] as Record<string, unknown>) ?? {};
  const mode = perms["defaultMode"] as string | undefined;
  const hasBypass = mode === "bypassPermissions" || mode === "bypasspermissions";
  const skipPrompt = settings["skipDangerousModePermissionPrompt"] === true;

  if (hasBypass && skipPrompt) {
    p.log.info("Settings: bypassPermissions ✓");
  } else {
    const missing: string[] = [];
    if (!hasBypass) missing.push('permissions.defaultMode = "bypassPermissions"');
    if (!skipPrompt) missing.push("skipDangerousModePermissionPrompt = true");
    p.log.warn(
      `~/.claude/settings.json missing: ${missing.join(", ")}\n` +
      `  Claude will prompt for permissions. Add to settings to skip.`,
    );
  }
}

export function ensureOnboarding() {
  const claudeJsonPath = path.join(os.homedir(), ".claude.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
  } catch {}

  if (config["hasCompletedOnboarding"] !== true) {
    p.log.info(
      "Onboarding not completed — marking it done so Claude launches directly.",
    );
    config["hasCompletedOnboarding"] = true;
    fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2), {
      mode: 0o600,
    });
  }
}

export function applySharerAccount(sharerAccount: { emailAddress: string; displayName: string; organizationName: string }) {
  const claudeJsonPath = path.join(os.homedir(), ".claude.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
  } catch {}

  config["userEmail"] = sharerAccount.emailAddress;
  config["organizationName"] = sharerAccount.organizationName;

  // Claude Code caches the account profile (entitlements) and the model-picker
  // options keyed to whatever account it last saw. On the receiver that's their
  // OWN account, so gated models (e.g. claude-fable-5) stay cached as
  // "disabled"/"not available for your account" even though every request is
  // proxied through the sharer's token. Drop those caches so Claude Code
  // re-fetches them fresh over the proxy — mirroring a fresh install, which is
  // why a never-used-locally machine (e.g. Linux) sees the sharer's models but
  // a machine that ran its own account first does not.
  for (const k of [
    "oauthAccount",
    "additionalModelOptionsCache",
    "additionalModelCostsCache",
    "modelAccessCache",
  ]) {
    delete config[k];
  }

  fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

// ── Credentials ───────────────────────────────────────────────────────────────

const PLACEHOLDER_CREDENTIALS = {
  claudeAiOauth: {
    accessToken: "1234",
    refreshToken: "",
    expiresAt: 4102444800000,
    scopes: [
      "user:file_upload",
      "user:inference",
      "user:mcp_servers",
      "user:profile",
      "user:sessions:claude_code",
    ],
    subscriptionType: "pro",
    rateLimitTier: "default_claude_ai",
  },
};

export async function ensureCredentials() {
  let hasValidCreds = false;
  try {
    if (await platform().credentialsExist()) {
      const creds = await platform().readOAuthCredentials();
      if (creds && creds.accessToken) {
        hasValidCreds = true;
      }
    }
  } catch {}

  if (!hasValidCreds) {
    p.log.warn("No valid Claude credentials found. Writing placeholder credentials...");
    await platform().writeOAuthCredentials(PLACEHOLDER_CREDENTIALS);
    p.log.success("Placeholder credentials created.");
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Ask which permission mode to launch Claude in (Normal vs
 * --dangerously-skip-permissions) and return the claude args accordingly.
 *
 * Lives here — not in index.ts — so EVERY launch path goes through it:
 * --share=, pairing, reconnect, and the no-arg picker all funnel into
 * launchClaude/launchClaudeReal, so the permission step is now consistent
 * instead of only appearing in the no-arg "active sharer" branch.
 *
 * Skips the prompt when the user already opted out via `--skip-permissions`
 * (claude-connect's own flag) or by passing `--dangerously-skip-permissions`
 * through to Claude directly.
 */
export async function resolvePermissionArgs(claudeArgs: string[]): Promise<string[]> {
  if (claudeArgs.includes("--dangerously-skip-permissions")) return claudeArgs;
  if (process.argv.includes("--skip-permissions")) {
    return ["--dangerously-skip-permissions", ...claudeArgs];
  }

  const mode = await p.select({
    message: "Launch mode:",
    options: [
      { value: "normal", label: "Normal", hint: "standard permission prompts" },
      {
        value: "skip",
        label: "Skip permissions",
        hint: "--dangerously-skip-permissions",
      },
    ],
  });
  if (p.isCancel(mode)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
  return mode === "skip"
    ? ["--dangerously-skip-permissions", ...claudeArgs]
    : claudeArgs;
}

export async function checkClaudeInstalled(): Promise<boolean> {
  const which = process.platform === "win32" ? "where" : "which";
  return execFileAsync(which, ["claude"])
    .then(() => true)
    .catch(() => false);
}

export async function sessionPost(
  serverUrl: string,
  endpoint: string,
  body: Record<string, string>,
  caPem?: string,
  proxyAuth?: string,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (proxyAuth) headers["Proxy-Authorization"] = proxyAuth;
  const r = await apiFetch(`${serverUrl}${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    timeout: 5_000,
    ca: caPem,
  });
  if (!r.ok) {
    // Surface why the sharer rejected us (e.g. 403 policy, 502 tunnel) instead
    // of silently returning {} — that's what turns into "no sessionId".
    let detail = "";
    try {
      const b = await r.json();
      detail = typeof b === "string" ? b : JSON.stringify(b);
    } catch {}
    logger.warn(`${endpoint} failed: HTTP ${r.status}${detail ? ` — ${detail.slice(0, 300)}` : ""}`);
    return {};
  }
  return r.json() as Promise<Record<string, unknown>>;
}

// ── Launch ────────────────────────────────────────────────────────────────────

export async function launchClaude(
  proxyUrl: string,
  caPem: string,
  meta: {
    systemName: string;
    id: string;
    proxyUser: string;
    proxyPass: string;
  },
  claudeArgs: string[] = [],
  sharerAccount: SharerAccount | null = null,
  cwd?: string,
) {
  if (!(await checkClaudeInstalled())) {
    p.log.error("Claude Code is not installed or not in PATH.");
    p.log.info("Install it with: npm install -g @anthropic-ai/claude-code");
    process.exit(1);
  }

  const connectSettingsPath = ensureConnectSettings(cwd);

  // Ask permission mode before any side effects so the prompt is the first
  // thing after picking a server, not buried behind session setup.
  claudeArgs = await resolvePermissionArgs(claudeArgs);

  checkAndShowClaudeSettings();
  ensureOnboarding();
  await ensureCredentials();

  if (sharerAccount) {
    applySharerAccount(sharerAccount);
    p.log.info(
      `Account: ${sharerAccount.displayName} (${sharerAccount.emailAddress})`,
    );
  }

  // NODE_EXTRA_CA_CERTS must contain BOTH the MITM CA (to trust intercepted
  // api.anthropic.com) AND the standard root CAs (so Claude's own tools — e.g.
  // the Fetch/WebFetch tool hitting real sites through the transparent tunnel —
  // still verify normal certs). Bun (Claude's runtime) treats this env var as
  // *replacing* the trust store rather than extending it, so a file with only
  // the MITM CA makes every non-Anthropic HTTPS fetch fail with an SSL error.
  const tmpCert = path.join(os.tmpdir(), `claude-share-ca-${Date.now()}.pem`);
  const caBundle = [caPem.trim(), ...tls.rootCertificates].join("\n") + "\n";
  fs.writeFileSync(tmpCert, caBundle, { mode: 0o600 });

  const proxyAuth =
    "Basic " +
    Buffer.from(`${meta.proxyUser}:${meta.proxyPass}`).toString("base64");

  // Context line so every session's log entries are attributable when debugging.
  try {
    logger.info(
      `Session context: proxy=${new URL(proxyUrl).host} machineId=${meta.id}`,
    );
  } catch {}

  // Register this Claude session with the sharer
  let sessionId: string | null = null;
  try {
    const res = await sessionPost(
      proxyUrl,
      "/session/start",
      { machineId: meta.id },
      caPem,
      proxyAuth,
    );
    sessionId = (res["sessionId"] as string) ?? null;
    if (!sessionId)
      logger.warn("session/start returned no sessionId", {
        machineId: meta.id,
      });
  } catch (err) {
    logger.error("session/start failed", err);
  }

  // 30-second heartbeat so sharer sees lastActiveAt update. A broken tunnel
  // (ECONNRESET etc.) shows up here first — log the transition to failing/
  // recovered once each instead of silently swallowing or spamming every 30s.
  let heartbeatFailing = false;
  const heartbeat = sessionId
    ? setInterval(() => {
        void sessionPost(
          proxyUrl,
          "/session/heartbeat",
          {
            machineId: meta.id,
            sessionId: sessionId!,
          },
          caPem,
          proxyAuth,
        )
          .then(() => {
            if (heartbeatFailing) {
              heartbeatFailing = false;
              logger.info("heartbeat recovered");
            }
          })
          .catch((err) => {
            if (!heartbeatFailing) {
              heartbeatFailing = true;
              logger.warn(
                `heartbeat connection failed (tunnel/proxy): ${(err as Error)?.message ?? err}`,
              );
            }
          });
      }, 30_000)
    : null;

  p.log.success("\x1b[32mLaunching Claude...\x1b[0m");

  p.outro("");

  const startTime = Date.now();

  const httpProxyUrl = buildProxyUrl(proxyUrl, meta.proxyUser, meta.proxyPass);

  // On Windows we spawn through the shell (so `claude`/`claude.cmd` resolves),
  // but cmd.exe then splits unquoted args on spaces — so a home dir like
  // "C:\Users\Duy Tran" turns `--settings C:\Users\Duy Tran\...` into a broken
  // `--settings C:\Users\Duy` ("Settings file not found"). Quote args that
  // contain whitespace when going through the shell.
  const useShell = process.platform === "win32";
  const shellQuote = (a: string) =>
    useShell && /\s/.test(a) && !a.startsWith('"') ? `"${a}"` : a;
  const spawnArgs = ["--settings", connectSettingsPath, ...claudeArgs].map(shellQuote);

  const child = spawn("claude", spawnArgs, {
    // stdin/stdout stay attached to the terminal so Claude's TUI renders as
    // normal; stderr is piped so a fast crash (bad --settings path, missing
    // deps, …) leaves a diagnosable reason in the log instead of a silent 0m 0s.
    stdio: ["inherit", "inherit", "pipe"],
    shell: useShell,
    ...(cwd ? { cwd } : {}),
    env: {
      ...process.env,
      HTTPS_PROXY: httpProxyUrl,
      HTTP_PROXY: httpProxyUrl,
      NODE_EXTRA_CA_CERTS: tmpCert,
    },
  });

  // Forward stderr live (so the user still sees it) while keeping the last ~8KB
  // to explain a fast exit.
  let stderrTail = "";
  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-8000);
    });
  }

  async function cleanupAndExit(code: number | null, signal: NodeJS.Signals | null = null) {
    // Do this first — the network call below can take up to 5s, and until
    // this runs, leftover mouse-tracking modes spam the terminal on every
    // mouse move.
    resetTerminalModes();
    if (heartbeat) clearInterval(heartbeat);
    if (sessionId) {
      await sessionPost(
        proxyUrl,
        "/session/end",
        { machineId: meta.id, sessionId },
        caPem,
        proxyAuth,
      ).catch(() => {});
    }
    try {
      fs.unlinkSync(tmpCert);
    } catch {}
    const durationMs = Date.now() - startTime;
    const duration = Math.floor(durationMs / 1000);
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    p.log.info(`Session ended. Duration: ${mins}m ${secs}s`);

    // A near-instant exit almost always means Claude failed to start (bad
    // --settings path, missing claude, crash). Surface the captured reason.
    if (durationMs < 2000 || (code !== 0 && code !== null)) {
      const reason = stderrTail.trim();
      logger.error(
        `claude exited fast: code=${code}, signal=${signal ?? "none"}, ${durationMs}ms` +
          (reason ? `\n--- claude stderr (tail) ---\n${reason}` : " — no stderr captured"),
      );
      if (durationMs < 2000) {
        p.log.warn(
          `Claude exited immediately (code ${code}).` +
            (reason
              ? `\n${reason}`
              : " No stderr captured — see ~/.claude-share/logs/connect.log."),
        );
      }
    }
    process.exit(code ?? 0);
  }

  child.on("exit", (code, signal) => {
    void cleanupAndExit(code, signal);
  });

  child.on("error", (err) => {
    resetTerminalModes();
    logger.error("Failed to launch claude process", err);
    p.log.error(`Failed to launch claude: ${err.message}`);
    p.log.warn(
      "Is 'claude' installed? Run: npm install -g @anthropic-ai/claude-code",
    );
    if (heartbeat) clearInterval(heartbeat);
    if (sessionId) {
      void sessionPost(
        proxyUrl,
        "/session/end",
        { machineId: meta.id, sessionId },
        caPem,
        proxyAuth,
      ).catch(() => {});
    }
    try {
      fs.unlinkSync(tmpCert);
    } catch {}
    process.exit(1);
  });

  // On Windows, child.kill() is always a hard TerminateProcess — the child's
  // own ink cleanup never runs — so disable mouse tracking here ourselves
  // before the child even dies, instead of waiting for its exit event.
  process.on("SIGINT", () => {
    resetTerminalModes();
    child.kill("SIGINT");
  });
  process.on("SIGTERM", () => {
    resetTerminalModes();
    child.kill("SIGTERM");
  });
}

// ── Real mode (own account, no proxy) ─────────────────────────────────────────

export async function launchClaudeReal(
  claudeArgs: string[] = [],
  cwd?: string,
) {
  if (!(await checkClaudeInstalled())) {
    p.log.error("Claude Code is not installed or not in PATH.");
    p.log.info("Install it with: npm install -g @anthropic-ai/claude-code");
    process.exit(1);
  }

  claudeArgs = await resolvePermissionArgs(claudeArgs);

  // Remove active-connection.json so VS Code extension patch doesn't inject proxy
  clearActiveConnection();

  p.log.success("\x1b[32mLaunching Claude (own account)...\x1b[0m");
  p.outro("");

  const startTime = Date.now();

  // Strip any proxy env vars that may be set from a previous share session
  const env = { ...process.env };
  delete env.HTTPS_PROXY;
  delete env.HTTP_PROXY;
  delete env.NODE_EXTRA_CA_CERTS;

  const child = spawn("claude", claudeArgs, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...(cwd ? { cwd } : {}),
    env,
  });

  child.on("exit", (code) => {
    resetTerminalModes();
    const duration = Math.floor((Date.now() - startTime) / 1000);
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    p.log.info(`Session ended. Duration: ${mins}m ${secs}s`);
    process.exit(code ?? 0);
  });

  child.on("error", (err) => {
    resetTerminalModes();
    logger.error("Failed to launch claude process", err);
    p.log.error(`Failed to launch claude: ${err.message}`);
    process.exit(1);
  });

  process.on("SIGINT", () => {
    resetTerminalModes();
    child.kill("SIGINT");
  });
  process.on("SIGTERM", () => {
    resetTerminalModes();
    child.kill("SIGTERM");
  });
}
