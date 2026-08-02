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

export function ensureConnectSettings(
  cwd?: string,
  env?: Record<string, string>,
): string {
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

  // Claude Code v2 runs a persistent daemon that spawns resumed/forked
  // conversations and background agents as SEPARATE `claude` processes — each
  // launched with `--settings <this file>` (verified in the process table). They
  // inherit the launcher's process env, but that env can go stale (e.g. a temp
  // CA path deleted on another launch's exit) and the daemon outlives the
  // launcher, so process-env inheritance alone isn't reliable across resumes.
  // Claude Code applies a settings `env` block to every session it starts, so
  // pinning the proxy + STABLE CA bundle here makes those agents pick up the
  // right values regardless of what env the daemon happened to inherit.
  if (env) {
    const existing = (settings["env"] as Record<string, string>) ?? {};
    settings["env"] = { ...existing, ...env };
  }

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
    // GrowthBook feature flags gate model availability (e.g. the fable
    // off-switch / velvet-hammer flags). Cached for the receiver's OWN account,
    // they can keep a model hidden/gated in /model even though the sharer's
    // token has it — clear them so the gates re-fetch fresh over the proxy too.
    "cachedGrowthBookFeatures",
    "cachedGrowthBookFeaturesAt",
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
    logger.warn(`[leg: receiver→bore→sharer] ${endpoint} failed: HTTP ${r.status}${detail ? ` — ${detail.slice(0, 300)}` : ""}`);
    // Surface the status so callers can distinguish a definitive "stale creds"
    // 407 from a transient failure without re-issuing the request.
    return { _status: r.status };
  }
  return r.json() as Promise<Record<string, unknown>>;
}

// ── Multi-account picker ────────────────────────────────────────────────────

interface AccountOption {
  id: string;
  email: string | null;
  plan: string | null;
  usage: Array<{ key: string; pct: number; resetsAt: string | null }> | null;
}

function fmtUsageHint(usage: AccountOption["usage"]): string {
  if (!usage || !usage.length) return "";
  const label = (k: string) =>
    k === "five_hour" ? "5h" : k === "seven_day" ? "week" : k.replace(/_/g, " ");
  return usage.map((u) => `${label(u.key)} ${u.pct}%`).join(" · ");
}

// When the sharer exposes several Claude accounts, let the receiver pin this
// launch to one of them (fixed for the whole session). A sharer without the
// multi-account endpoint (or with a single account) is a no-op → default token.
async function selectSharerAccount(
  proxyUrl: string,
  caPem: string,
  proxyAuth: string,
): Promise<void> {
  let accounts: AccountOption[] = [];
  let selected: string | null = null;
  try {
    const r = await apiFetch(`${proxyUrl}/accounts`, {
      headers: { "Proxy-Authorization": proxyAuth },
      timeout: 12_000,
      ca: caPem,
    });
    if (!r.ok) return; // older sharer without /accounts → single default account
    const data = (await r.json()) as {
      accounts?: AccountOption[];
      selected?: string | null;
    };
    accounts = data.accounts ?? [];
    selected = data.selected ?? null;
  } catch (err) {
    logger.warn("[accounts] could not fetch account list", err);
    return;
  }
  if (accounts.length <= 1) return; // nothing to choose

  const pick = await p.select({
    message: "Which shared account?",
    initialValue: selected ?? accounts[0].id,
    options: accounts.map((a) => ({
      value: a.id,
      label: a.email ?? a.id,
      hint: [a.plan, fmtUsageHint(a.usage)].filter(Boolean).join(" · ") || undefined,
    })),
  });
  if (p.isCancel(pick)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
  try {
    await sessionPost(
      proxyUrl,
      "/session/select-account",
      { accountId: pick as string },
      caPem,
      proxyAuth,
    );
    const chosen = accounts.find((a) => a.id === pick);
    if (chosen) p.log.info(`Using account: ${chosen.email ?? chosen.id}`);
  } catch (err) {
    logger.warn("[accounts] select-account failed", err);
  }
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
  transport: string | null = null,
  healProxy?: () => Promise<void>,
) {
  if (!(await checkClaudeInstalled())) {
    p.log.error("Claude Code is not installed or not in PATH.");
    p.log.info("Install it with: npm install -g @anthropic-ai/claude-code");
    process.exit(1);
  }

  // Stable proxy + CA-bundle path. Computed up front so they can be baked into
  // the connect settings.json `env` (inherited by daemon-spawned resume/agent
  // processes) as well as the direct spawn env below. The proxy URL and CA
  // bundle path are both stable for the whole session.
  const caBundlePath = path.join(os.homedir(), ".claude-share", "ca-bundle.pem");
  const httpProxyUrl = buildProxyUrl(proxyUrl, meta.proxyUser, meta.proxyPass);
  const proxyCaEnv: Record<string, string> = {
    HTTPS_PROXY: httpProxyUrl,
    HTTP_PROXY: httpProxyUrl,
    NODE_EXTRA_CA_CERTS: caBundlePath,
    SSL_CERT_FILE: caBundlePath,
    REQUESTS_CA_BUNDLE: caBundlePath,
    CURL_CA_BUNDLE: caBundlePath,
    GIT_SSL_CAINFO: caBundlePath,
  };

  const connectSettingsPath = ensureConnectSettings(cwd, proxyCaEnv);

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
  // Write the CA bundle to a STABLE path — NOT a per-launch temp file. A temp
  // file gets deleted on this session's exit, but background agents / resumed
  // sessions that outlive it (and Windows temp cleanup) then leave
  // NODE_EXTRA_CA_CERTS pointing at a missing file → "load failed: No such file
  // or directory" → the MITM cert is untrusted → every proxied request fails
  // ("Unable to connect to API / ConnectionRefused"). A stable, never-deleted
  // bundle is always present and safely shared across concurrent sessions.
  // (caBundlePath is defined up top so it can also be baked into settings.json.)
  const caBundle = [caPem.trim(), ...tls.rootCertificates].join("\n") + "\n";
  fs.mkdirSync(path.dirname(caBundlePath), { recursive: true });
  fs.writeFileSync(caBundlePath, caBundle, { mode: 0o600 });

  const proxyAuth =
    "Basic " +
    Buffer.from(`${meta.proxyUser}:${meta.proxyPass}`).toString("base64");

  // Context line so every session's log entries are attributable when debugging.
  try {
    logger.info(
      `Session context: proxy=${new URL(proxyUrl).host} machineId=${meta.id}`,
    );
  } catch {}

  // If the sharer exposes multiple accounts, pick one for this session before
  // registering — the sharer bills this machine's requests to the chosen one.
  await selectSharerAccount(proxyUrl, caPem, proxyAuth);

  // Register this Claude session with the sharer.
  // A 407 (stale proxyPass) or a TLS-cert mismatch (stale caPem / rotated CA)
  // means this saved connection is dead — don't spawn Claude against a proxy
  // that will reject or SSL-fail every request (which just looks like a hang /
  // "offline"). Fail fast and tell the user to grab a fresh connect link.
  let sessionId: string | null = null;
  const abortStale = (reason: string): never => {
    resetTerminalModes();
    p.log.error(
      `${reason}\nYour saved connection is no longer valid — the sharer restarted, ` +
        "re-shared, or revoked this device. Get a FRESH connect link and run:\n" +
        '  claude-connect --share "<new url>"',
    );
    process.exit(1);
  };
  try {
    const res = await sessionPost(
      proxyUrl,
      "/session/start",
      transport ? { machineId: meta.id, transport } : { machineId: meta.id },
      caPem,
      proxyAuth,
    );
    if (res["_status"] === 407) {
      abortStale("Proxy rejected your credentials (HTTP 407).");
    }
    sessionId = (res["sessionId"] as string) ?? null;
    if (!sessionId)
      logger.warn("[leg: receiver→bore→sharer] session/start returned no sessionId", {
        machineId: meta.id,
      });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "";
    const msg = String((err as Error)?.message ?? err);
    if (
      /^(UNABLE_TO|SELF_SIGNED|CERT_|DEPTH_ZERO|ERR_TLS)/.test(code) ||
      /certificate|self.signed|unable to (verify|get local issuer)|SSL/i.test(msg)
    ) {
      abortStale("TLS certificate mismatch — the sharer's proxy identity changed since you paired.");
    }
    logger.error("[leg: receiver→bore→sharer] session/start failed", err);
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
                `[leg: receiver→bore→sharer] heartbeat connection failed (tunnel/proxy): ${(err as Error)?.message ?? err}`,
              );
            }
          });
      }, 30_000)
    : null;

  // Network monitor: Claude makes its own API calls through HTTPS_PROXY, so
  // claude-connect can't see or log those requests. When Claude prints
  // "API error / check your network / Retrying", probe the tunnel here so
  // connect.log shows WHICH leg is broken:
  //   unreachable → CLIENT-side (this machine's network/VPN, or bore/the share
  //                 is offline) — that's what Claude's "check your network" means.
  //   reachable   → the tunnel is fine, so the failure is SERVER-side
  //                 (sharer ↔ Anthropic). Look at the sharer dashboard "Errors"
  //                 tab / logs at the same timestamp for the real status/reason.
  let netReachable: boolean | null = null;
  let healing = false;
  const netMonitor = setInterval(() => {
    void apiFetch(`${proxyUrl}/health`, { timeout: 6000, ca: caPem })
      .then(() => {
        if (netReachable !== true) {
          netReachable = true;
          logger.info(
            "[net] tunnel to sharer reachable (proxy /health OK) — any Claude API errors right now are SERVER-side; check the sharer dashboard Errors tab",
          );
        }
      })
      .catch((err) => {
        if (netReachable !== false) {
          netReachable = false;
          logger.warn(
            `[net] CANNOT reach sharer through tunnel (leg receiver→bore→sharer DOWN): ${(err as Error)?.message ?? err} — ` +
              `Claude's "check your network"/Retrying errors are a CLIENT-side tunnel problem (this machine's network/VPN, or bore/the share is offline), not the sharer's account`,
          );
        }
        // A Cloudflare share's local bridge may have dropped — re-ensure it on its
        // pinned port (no-op if healthy) so HTTPS_PROXY stays valid and Claude
        // reconnects on its own instead of retrying a dead proxy forever.
        if (healProxy && !healing) {
          healing = true;
          void healProxy()
            .then(() => logger.info("[net] cloudflare bridge re-ensured after drop"))
            .catch(() => {})
            .finally(() => {
              healing = false;
            });
        }
      });
  }, 15_000);
  netMonitor.unref?.();

  p.log.success("\x1b[32mLaunching Claude...\x1b[0m");

  p.outro("");

  const startTime = Date.now();

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
      NODE_EXTRA_CA_CERTS: caBundlePath,
      // Claude's child processes (MCP servers, and the tools THEY spawn — uv,
      // pip, curl, git…) inherit HTTPS_PROXY and so tunnel through the MITM
      // proxy, but non-Node tools don't read NODE_EXTRA_CA_CERTS, so they reject
      // the proxy's self-signed cert ("invalid peer certificate / tunnel error /
      // can't auth"). Point their CA-bundle env vars at the same bundle (MITM CA
      // + real roots) so they trust the proxy AND still validate real sites.
      SSL_CERT_FILE: caBundlePath,
      REQUESTS_CA_BUNDLE: caBundlePath,
      CURL_CA_BUNDLE: caBundlePath,
      GIT_SSL_CAINFO: caBundlePath,
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
    clearInterval(netMonitor);
    if (sessionId) {
      await sessionPost(
        proxyUrl,
        "/session/end",
        { machineId: meta.id, sessionId },
        caPem,
        proxyAuth,
      ).catch(() => {});
    }
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
    clearInterval(netMonitor);
    if (sessionId) {
      void sessionPost(
        proxyUrl,
        "/session/end",
        { machineId: meta.id, sessionId },
        caPem,
        proxyAuth,
      ).catch(() => {});
    }
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
