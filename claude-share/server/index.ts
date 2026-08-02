import { Hono } from "hono";
import { html } from "hono/html";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  getSession,
  checkPairingCode,
  checkMachineAuth,
  addMachine,
  encryptConnectionFile,
  isSessionExpired,
  saveSession,
  addMachineSession,
  endMachineSession,
  heartbeatMachineSession,
  regeneratePairingCode,
  removeMachine,
  resolveMachineId,
  setMachineAccount,
  setMachineTransport,
  setSessionUnlimited,
  type ConnectionFile,
  type SharerAccount,
} from "../session/manager";

import { getTotalStats, getMachineStats } from "../proxy/tokenCounter";
import { getMachineBytes, getTotalBytes } from "../proxy/bytesCounter";
import { getEntries } from "../proxy/requestLog";
import { readUsageEvents, byModel } from "../proxy/usageLog";
import {
  getFreshAccessToken,
  hasAccount,
  listAccounts,
} from "../proxy/token";
import {
  isRecording,
  setRecording,
  isIncludingMessages,
  setIncludeMessages,
  listFlows,
  readFlow,
} from "../proxy/flowLog";

interface Urls {
  public: string | null;
  lan: string | null;
}

// Keys whose values must never leave the sharer's machine, even to the (auth'd)
// dashboard. The Sessions tab shows saved state files with these stripped.
const SECRET_KEYS = new Set([
  "key",
  "pairingCode",
  "proxyPass",
  "secret",
  "password",
  "accessToken",
  "refreshToken",
  "token",
]);

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.has(k) ? "[REDACTED]" : redactSecrets(v);
    }
    return out;
  }
  return value;
}

export function createApiApp(
  urls: Urls,
  caPem: string,
  sharerAccount: SharerAccount | null,
  systemName: string,
  getTunnelDown: () => boolean = () => false,
): Hono {
  const app = new Hono();

  // Middleware to authenticate proxy clients. Bypass health, pair, connect, and web dashboard.
  app.use("*", async (c, next) => {
    const p = c.req.path;
    if (
      p === "/health" ||
      p === "/pair" ||
      p.startsWith("/connect/") ||
      p === "/dashboard" ||
      p.startsWith("/api/dashboard/")
    ) {
      return next();
    }
    const session = getSession();
    const auth = c.req.header("proxy-authorization");
    if (!auth || !session || !checkMachineAuth(session, auth)) {
      return c.text("Unauthorized", 407);
    }
    return next();
  });

  app.get("/health", (c) => {
    const session = getSession();
    const tunnelDown = getTunnelDown();
    return c.json(
      {
        ok: !tunnelDown,
        tunnelDown,
        publicUrl: urls.public,
        sessionActive: !!session && !isSessionExpired(session),
        sessionId: session?.id ?? null,
      },
      tunnelDown ? 503 : 200,
    );
  });

  /** GET /connect/:code — human-readable hint when someone opens the URL in a browser */
  app.get("/connect/:code", (c) => {
    const url = c.req.url;
    return c.text(
      `This is a claude-share connect link — it cannot be opened in a browser.\n\n` +
        `Run this instead:\n\n  claude-connect --share "${url}"\n`,
      200,
      { "Content-Type": "text/plain; charset=utf-8" },
    );
  });

  /** POST /pair — one-time pairing with a machine */
  app.post("/pair", async (c) => {
    const session = getSession();
    if (!session || isSessionExpired(session))
      return c.json({ error: "No active session" }, 503);

    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const body = await c.req.json<{ code?: string; name?: string }>();
    const code = body.code?.trim() ?? "";
    const name = body.name?.trim() ?? "unknown device";

    if (!checkPairingCode(session, ip, code))
      return c.json({ error: "Invalid pairing code" }, 401);

    const machine = addMachine(session, name);
    saveSession(session);

    // Cloudflare Tunnel is an opt-in second public path (set on the sharer via
    // env). It rides in the encrypted blob so the receiver can bridge to it.
    const cfHostname = process.env.CLOUDFLARE_TUNNEL_HOSTNAME?.trim();
    const cloudflare = cfHostname
      ? {
          hostname: cfHostname,
          serviceTokenId: process.env.CLOUDFLARE_ACCESS_CLIENT_ID?.trim() || undefined,
          serviceTokenSecret: process.env.CLOUDFLARE_ACCESS_CLIENT_SECRET?.trim() || undefined,
        }
      : null;

    const file: ConnectionFile = {
      publicServerUrl: urls.public,
      sessionId: session.id,
      sharedUntil: session.sharedUntil.toISOString(),
      caPem,
      sharerAccount,
      systemName,
      proxyUser: machine.id,
      proxyPass: machine.proxyPass,
      cloudflare,
    };

    const blob = encryptConnectionFile(session, file);

    // Auto-rotate the pairing code after every successful pair. The code is
    // single-use, so mint a fresh one immediately: the dashboard then always
    // shows a usable code and the next device can pair without a manual
    // Regenerate. `blob` above was encrypted with the OLD key, so this receiver
    // (holding the old code) still decrypts fine.
    regeneratePairingCode(session);
    saveSession(session);

    return c.json({ blob, machineId: machine.id });
  });

  /** POST /session/start — receiver opened a Claude session */
  app.post("/session/start", async (c) => {
    const session = getSession();
    if (!session) return c.json({ error: "No active session" }, 503);
    const { machineId, transport } = await c.req.json<{
      machineId: string;
      transport?: string;
    }>();
    const ms = addMachineSession(session, machineId);
    if (!ms) return c.json({ error: "Machine not found" }, 404);
    if (transport) setMachineTransport(session, machineId, transport);
    return c.json({ ok: true, sessionId: ms.id });
  });

  /** POST /session/end — receiver closed a Claude session */
  app.post("/session/end", async (c) => {
    const session = getSession();
    if (!session) return c.json({ error: "No active session" }, 503);
    const { machineId, sessionId } = await c.req.json<{
      machineId: string;
      sessionId: string;
    }>();
    endMachineSession(session, machineId, sessionId);
    return c.json({ ok: true });
  });

  /** POST /session/heartbeat — receiver is still alive */
  app.post("/session/heartbeat", async (c) => {
    const session = getSession();
    if (!session) return c.json({ error: "No active session" }, 503);
    const { machineId, sessionId } = await c.req.json<{
      machineId: string;
      sessionId: string;
    }>();
    heartbeatMachineSession(session, machineId, sessionId);
    return c.json({ ok: true });
  });

  /** GET /machines — list machines and their sessions */
  app.get("/machines", (c) => {
    const session = getSession();
    if (!session) return c.json({ machines: [] });
    const machines = [...session.machines.values()].map((m) => ({
      id: m.id,
      name: m.name,
      pairedAt: m.pairedAt.toISOString(),
      sessions: [...m.sessions.values()].map((s) => ({
        id: s.id,
        startedAt: s.startedAt.toISOString(),
        lastActiveAt: s.lastActiveAt.toISOString(),
        active: s.active,
      })),
    }));
    return c.json({ machines, sharedUntil: session.sharedUntil.toISOString() });
  });

  // ── Multi-account: receiver picks which sharer account to use ──────────────

  // /api/oauth/usage is rate-limited (429), so cache each account's utilization
  // for 5 minutes. Shared by the account picker so a receiver listing accounts
  // doesn't hammer Anthropic once per account per refresh.
  const acctUsageCache = new Map<
    string,
    { at: number; usage: Array<{ key: string; pct: number; resetsAt: string | null }> | null }
  >();
  const ACCT_USAGE_TTL = 5 * 60 * 1000;

  function summarizeUsage(
    usage: Record<string, any>,
  ): Array<{ key: string; pct: number; resetsAt: string | null }> {
    return Object.entries(usage || {})
      .filter(
        ([, v]) => v && typeof v === "object" && ("utilization" in v || "percent" in v),
      )
      .map(([key, v]) => {
        const rawVal = (v.utilization ?? v.percent) || 0;
        const pct = rawVal <= 1 ? Math.round(rawVal * 100) : Math.round(rawVal);
        return { key, pct, resetsAt: v.resets_at ?? null };
      });
  }

  async function accountUsage(accountId: string) {
    const cached = acctUsageCache.get(accountId);
    if (cached && Date.now() - cached.at < ACCT_USAGE_TTL) return cached.usage;
    try {
      const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: {
          authorization: `Bearer ${await getFreshAccessToken(accountId)}`,
          "anthropic-beta": "oauth-2025-04-20",
          "anthropic-version": "2023-06-01",
        },
      });
      if (!res.ok) {
        if (cached) return cached.usage; // serve last good on 429/5xx
        return null;
      }
      const usage = summarizeUsage((await res.json()) as Record<string, any>);
      acctUsageCache.set(accountId, { at: Date.now(), usage });
      return usage;
    } catch {
      return cached?.usage ?? null;
    }
  }

  /**
   * GET /accounts — the sharer accounts a receiver may pick from, with each
   * account's email, plan and live /usage utilization. Proxy-authed (only paired
   * machines can list accounts). Fixed at launch: the receiver POSTs its choice
   * to /session/select-account before starting Claude.
   */
  app.get("/accounts", async (c) => {
    const metas = listAccounts();
    const accounts = await Promise.all(
      metas.map(async (m) => ({
        id: m.id,
        email: m.email,
        plan: m.plan,
        usage: await accountUsage(m.id),
      })),
    );
    const session = getSession();
    const auth = c.req.header("proxy-authorization") ?? "";
    const mid = session ? resolveMachineId(session, auth) : null;
    const selected = mid ? session!.machines.get(mid)?.selectedAccount ?? null : null;
    return c.json({ accounts, selected });
  });

  /**
   * POST /session/select-account {accountId} — pin this machine's requests to a
   * sharer account for the whole session. The machine is resolved from its own
   * proxy-auth (a machine can only set its own selection).
   */
  app.post("/session/select-account", async (c) => {
    const session = getSession();
    if (!session) return c.json({ error: "No active session" }, 503);
    const auth = c.req.header("proxy-authorization") ?? "";
    const mid = resolveMachineId(session, auth);
    if (!mid) return c.json({ error: "Machine not found" }, 404);
    const { accountId } = await c.req.json<{ accountId?: string | null }>();
    if (accountId != null && !hasAccount(accountId)) {
      return c.json({ error: "Unknown account" }, 400);
    }
    setMachineAccount(session, mid, accountId ?? null);
    return c.json({ ok: true });
  });

  // ── Web Dashboard Routes ──────────────────────────────────────────────────

  /** GET /dashboard — serves the beautiful web UI page */
  app.get("/dashboard", (c) => {
    return c.html(
      html`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>claude-share Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <script>
        tailwind.config = {
            theme: {
                extend: {
                    fontFamily: {
                        sans: ['Plus Jakarta Sans', 'sans-serif'],
                        mono: ['JetBrains Mono', 'monospace'],
                    }
                }
            }
        }
    </script>
    <style>
        body {
            background-color: #09090b;
            color: #fafafa;
        }
        .glass-panel {
            background: rgba(24, 24, 27, 0.75);
            backdrop-filter: blur(16px);
            border: 1px solid rgba(63, 63, 70, 0.35);
        }
        .glass-panel-glow {
            box-shadow: 0 0 25px rgba(6, 182, 212, 0.05);
        }
        .gradient-text {
            background: linear-gradient(135deg, #22d3ee 0%, #34d399 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
    </style>
</head>
<body class="font-sans min-h-screen flex flex-col antialiased bg-zinc-950 text-zinc-100">
    <!-- Authorization View -->
    <div id="auth-view" class="hidden flex-1 flex items-center justify-center p-4">
        <div class="glass-panel w-full max-w-md p-8 rounded-2xl shadow-xl flex flex-col text-center">
            <h1 class="text-3xl font-extrabold tracking-tight mb-2 gradient-text">claude-share</h1>
            <p class="text-zinc-400 text-sm mb-6">Enter the active pairing code to access the dashboard</p>
            <form id="login-form" class="space-y-4">
                <input type="text" id="pairing-code-input" placeholder="Pairing Code" 
                       class="w-full px-4 py-3 bg-zinc-900 border border-zinc-700 rounded-xl focus:outline-none focus:border-cyan-500 text-center font-mono text-xl tracking-widest text-zinc-100 placeholder-zinc-600 transition" />
                <button type="submit" class="w-full py-3 px-4 bg-gradient-to-r from-cyan-500 to-emerald-500 text-zinc-950 font-bold rounded-xl hover:opacity-90 active:scale-[0.98] transition">
                    Unlock Dashboard
                </button>
            </form>
        </div>
    </div>

    <!-- Main Dashboard View -->
    <div id="dashboard-view" class="hidden flex-1 flex flex-col">
        <!-- Top Navbar -->
        <header class="glass-panel border-t-0 border-x-0 py-4 px-6 flex items-center justify-between sticky top-0 z-50">
            <div class="flex items-center gap-3">
                <span class="text-xl font-bold tracking-tight gradient-text">claude-share</span>
                <span id="port-badge" class="px-2 py-0.5 text-xs font-semibold bg-zinc-800 text-zinc-400 rounded-md"></span>
            </div>
            <div class="flex items-center gap-4">
                <div class="text-right">
                    <span class="text-xs text-zinc-400 block">Host Name</span>
                    <span id="system-name" class="text-sm font-semibold text-zinc-200"></span>
                </div>
                <button id="logout-btn" onclick="setPairingCode(''); showAuth();" 
                        class="px-3 py-1.5 text-xs font-semibold text-zinc-400 border border-zinc-800 hover:bg-zinc-900 rounded-lg transition">
                    Lock
                </button>
            </div>
        </header>

        <main class="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6">
            <!-- Tab bar -->
            <div class="flex gap-1 mb-6 border-b border-zinc-800">
                <button data-tab="dashboard" onclick="showTab('dashboard')" class="tab-btn px-4 py-2 text-sm font-semibold border-b-2 border-cyan-500 text-cyan-400">Dashboard</button>
                <button data-tab="errors" onclick="showTab('errors')" class="tab-btn px-4 py-2 text-sm font-semibold border-b-2 border-transparent text-zinc-400 hover:text-zinc-200">Errors</button>
                <button data-tab="sessions" onclick="showTab('sessions')" class="tab-btn px-4 py-2 text-sm font-semibold border-b-2 border-transparent text-zinc-400 hover:text-zinc-200">Sessions</button>
                <button data-tab="dev" onclick="showTab('dev')" class="tab-btn px-4 py-2 text-sm font-semibold border-b-2 border-transparent text-zinc-400 hover:text-zinc-200">Dev</button>
            </div>

            <!-- Dashboard tab -->
            <div id="tab-dashboard" class="tab-panel space-y-6">
            <!-- Grid of Header Cards -->
            <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                <!-- Share Link Details -->
                <div class="glass-panel p-5 rounded-2xl md:col-span-2 space-y-4">
                    <h3 class="text-base font-semibold text-zinc-300">Quick Connect</h3>
                    <div class="space-y-3">
                        <div>
                            <span class="text-xs text-zinc-500 block mb-1">Terminal connection command:</span>
                            <div class="flex gap-2">
                                <input type="text" id="connect-cmd-text" readOnly 
                                       class="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-cyan-400 select-all" />
                                <button onclick="copyVal('connect-cmd-text')" class="px-3 py-2 bg-zinc-800 text-xs font-semibold hover:bg-zinc-700 text-cyan-400 rounded-lg transition">Copy</button>
                            </div>
                        </div>
                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                                <span class="text-xs text-zinc-500 block mb-1">Pairing Code:</span>
                                <div class="flex gap-2">
                                    <input type="text" id="pairing-code-text" readOnly 
                                           class="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-emerald-400 text-center select-all" />
                                    <button onclick="copyVal('pairing-code-text')" class="px-3 py-2 bg-zinc-800 text-xs font-semibold hover:bg-zinc-700 text-emerald-400 rounded-lg transition">Copy</button>
                                </div>
                            </div>
                            <div>
                                <span class="text-xs text-zinc-500 block mb-1">Receiver Connect URL:</span>
                                <div class="flex gap-2">
                                    <input type="text" id="pairing-link-text" readOnly 
                                           class="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-zinc-400 select-all" />
                                    <button onclick="copyVal('pairing-link-text')" class="px-3 py-2 bg-zinc-800 text-xs font-semibold hover:bg-zinc-700 text-zinc-400 rounded-lg transition">Copy</button>
                                </div>
                            </div>
                        </div>
                        <div id="cf-link-row" style="display:none">
                            <span class="text-xs text-zinc-500 block mb-1">Cloudflare Connect URL (share.rocl.one):</span>
                            <div class="flex gap-2">
                                <input type="text" id="cf-link-text" readOnly class="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-orange-400 select-all" />
                                <button onclick="copyVal('cf-link-text')" class="px-3 py-2 bg-zinc-800 text-xs font-semibold hover:bg-zinc-700 text-orange-400 rounded-lg transition">Copy</button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Session Time Card -->
                <div class="glass-panel p-5 rounded-2xl flex flex-col justify-between">
                    <div>
                        <div class="flex items-center justify-between mb-1">
                            <h3 class="text-base font-semibold text-zinc-300">Time Remaining</h3>
                            <button id="unlimited-btn" class="px-3 py-1.5 text-xs font-semibold text-emerald-400 border border-emerald-950/30 bg-emerald-950/10 hover:bg-emerald-950/20 rounded-lg transition">
                                Set Unlimited
                            </button>
                        </div>
                        <span id="remaining-time" class="text-3xl font-bold tracking-tight text-zinc-200 block py-2 font-mono"></span>
                    </div>
                    <div class="border-t border-zinc-800/80 pt-3 flex items-center justify-between">
                        <div>
                            <span class="text-xs text-zinc-500 block">Tunnel status</span>
                            <span id="tunnel-status" class="text-xs font-semibold"></span>
                        </div>
                        <button id="regen-btn" class="px-3 py-1.5 text-xs font-semibold text-amber-400 border border-amber-950/30 bg-amber-950/10 hover:bg-amber-950/20 rounded-lg transition">
                            New Code
                        </button>
                    </div>
                </div>
            </div>

            <!-- Stats Dashboard Cards -->
            <div class="grid grid-cols-2 md:grid-cols-6 gap-4">
                <!-- Total Cost (Big) -->
                <div class="glass-panel p-5 rounded-2xl col-span-2 flex flex-col justify-center border-l-cyan-500 border-l-2">
                    <span class="text-xs font-semibold text-zinc-400 uppercase tracking-wider block">Estimated Cost</span>
                    <span id="total-cost" class="text-4xl font-extrabold text-zinc-100 py-1 font-mono"></span>
                    <span class="text-xs text-cyan-500 font-medium">Claude 3.5 Sonnet Pricing</span>
                </div>
                <!-- Input tokens -->
                <div class="glass-panel p-4 rounded-xl flex flex-col justify-between">
                    <span class="text-xs text-zinc-400 block">Input</span>
                    <span id="stat-input" class="text-2xl font-bold text-zinc-200 font-mono"></span>
                </div>
                <!-- Output tokens -->
                <div class="glass-panel p-4 rounded-xl flex flex-col justify-between">
                    <span class="text-xs text-zinc-400 block">Output</span>
                    <span id="stat-output" class="text-2xl font-bold text-zinc-200 font-mono"></span>
                </div>
                <!-- Cache read -->
                <div class="glass-panel p-4 rounded-xl flex flex-col justify-between">
                    <span class="text-xs text-zinc-400 block">Cache Read</span>
                    <span id="stat-cache-read" class="text-2xl font-bold text-zinc-200 font-mono"></span>
                </div>
                <!-- Cache write -->
                <div class="glass-panel p-4 rounded-xl flex flex-col justify-between">
                    <span class="text-xs text-zinc-400 block">Cache Write</span>
                    <span id="stat-cache-write" class="text-2xl font-bold text-zinc-200 font-mono"></span>
                </div>
            </div>

            <!-- Global requests counter -->
            <div class="glass-panel px-6 py-4 rounded-2xl flex items-center justify-between text-sm text-zinc-400">
                <span>Total requests forwarded</span>
                <span id="stat-requests" class="text-lg font-bold text-zinc-200 font-mono"></span>
            </div>

            <!-- Usage breakdown -->
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div class="glass-panel rounded-2xl overflow-hidden lg:col-span-2">
                    <div class="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/10">
                        <h3 class="text-base font-semibold text-zinc-200">Usage (live)</h3>
                        <span class="text-[10px] text-zinc-500">Sharer's plan limits · via Anthropic</span>
                    </div>
                    <div class="p-4 space-y-4 text-xs" id="live-usage-container"></div>
                </div>
                <div class="glass-panel rounded-2xl overflow-hidden">
                    <div class="px-6 py-4 border-b border-zinc-800 bg-zinc-900/10">
                        <h3 class="text-base font-semibold text-zinc-200">By Model (tokens)</h3>
                    </div>
                    <div class="p-4 space-y-2 text-xs" id="usage-models-container"></div>
                </div>
            </div>

            <!-- Connected Devices Table -->
            <div class="glass-panel rounded-2xl overflow-hidden">
                <div class="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/10">
                    <h3 class="text-base font-semibold text-zinc-200">Connected Devices</h3>
                </div>
                <div class="overflow-x-auto">
                    <table class="w-full text-left border-collapse">
                        <thead>
                            <tr class="border-b border-zinc-800 text-zinc-400 text-xs font-semibold uppercase tracking-wider bg-zinc-900/20">
                                <th class="py-3 px-4">Device Name</th>
                                <th class="py-3 px-4">ID</th>
                                <th class="py-3 px-4">Usage (Tokens)</th>
                                <th class="py-3 px-4">Estimated Spend</th>
                                <th class="py-3 px-4">Traffic (&uarr; / &darr; &middot; live)</th>
                                <th class="py-3 px-4">Transport &middot; bore/cf</th>
                                <th class="py-3 px-4 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody id="machines-tbody" class="divide-y divide-zinc-800/50">
                            <!-- Populated dynamically -->
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- Live Request Logs -->
            <div class="glass-panel rounded-2xl overflow-hidden">
                <div class="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/10">
                    <div class="flex items-center gap-3">
                        <h3 class="text-base font-semibold text-zinc-200">Live Request Log</h3>
                        <span class="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="text-xs text-zinc-500">Filter:</span>
                        <select id="log-filter-device" onchange="loadLogs()" class="bg-zinc-900 border border-zinc-800 text-xs text-zinc-300 rounded-lg px-2.5 py-1 focus:outline-none focus:border-cyan-500">
                            <option value="">All Devices</option>
                        </select>
                    </div>
                </div>
                <div class="p-4 bg-zinc-950 font-mono text-xs max-h-60 overflow-y-auto space-y-1.5" id="logs-container" style="max-height: 250px;">
                    <!-- Logs populated here -->
                </div>
            </div>

            </div><!-- end #tab-dashboard -->

            <!-- Errors tab -->
            <div id="tab-errors" class="tab-panel hidden">
            <!-- API Error History -->
            <div id="error-logs-section" class="glass-panel rounded-2xl overflow-hidden border-l-red-500 border-l-2">
                <div class="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/10">
                    <div class="flex items-center gap-2">
                        <h3 class="text-base font-semibold text-zinc-200">API Error History</h3>
                        <span class="px-2 py-0.5 text-[10px] font-bold bg-red-950/20 text-red-400 border border-red-900/30 rounded-md">Error Logger</span>
                    </div>
                    <button onclick="loadErrorLogsList()" class="text-xs text-cyan-400 font-semibold hover:text-cyan-300">Refresh</button>
                </div>
                <div class="p-4 bg-zinc-950/50 max-h-[32rem] overflow-y-auto space-y-2 text-xs" id="error-logs-list-container">
                    <!-- Error logs populated here -->
                </div>
            </div>
            </div><!-- end #tab-errors -->

            <!-- Sessions tab -->
            <div id="tab-sessions" class="tab-panel hidden space-y-4">
                <div class="glass-panel rounded-2xl overflow-hidden">
                    <div class="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/10">
                        <h3 class="text-base font-semibold text-zinc-200">Saved State Files</h3>
                        <button onclick="loadStateFiles()" class="text-xs text-cyan-400 font-semibold hover:text-cyan-300">Refresh</button>
                    </div>
                    <div class="p-4 bg-zinc-950/50 space-y-2 text-xs" id="state-files-container"></div>
                </div>
                <div id="state-file-viewer" class="hidden glass-panel rounded-2xl overflow-hidden">
                    <div class="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/10">
                        <h3 class="text-base font-semibold text-zinc-200 font-mono" id="state-file-name">File</h3>
                        <button onclick="document.getElementById('state-file-viewer').classList.add('hidden')" class="text-zinc-400 hover:text-zinc-200 text-lg font-bold">&times;</button>
                    </div>
                    <pre class="p-6 overflow-auto font-mono text-xs bg-zinc-950 text-zinc-300 max-h-[32rem] select-all" id="state-file-content" style="white-space: pre-wrap; word-break: break-all;"></pre>
                </div>
                <p class="text-[11px] text-zinc-500 px-2">Secrets (session keys, pairing codes, proxy passwords, tokens) are redacted before display.</p>
            </div>

            <!-- Dev tab -->
            <div id="tab-dev" class="tab-panel hidden space-y-4">
                <div class="glass-panel rounded-2xl overflow-hidden border-l-purple-500 border-l-2">
                    <div class="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/10">
                        <div class="flex items-center gap-3">
                            <h3 class="text-base font-semibold text-zinc-200">Traffic Recorder</h3>
                            <span id="rec-state" class="px-2 py-0.5 text-[10px] font-bold rounded-md bg-zinc-800 text-zinc-400">OFF</span>
                        </div>
                        <div class="flex items-center gap-3">
                            <label class="flex items-center gap-1.5 text-[11px] text-zinc-400 cursor-pointer select-none">
                                <input type="checkbox" id="rec-include-messages" onchange="toggleIncludeMessages()" class="accent-purple-500" />
                                Include messages (prompts)
                            </label>
                            <button id="rec-toggle" onclick="toggleRecording()" class="px-3 py-1.5 text-xs font-semibold text-purple-300 border border-purple-950/40 bg-purple-950/10 hover:bg-purple-950/20 rounded-lg transition">Start recording</button>
                            <button onclick="loadFlows()" class="text-xs text-cyan-400 font-semibold hover:text-cyan-300">Refresh</button>
                        </div>
                    </div>
                    <div class="px-6 py-2 text-[11px] text-amber-400/70 bg-amber-950/10 border-b border-zinc-800">Records the API calls (usage, profile, models, telemetry) to disk (~/.claude-share/flows). <b>/v1/messages</b> (your prompts) are excluded unless you tick "Include messages".</div>
                    <div class="p-4 bg-zinc-950/50 max-h-80 overflow-y-auto space-y-2 text-xs" id="flows-container"></div>
                </div>
                <div id="flow-viewer" class="hidden glass-panel rounded-2xl overflow-hidden">
                    <div class="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/10">
                        <h3 class="text-base font-semibold text-zinc-200 font-mono" id="flow-title">Flow</h3>
                        <div class="flex items-center gap-2">
                            <button id="flow-replay-btn" class="px-3 py-1.5 text-xs font-semibold text-emerald-300 border border-emerald-950/40 bg-emerald-950/10 hover:bg-emerald-950/20 rounded-lg transition">Replay</button>
                            <button onclick="document.getElementById('flow-viewer').classList.add('hidden')" class="text-zinc-400 hover:text-zinc-200 text-lg font-bold">&times;</button>
                        </div>
                    </div>
                    <div class="grid grid-cols-1 lg:grid-cols-2 gap-0 divide-y lg:divide-y-0 lg:divide-x divide-zinc-800">
                        <div>
                            <div class="px-4 py-2 text-[10px] uppercase font-bold text-zinc-500 border-b border-zinc-800">Request</div>
                            <pre class="p-4 overflow-auto font-mono text-[11px] bg-zinc-950 text-zinc-300 max-h-96 select-all" id="flow-req" style="white-space: pre-wrap; word-break: break-all;"></pre>
                        </div>
                        <div>
                            <div class="px-4 py-2 text-[10px] uppercase font-bold text-zinc-500 border-b border-zinc-800">Response</div>
                            <pre class="p-4 overflow-auto font-mono text-[11px] bg-zinc-950 text-zinc-300 max-h-96 select-all" id="flow-res" style="white-space: pre-wrap; word-break: break-all;"></pre>
                        </div>
                    </div>
                    <div id="flow-replay-result" class="hidden border-t border-zinc-800">
                        <div class="px-4 py-2 text-[10px] uppercase font-bold text-emerald-500 border-b border-zinc-800">Replay result <span id="flow-replay-status" class="text-zinc-400"></span></div>
                        <pre class="p-4 overflow-auto font-mono text-[11px] bg-zinc-950 text-zinc-300 max-h-96 select-all" id="flow-replay-body" style="white-space: pre-wrap; word-break: break-all;"></pre>
                    </div>
                </div>
            </div>
        </main>
    </div>

    <!-- Error Details Modal -->
    <div id="error-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-950/80 backdrop-blur-sm">
        <div class="glass-panel w-full max-w-4xl max-h-[85vh] flex flex-col rounded-2xl overflow-hidden shadow-2xl">
            <div class="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/10">
                <h3 class="text-base font-semibold text-zinc-200">API Error Log Details</h3>
                <button onclick="closeErrorModal()" class="text-zinc-400 hover:text-zinc-200 text-lg font-bold">&times;</button>
            </div>
            <div class="p-6 overflow-y-auto font-mono text-xs space-y-4 bg-zinc-950 select-all" id="error-modal-content" style="white-space: pre-wrap; word-break: break-all;">
                <!-- Log content here -->
            </div>
            <div class="px-6 py-4 border-t border-zinc-800 flex justify-end bg-zinc-900/10">
                <button onclick="closeErrorModal()" class="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-zinc-300 rounded-lg transition">Close</button>
            </div>
        </div>
    </div>

    <!-- Scripts -->
    <script>
        const el = id => document.getElementById(id);
        const getPairingCode = () => localStorage.getItem('pairing_code') || '';
        const setPairingCode = code => localStorage.setItem('pairing_code', code);

        function showAuth() {
            el('auth-view').classList.remove('hidden');
            el('dashboard-view').classList.add('hidden');
            if (statsInterval) {
                clearInterval(statsInterval);
                statsInterval = null;
            }
        }

        function showDashboard() {
            el('auth-view').classList.add('hidden');
            el('dashboard-view').classList.remove('hidden');
            if (!statsInterval) {
                statsInterval = setInterval(async () => {
                    await loadStats();
                }, 3000);
            }
        }

        async function apiCall(endpoint, method = 'GET', body = null, isText = false) {
            const headers = {
                'x-pairing-code': getPairingCode(),
            };
            if (body) {
                headers['Content-Type'] = 'application/json';
            }
            const res = await fetch(endpoint, {
                method,
                headers,
                body: body ? JSON.stringify(body) : null
            });
            if (res.status === 401) {
                showAuth();
                throw new Error('Unauthorized');
            }
            if (!res.ok) {
                const txt = await res.text();
                throw new Error(txt || 'API Error');
            }
            return isText ? res.text() : res.json();
        }

        async function handleLogin(e) {
            e.preventDefault();
            const code = el('pairing-code-input').value.trim();
            if (!code) return;
            setPairingCode(code);
            try {
                await loadStats();
                showDashboard();
            } catch {
                alert('Invalid pairing code!');
                setPairingCode('');
                showAuth();
            }
        }

        function fmtTokens(n) {
            if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
            if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
            return n;
        }

        function fmtBytes(n) {
            n = n || 0;
            if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
            if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MB';
            if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
            return n + ' B';
        }

        function fmtRate(bytesPerSec) {
            if (!bytesPerSec || bytesPerSec < 1) return '0 KB/s';
            return fmtBytes(bytesPerSec) + '/s';
        }

        function transportBadge(t) {
            if (t === 'cloudflare') return '<span class="px-2 py-0.5 text-xs font-semibold rounded bg-orange-950/30 text-orange-400">cloudflare</span>';
            if (t === 'bore') return '<span class="px-2 py-0.5 text-xs font-semibold rounded bg-sky-950/30 text-sky-400">bore</span>';
            return '<span class="text-zinc-600 text-xs">—</span>';
        }

        function formatExpiry(expiryStr) {
            const ms = new Date(expiryStr).getTime() - Date.now();
            if (ms <= 0) return 'Expired';
            if (ms > 50 * 365 * 24 * 60 * 60 * 1000) return 'Unlimited';
            const h = Math.floor(ms / 3600000);
            const m = Math.floor((ms % 3600000) / 60000);
            const s = Math.floor((ms % 60000) / 1000);
            return h + 'h ' + m + 'm ' + s + 's';
        }

        function calcCost(inp, out, cr, cw) {
            return ((inp * 3 + out * 15 + cr * 0.3 + cw * 3.75) / 1000000).toFixed(2);
        }

        function escapeHtml(str) {
            if (!str) return '';
            return str.toString()
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }

        let statsInterval = null;
        window.machinesMap = {};

        async function loadLogs() {
            try {
                const machineId = el('log-filter-device').value;
                const url = '/api/dashboard/logs' + (machineId ? '?machineId=' + machineId : '');
                const data = await apiCall(url);
                
                const logsContainer = el('logs-container');
                logsContainer.innerHTML = '';
                if (data.logs.length === 0) {
                    logsContainer.innerHTML = '<span class="text-zinc-600 italic">No request logs recorded yet.</span>';
                    return;
                }
                
                data.logs.forEach(l => {
                    const time = new Date(l.ts).toLocaleTimeString();
                    const machineName = l.machineId ? (window.machinesMap[l.machineId] || l.machineId.slice(0, 8)) : 'System';
                    
                    let statusBadge = '<span class="text-zinc-500">pending...</span>';
                    if (l.status !== null) {
                        const isError = l.status >= 400;
                        const colorClass = isError ? 'text-red-400' : 'text-green-400';
                        statusBadge = '<span class="' + colorClass + '">' + l.status + '</span>';
                        if (l.errorLogFile) {
                            statusBadge += ' <button onclick="viewErrorDetails(' + "'" + l.errorLogFile + "'" + ')" class="px-1.5 py-0.5 rounded text-[10px] font-semibold text-red-400 bg-red-950/20 border border-red-900/30 hover:bg-red-950/40 transition">Details</button>';
                        }
                    }
                    
                    const outcomeColor = l.outcome === 'allowed' ? 'text-cyan-500' : 'text-red-500';
                    const pathText = l.path;
                    
                    const logLine = document.createElement('div');
                    logLine.className = 'flex flex-wrap items-center gap-x-2 text-zinc-300 py-0.5 border-b border-zinc-900/30';
                    logLine.innerHTML = '<span class="text-zinc-500 font-normal">' + time + '</span>' +
                        '<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-zinc-900 text-zinc-400 border border-zinc-800">' + escapeHtml(machineName) + '</span>' +
                        '<span class="font-semibold text-zinc-200">' + l.method + '</span>' +
                        '<span class="text-zinc-400 flex-1 truncate select-all">' + escapeHtml(pathText) + '</span>' +
                        '<span class="text-[10px] uppercase font-semibold ' + outcomeColor + '">' + l.outcome + '</span>' +
                        '<span>·</span>' +
                        statusBadge;
                    logsContainer.appendChild(logLine);
                });
            } catch (err) {
                console.error(err);
            }
        }

        async function loadErrorLogsList() {
            try {
                const data = await apiCall('/api/dashboard/error-logs');
                const container = el('error-logs-list-container');
                container.innerHTML = '';

                if (data.logs.length === 0) {
                    container.innerHTML = '<span class="text-zinc-600 italic">No API errors recorded yet.</span>';
                    return;
                }

                data.logs.forEach(log => {
                    const time = new Date(log.createdAt).toLocaleString();
                    const sizeKB = (log.size / 1024).toFixed(1) + ' KB';
                    const statusMatch = /^api-error-(\d+)-/.exec(log.filename);
                    const statusText = statusMatch ? 'HTTP ' + statusMatch[1] : 'API Error';

                    const div = document.createElement('div');
                    div.className = 'flex items-center justify-between p-2.5 bg-zinc-900 border border-zinc-800 rounded-lg hover:border-zinc-700 transition';
                    div.innerHTML = '<div class="flex flex-col">' +
                        '<span class="font-semibold text-red-400">' + statusText + '</span>' +
                        '<span class="text-zinc-500 text-[10px]">' + time + ' (' + sizeKB + ')</span>' +
                        '</div>' +
                        '<button onclick="viewErrorDetails(' + "'" + log.filename + "'" + ')" class="px-2.5 py-1 text-xs font-semibold text-cyan-400 bg-cyan-950/20 border border-cyan-900/30 hover:bg-cyan-950/50 rounded transition">View Details</button>';
                    container.appendChild(div);
                });
            } catch (err) {
                console.error(err);
            }
        }

        async function viewErrorDetails(filename) {
            try {
                const content = await apiCall('/api/dashboard/error-logs/' + filename, 'GET', null, true);
                el('error-modal-content').innerText = content;
                el('error-modal').classList.remove('hidden');
            } catch (err) {
                alert('Failed to load error log: ' + err.message);
            }
        }

        function closeErrorModal() {
            el('error-modal').classList.add('hidden');
        }

        async function loadStats() {
            try {
                const data = await apiCall('/api/dashboard/stats');
                
                // Render system info
                el('system-name').innerText = data.systemName;
                el('port-badge').innerText = ':' + data.localPort;
                el('remaining-time').innerText = formatExpiry(data.sharedUntil);
                
                // Render pairing link
                const bestUrl = data.publicUrl || data.lanUrl || 'http://localhost:' + data.localPort;
                const connectUrl = 'claudeshare://' + bestUrl.replace('https://', '').replace('http://', '') + '/connect/' + data.pairingCode;
                el('pairing-link-text').value = connectUrl;
                el('pairing-code-text').value = data.pairingCode;
                el('connect-cmd-text').value = 'claude-connect --share "' + connectUrl + '"';

                // Render Cloudflare (share.rocl.one) link when a tunnel hostname is configured
                const cfRow = el('cf-link-row');
                if (cfRow) {
                    if (data.cloudflareHost) {
                        el('cf-link-text').value = 'claudeshare://' + data.cloudflareHost + '/connect/' + data.pairingCode + '?cf=1';
                        cfRow.style.display = '';
                    } else {
                        cfRow.style.display = 'none';
                    }
                }
                
                // Render token stats
                const ts = data.totalStats;
                el('total-cost').innerText = '$' + calcCost(ts.inputTokens, ts.outputTokens, ts.cacheReadTokens, ts.cacheWriteTokens);
                el('stat-input').innerText = fmtTokens(ts.inputTokens);
                el('stat-output').innerText = fmtTokens(ts.outputTokens);
                el('stat-cache-read').innerText = fmtTokens(ts.cacheReadTokens);
                el('stat-cache-write').innerText = fmtTokens(ts.cacheWriteTokens);
                el('stat-requests').innerText = ts.requests;
                
                // Render tunnel status
                const tunnelStatusEl = el('tunnel-status');
                if (data.publicUrl) {
                    tunnelStatusEl.innerText = 'Internet (active)';
                    tunnelStatusEl.className = 'text-green-400 font-semibold';
                } else {
                    tunnelStatusEl.innerText = 'LAN/Local only';
                    tunnelStatusEl.className = 'text-yellow-400 font-semibold';
                }

                // Update machines map
                window.machinesMap = {};
                const filterSelect = el('log-filter-device');
                const selectedVal = filterSelect.value;
                filterSelect.innerHTML = '<option value="">All Devices</option>';

                // Render machines
                const mBody = el('machines-tbody');
                mBody.innerHTML = '';
                if (data.machines.length === 0) {
                    mBody.innerHTML = '<tr><td colspan="7" class="py-6 text-center text-zinc-500">No connected devices yet.</td></tr>';
                } else {
                    data.machines.forEach(m => {
                        window.machinesMap[m.id] = m.name;
                        
                        // Populate filter dropdown
                        const opt = document.createElement('option');
                        opt.value = m.id;
                        opt.innerText = m.name;
                        filterSelect.appendChild(opt);

                        const active = m.sessions.some(s => s.active);
                        const cost = calcCost(m.stats.inputTokens, m.stats.outputTokens, m.stats.cacheReadTokens, m.stats.cacheWriteTokens);

                        // Live up/down speed = delta of cumulative bytes since the
                        // previous poll (~3s), divided by the elapsed time.
                        const now = Date.now();
                        window.prevBytes = window.prevBytes || {};
                        const pb = window.prevBytes[m.id];
                        let upSpd = 0, downSpd = 0;
                        if (pb) {
                            const dt = (now - pb.t) / 1000;
                            if (dt > 0) {
                                upSpd = Math.max(0, ((m.bytesUp || 0) - pb.up) / dt);
                                downSpd = Math.max(0, ((m.bytesDown || 0) - pb.down) / dt);
                            }
                        }
                        window.prevBytes[m.id] = { up: m.bytesUp || 0, down: m.bytesDown || 0, t: now };

                        const tr = document.createElement('tr');
                        tr.className = 'border-b border-zinc-800 hover:bg-zinc-900/30 transition';
                        const statusColor = active ? 'bg-green-500 animate-pulse' : 'bg-yellow-500';
                        tr.innerHTML = '<td class="py-3 px-4 font-semibold flex items-center gap-2">' +
                            '<span class="w-2 h-2 rounded-full ' + statusColor + '"></span>' +
                            escapeHtml(m.name) +
                            '</td>' +
                            '<td class="py-3 px-4 text-zinc-400 text-sm font-mono"> ' + m.id.slice(0, 8) + '</td>' +
                            '<td class="py-3 px-4 text-zinc-400 text-sm">' +
                            fmtTokens(m.stats.inputTokens) + ' in · ' + fmtTokens(m.stats.outputTokens) + ' out<br/>' +
                            '<span class="text-zinc-500 text-xs">' + fmtTokens(m.stats.cacheReadTokens) + ' cr · ' + fmtTokens(m.stats.cacheWriteTokens) + ' cw</span>' +
                            '</td>' +
                            '<td class="py-3 px-4 text-sm">' +
                            '<span class="font-semibold">$' + cost + '</span><br/>' +
                            '<span class="text-zinc-500 text-xs">' + m.stats.requests + ' req</span>' +
                            '</td>' +
                            '<td class="py-3 px-4 text-sm whitespace-nowrap">' +
                            '<span class="text-cyan-400">&uarr; ' + fmtBytes(m.bytesUp || 0) + '</span> · <span class="text-emerald-400">&darr; ' + fmtBytes(m.bytesDown || 0) + '</span><br/>' +
                            '<span class="text-zinc-500 text-xs">' + fmtRate(upSpd) + ' &uarr; · ' + fmtRate(downSpd) + ' &darr;</span>' +
                            '</td>' +
                            '<td class="py-3 px-4 text-sm whitespace-nowrap">' +
                            transportBadge(m.transport) +
                            '</td>' +
                            '<td class="py-3 px-4 text-right">' +
                            '<button onclick="revokeMachine(' + "'" + m.id + "'" + ')" class="px-2.5 py-1 text-xs font-semibold text-red-400 border border-red-950/30 bg-red-950/10 hover:bg-red-950/30 hover:text-red-300 rounded transition">Revoke</button>' +
                            '</td>';
                        mBody.appendChild(tr);
                    });
                }
                filterSelect.value = selectedVal;
                
                // Fetch logs as well
                await loadLogs();
                // Fetch error logs list
                await loadErrorLogsList();
                // Refresh usage at most every 12s (reads the full usage ledger)
                if (Date.now() - lastUsageLoad > 12000) {
                    lastUsageLoad = Date.now();
                    loadUsage();
                }
            } catch (err) {
                console.error(err);
                throw err;
            }
        }

        let lastUsageLoad = 0;

        function showTab(name) {
            ['dashboard', 'errors', 'sessions', 'dev'].forEach(t => {
                el('tab-' + t).classList.toggle('hidden', t !== name);
            });
            document.querySelectorAll('.tab-btn').forEach(b => {
                const active = b.getAttribute('data-tab') === name;
                b.classList.toggle('border-cyan-500', active);
                b.classList.toggle('text-cyan-400', active);
                b.classList.toggle('border-transparent', !active);
                b.classList.toggle('text-zinc-400', !active);
            });
            if (name === 'errors') loadErrorLogsList();
            else if (name === 'sessions') loadStateFiles();
            else if (name === 'dev') loadFlows();
            else if (name === 'dashboard') { lastUsageLoad = Date.now(); loadUsage(); }
        }

        let recOn = false;
        function renderRecState(state) {
            recOn = !!state.recording;
            const badge = el('rec-state');
            const btn = el('rec-toggle');
            badge.innerText = recOn ? 'REC' : 'OFF';
            badge.className = 'px-2 py-0.5 text-[10px] font-bold rounded-md ' +
                (recOn ? 'bg-red-950/30 text-red-400 border border-red-900/40 animate-pulse' : 'bg-zinc-800 text-zinc-400');
            btn.innerText = recOn ? 'Stop recording' : 'Start recording';
            el('rec-include-messages').checked = !!state.includeMessages;
        }

        async function toggleRecording() {
            try {
                const res = await apiCall('/api/dashboard/dev/recording', 'POST', { on: !recOn });
                renderRecState(res);
            } catch (err) { alert(err.message); }
        }

        async function toggleIncludeMessages() {
            try {
                const res = await apiCall('/api/dashboard/dev/recording', 'POST', { includeMessages: el('rec-include-messages').checked });
                renderRecState(res);
            } catch (err) { alert(err.message); }
        }

        async function loadFlows() {
            try {
                const data = await apiCall('/api/dashboard/dev/flows');
                renderRecState(data);
                const c = el('flows-container');
                c.innerHTML = '';
                if (!data.flows.length) {
                    c.innerHTML = '<span class="text-zinc-600 italic">No recorded flows yet. Start recording, then use Claude through the share.</span>';
                    return;
                }
                data.flows.forEach(f => {
                    const isErr = f.status >= 400;
                    const div = document.createElement('div');
                    div.className = 'flex items-center justify-between p-2.5 bg-zinc-900 border border-zinc-800 rounded-lg';
                    const title = (f.model ? escapeHtml(f.model) + ' · ' : '') + escapeHtml(f.method) + ' ' + escapeHtml(f.path);
                    div.innerHTML = '<div class="flex flex-col min-w-0">' +
                        '<span class="font-semibold text-zinc-200 truncate">' + title + '</span>' +
                        '<span class="text-zinc-500 text-[10px]">' + new Date(f.ts).toLocaleString() + ' · ' + (f.size / 1024).toFixed(1) + ' KB · <span class="' + (isErr ? 'text-red-400' : 'text-green-400') + '">HTTP ' + f.status + '</span></span>' +
                        '</div>' +
                        '<button onclick="viewFlow(' + "'" + f.file + "'" + ')" class="px-2.5 py-1 text-xs font-semibold text-cyan-400 bg-cyan-950/20 border border-cyan-900/30 hover:bg-cyan-950/50 rounded transition shrink-0">Inspect</button>';
                    c.appendChild(div);
                });
            } catch (err) { console.error(err); }
        }

        function prettyJson(s) {
            try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
        }

        async function viewFlow(file) {
            try {
                const data = await apiCall('/api/dashboard/dev/flow?file=' + encodeURIComponent(file));
                const f = data.flow;
                el('flow-title').innerText = (f.model ? f.model + ' · ' : '') + f.method + ' ' + f.path;
                el('flow-req').innerText = prettyJson(f.reqBody);
                el('flow-res').innerText = prettyJson(f.resBody);
                el('flow-replay-result').classList.add('hidden');
                el('flow-replay-btn').onclick = () => replayFlow(file);
                el('flow-viewer').classList.remove('hidden');
            } catch (err) { alert('Failed to load flow: ' + err.message); }
        }

        async function replayFlow(file) {
            const btn = el('flow-replay-btn');
            const orig = btn.innerText;
            btn.innerText = 'Replaying...';
            btn.disabled = true;
            try {
                const res = await apiCall('/api/dashboard/dev/replay', 'POST', { file });
                el('flow-replay-result').classList.remove('hidden');
                if (res.error) {
                    el('flow-replay-status').innerText = '(error)';
                    el('flow-replay-body').innerText = res.error;
                } else {
                    el('flow-replay-status').innerText = 'HTTP ' + res.status;
                    el('flow-replay-body').innerText = prettyJson(res.body);
                }
            } catch (err) {
                alert('Replay failed: ' + err.message);
            } finally {
                btn.innerText = orig;
                btn.disabled = false;
            }
        }

        const USAGE_LABELS = {
            five_hour: 'Current session',
            seven_day: 'Current week (all models)',
            seven_day_opus: 'Current week (Opus)',
            seven_day_sonnet: 'Current week (Sonnet)',
        };
        function usageLabel(key) {
            if (USAGE_LABELS[key]) return USAGE_LABELS[key];
            if (/fable/i.test(key)) return 'Current week (Fable)';
            if (/mythos/i.test(key)) return 'Current week (Mythos)';
            return key;
        }
        function usageRank(key) {
            if (key === 'five_hour') return 0;
            if (key === 'seven_day') return 1;
            if (/fable/i.test(key)) return 2;
            return 3;
        }

        async function loadLiveUsage() {
            const container = el('live-usage-container');
            try {
                const data = await apiCall('/api/dashboard/live-usage');
                if (data.error) {
                    container.innerHTML = '<span class="text-amber-400/80 italic">Live usage unavailable: ' + escapeHtml(data.error) + '</span>';
                    return;
                }
                const usage = data.usage || {};
                const entries = Object.entries(usage).filter(([, v]) =>
                    v && typeof v === 'object' && ('utilization' in v || 'percent' in v)
                );
                if (!entries.length) {
                    container.innerHTML = '<span class="text-zinc-600 italic">No usage data returned.</span>';
                    return;
                }
                entries.sort((a, b) => usageRank(a[0]) - usageRank(b[0]));
                container.innerHTML = entries.map(([key, v]) => {
                    let raw = (v.utilization !== undefined ? v.utilization : v.percent) || 0;
                    const pct = raw <= 1 ? Math.round(raw * 100) : Math.round(raw);
                    const reset = v.resets_at ? 'Resets ' + new Date(v.resets_at).toLocaleString() : '';
                    const barColor = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-cyan-600';
                    return '<div>' +
                        '<div class="flex justify-between mb-1"><span class="font-semibold text-zinc-200">' + escapeHtml(usageLabel(key)) + '</span>' +
                        '<span class="text-zinc-300 font-mono">' + pct + '% used</span></div>' +
                        '<div class="bg-zinc-900 rounded h-3 overflow-hidden"><div class="' + barColor + ' h-3" style="width:' + Math.min(100, pct) + '%"></div></div>' +
                        (reset ? '<span class="text-zinc-500 text-[10px]">' + escapeHtml(reset) + '</span>' : '') +
                        '</div>';
                }).join('');
            } catch (err) {
                container.innerHTML = '<span class="text-zinc-600 italic">Failed to load live usage.</span>';
            }
        }

        let lastLiveUsageLoad = 0;
        async function loadUsage() {
            // Live plan usage hits Anthropic (rate-limited) — refresh at most
            // every 5 minutes; the server also caches it for the same window.
            if (Date.now() - lastLiveUsageLoad > 300000) {
                lastLiveUsageLoad = Date.now();
                loadLiveUsage();
            }
            try {
                const data = await apiCall('/api/dashboard/usage');
                const mc = el('usage-models-container');
                mc.innerHTML = data.byModel.map(m =>
                    '<div class="flex flex-col gap-0.5 pb-2 border-b border-zinc-800/50">' +
                        '<span class="font-semibold text-zinc-200 truncate">' + escapeHtml(m.model) + '</span>' +
                        '<span class="text-zinc-400 font-mono">' + fmtTokens(m.input) + ' in · ' + fmtTokens(m.output) + ' out · ' + m.requests + ' req</span>' +
                    '</div>'
                ).join('') || '<span class="text-zinc-600 italic">No token usage recorded yet.</span>';
            } catch (err) {
                console.error(err);
            }
        }

        async function loadStateFiles() {
            try {
                const data = await apiCall('/api/dashboard/state-files');
                const c = el('state-files-container');
                c.innerHTML = '';
                if (!data.files.length) {
                    c.innerHTML = '<span class="text-zinc-600 italic">No state files.</span>';
                    return;
                }
                data.files.forEach(f => {
                    const div = document.createElement('div');
                    div.className = 'flex items-center justify-between p-2.5 bg-zinc-900 border border-zinc-800 rounded-lg';
                    div.innerHTML = '<div class="flex flex-col">' +
                        '<span class="font-semibold text-zinc-200 font-mono">' + escapeHtml(f.name) + '</span>' +
                        '<span class="text-zinc-500 text-[10px]">' + new Date(f.modifiedAt).toLocaleString() + ' · ' + (f.size / 1024).toFixed(1) + ' KB</span>' +
                        '</div>' +
                        '<button onclick="viewStateFile(' + "'" + f.name + "'" + ')" class="px-2.5 py-1 text-xs font-semibold text-cyan-400 bg-cyan-950/20 border border-cyan-900/30 hover:bg-cyan-950/50 rounded transition">View</button>';
                    c.appendChild(div);
                });
            } catch (err) {
                console.error(err);
            }
        }

        async function viewStateFile(name) {
            try {
                const data = await apiCall('/api/dashboard/state-file?name=' + encodeURIComponent(name));
                el('state-file-name').innerText = data.name;
                el('state-file-content').innerText = JSON.stringify(data.content, null, 2);
                el('state-file-viewer').classList.remove('hidden');
            } catch (err) {
                alert('Failed to load file: ' + err.message);
            }
        }

        async function revokeMachine(id) {
            if (!confirm('Are you sure you want to revoke access for this device?')) return;
            try {
                await apiCall('/api/dashboard/revoke', 'POST', { machineId: id });
                loadStats();
            } catch (err) {
                alert(err.message);
            }
        }

        async function handleRegenerate() {
            if (!confirm('Are you sure you want to regenerate the pairing code? The current code will be invalidated.')) return;
            try {
                const res = await apiCall('/api/dashboard/regenerate', 'POST');
                setPairingCode(res.pairingCode);
                loadStats();
            } catch (err) {
                alert(err.message);
            }
        }

        async function handleSetUnlimited() {
            if (!confirm('Set this share to unlimited time? It will no longer expire until you stop it.')) return;
            try {
                const res = await apiCall('/api/dashboard/set-unlimited', 'POST');
                el('remaining-time').innerText = formatExpiry(res.sharedUntil);
                loadStats();
            } catch (err) {
                alert(err.message);
            }
        }

        function copyVal(id) {
            const copyText = el(id);
            copyText.select();
            copyText.setSelectionRange(0, 99999);
            navigator.clipboard.writeText(copyText.value);
            
            // Show visual feedback
            const btn = copyText.nextElementSibling;
            const orig = btn.innerText;
            btn.innerText = 'Copied!';
            btn.className = btn.className.replace('text-cyan-400', 'text-green-400');
            setTimeout(() => {
                btn.innerText = orig;
                btn.className = btn.className.replace('text-green-400', 'text-cyan-400');
            }, 2000);
        }

        // Initial flow
        window.addEventListener('load', () => {
            el('login-form').addEventListener('submit', handleLogin);
            el('regen-btn').addEventListener('click', handleRegenerate);
            el('unlimited-btn').addEventListener('click', handleSetUnlimited);
            
            if (getPairingCode()) {
                showDashboard();
                showTab('dashboard');
                loadStats();
            } else {
                showAuth();
            }
        });
    </script>
</body>
</html>`,
    );
  });

  const failedLogins = new Map<string, { count: number; blockedUntil: number }>();
  let globalBlockTime = 0;
  let globalFailCount = 0;
  let globalResetTime = 0;

  // Helper middleware to check dashboard authorization (via pairing code)
  const dashboardAuth = async (c: any, next: () => Promise<void>) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const now = Date.now();

    const session = getSession();
    if (!session || isSessionExpired(session)) {
      return c.text("Session expired", 401);
    }

    const code = c.req.header("x-pairing-code");
    const adminPass = process.env.DASHBOARD_PASSWORD;
    const isValid = (code && code === session.pairingCode) || (adminPass && code === adminPass);

    // Validate the code FIRST. A correct code must ALWAYS pass, even during a
    // block — otherwise an induced block (all tunnel traffic shares the single
    // "unknown" bucket since bore sets no x-forwarded-for, so 5 wrong codes is
    // enough) would lock the legitimate owner out of their own dashboard.
    if (isValid) {
      failedLogins.delete(ip);
      return next();
    }

    // Invalid code: now enforce existing blocks, then record this failure.
    if (globalBlockTime > now) {
      const remainingSecs = Math.ceil((globalBlockTime - now) / 1000);
      return c.text(`Too many failed attempts globally. Blocked for another ${remainingSecs} seconds.`, 429);
    }
    const record = failedLogins.get(ip);
    if (record && record.blockedUntil > now) {
      const remainingSecs = Math.ceil((record.blockedUntil - now) / 1000);
      return c.text(`Too many failed attempts. Blocked for another ${remainingSecs} seconds.`, 429);
    }

    // 1. Record IP failure. `ip` comes from the client-supplied x-forwarded-for
    // (bore delivers "unknown"); a spoofed rotating XFF would otherwise grow this
    // Map without bound. Evict expired entries, and hard-cap as a backstop.
    if (failedLogins.size > 1000) {
      for (const [k, v] of failedLogins) {
        if (v.blockedUntil <= now && v.count === 0) failedLogins.delete(k);
      }
      let over = failedLogins.size - 1000;
      for (const k of failedLogins.keys()) {
        if (over-- <= 0) break;
        failedLogins.delete(k);
      }
    }
    const current = failedLogins.get(ip) ?? { count: 0, blockedUntil: 0 };
    current.count += 1;
    if (current.count >= 5) {
      current.blockedUntil = now + 15 * 60 * 1000; // 15 mins block
      current.count = 0;
    }
    failedLogins.set(ip, current);

    // 2. Record Global failure
    if (globalResetTime < now) {
      globalFailCount = 0;
      globalResetTime = now + 5 * 60 * 1000; // 5 mins reset window
    }
    globalFailCount += 1;
    if (globalFailCount >= 15) {
      globalBlockTime = now + 15 * 60 * 1000; // 15 mins global block
      globalFailCount = 0;
    }

    return c.text("Unauthorized", 401);
  };

  /** GET /api/dashboard/stats — returns data for the web UI */
  app.get("/api/dashboard/stats", dashboardAuth, (c) => {
    const session = getSession()!;
    const localPort = urls.lan ? parseInt(new URL(urls.lan).port || "25866", 10) : 25866;

    const machines = [...session.machines.values()].map((m) => {
      const stats = getMachineStats(m.id);
      const bytes = getMachineBytes(m.id);
      return {
        id: m.id,
        name: m.name,
        pairedAt: m.pairedAt.toISOString(),
        stats,
        bytesUp: bytes.up,
        bytesDown: bytes.down,
        transport: m.transport ?? null,
        sessions: [...m.sessions.values()].map((s) => ({
          id: s.id,
          startedAt: s.startedAt.toISOString(),
          lastActiveAt: s.lastActiveAt.toISOString(),
          active: s.active,
        })),
      };
    });

    const totalStats = getTotalStats();

    return c.json({
      systemName,
      publicUrl: urls.public,
      lanUrl: urls.lan,
      cloudflareHost: process.env.CLOUDFLARE_TUNNEL_HOSTNAME?.trim() || null,
      localPort,
      pairingCode: session.pairingCode,
      sharedUntil: session.sharedUntil.toISOString(),
      totalStats,
      totalBytes: getTotalBytes(),
      machines,
    });
  });

  /** GET /api/dashboard/logs — returns recent request logs */
  app.get("/api/dashboard/logs", dashboardAuth, (c) => {
    const machineId = c.req.query("machineId");
    let logs = getEntries();
    if (machineId) {
      logs = logs.filter((l) => l.machineId === machineId);
    }
    return c.json({ logs });
  });

  /** GET /api/dashboard/error-logs — list recent API error logs (any status) */
  // Cached: the dashboard polls this every ~3s and the handler does a
  // readdir + statSync-per-file (up to ~300) synchronously on the same event
  // loop that proxies all Claude traffic. Unlike /usage this had no cache — an
  // 8s cache cuts the scan to a trickle without noticeably staling the list.
  let errorLogsCache: { at: number; payload: unknown } | null = null;
  app.get("/api/dashboard/error-logs", dashboardAuth, (c) => {
    if (errorLogsCache && Date.now() - errorLogsCache.at < 8_000) {
      return c.json(errorLogsCache.payload as object);
    }
    const logDir = path.join(os.homedir(), ".claude-share", "logs");
    try {
      if (!fs.existsSync(logDir)) return c.json({ logs: [] });
      const files = fs.readdirSync(logDir)
        .filter((f) => f.startsWith("api-error-") && f.endsWith(".log"))
        .map((f) => {
          const stats = fs.statSync(path.join(logDir, f));
          return {
            filename: f,
            createdAt: stats.mtime.toISOString(),
            size: stats.size,
          };
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const payload = { logs: files };
      errorLogsCache = { at: Date.now(), payload };
      return c.json(payload);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  /** GET /api/dashboard/error-logs/:filename — read specific API error log */
  app.get("/api/dashboard/error-logs/:filename", dashboardAuth, (c) => {
    const filename = c.req.param("filename");
    if (!filename.startsWith("api-error-") || !filename.endsWith(".log") || filename.includes("..") || filename.includes("/")) {
      return c.text("Invalid filename", 400);
    }
    const logPath = path.join(os.homedir(), ".claude-share", "logs", filename);
    try {
      if (!fs.existsSync(logPath)) return c.text("File not found", 404);
      const content = fs.readFileSync(logPath, "utf8");
      return c.text(content);
    } catch (err) {
      return c.text(String(err), 500);
    }
  });

  /** POST /api/dashboard/regenerate — regenerates pairing code via web UI */
  app.post("/api/dashboard/regenerate", dashboardAuth, (c) => {
    const session = getSession()!;
    regeneratePairingCode(session);
    saveSession(session);
    return c.json({ ok: true, pairingCode: session.pairingCode });
  });

  /** POST /api/dashboard/set-unlimited — switch the active share to unlimited time */
  app.post("/api/dashboard/set-unlimited", dashboardAuth, (c) => {
    const session = setSessionUnlimited();
    if (!session) return c.text("No active session", 404);
    return c.json({ ok: true, sharedUntil: session.sharedUntil.toISOString() });
  });

  /** GET /api/dashboard/usage — token volume per model seen through the proxy */
  // Cache the aggregate: readUsageEvents() does a synchronous read of the whole
  // ledger, and the dashboard polls this on a timer — recomputing every call
  // blocks the event loop on a long-running share. 60s freshness is plenty.
  let usageAggCache: { at: number; payload: unknown } | null = null;
  app.get("/api/dashboard/usage", dashboardAuth, (c) => {
    if (usageAggCache && Date.now() - usageAggCache.at < 60_000) {
      return c.json(usageAggCache.payload as object);
    }
    const events = readUsageEvents();
    const payload = { byModel: byModel(events), totalEvents: events.length };
    usageAggCache = { at: Date.now(), payload };
    return c.json(payload);
  });

  /**
   * GET /api/dashboard/live-usage — the sharer's real plan utilization, i.e. the
   * same data Claude Code's own `/usage` shows (session 5h, weekly, per-model
   * incl. Fable). Fetched live from Anthropic with the sharer's token.
   */
  // /api/oauth/usage is rate-limited (429 if hit too often), so cache the
  // result for 5 minutes. Every dashboard poll reads this cache; Anthropic is
  // called at most once per window. On error we serve the last good value.
  let usageCache: { at: number; payload: { usage: unknown } } | null = null;
  const USAGE_TTL = 5 * 60 * 1000;

  app.get("/api/dashboard/live-usage", dashboardAuth, async (c) => {
    if (usageCache && Date.now() - usageCache.at < USAGE_TTL) {
      return c.json({ ...usageCache.payload, cachedAgeMs: Date.now() - usageCache.at });
    }
    try {
      const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: {
          authorization: `Bearer ${await getFreshAccessToken()}`,
          "anthropic-beta": "oauth-2025-04-20",
          "anthropic-version": "2023-06-01",
        },
      });
      if (!res.ok) {
        if (usageCache) return c.json({ ...usageCache.payload, stale: true });
        return c.json({ error: `Anthropic returned HTTP ${res.status}` });
      }
      usageCache = { at: Date.now(), payload: { usage: await res.json() } };
      return c.json(usageCache.payload);
    } catch (err) {
      if (usageCache) return c.json({ ...usageCache.payload, stale: true });
      return c.json({ error: String(err) });
    }
  });

  // ── Dev recorder / replay ──────────────────────────────────────────────────

  /** GET /api/dashboard/dev/recording — current recorder state */
  app.get("/api/dashboard/dev/recording", dashboardAuth, (c) =>
    c.json({ recording: isRecording(), includeMessages: isIncludingMessages() }),
  );

  /** POST /api/dashboard/dev/recording {on, includeMessages} — toggle recorder */
  app.post("/api/dashboard/dev/recording", dashboardAuth, async (c) => {
    const body = await c.req.json<{ on?: boolean; includeMessages?: boolean }>();
    if (typeof body.on === "boolean") setRecording(body.on);
    if (typeof body.includeMessages === "boolean") setIncludeMessages(body.includeMessages);
    return c.json({ recording: isRecording(), includeMessages: isIncludingMessages() });
  });

  /** GET /api/dashboard/dev/flows — list recorded request/response flows */
  app.get("/api/dashboard/dev/flows", dashboardAuth, (c) =>
    c.json({
      recording: isRecording(),
      includeMessages: isIncludingMessages(),
      flows: listFlows(),
    }),
  );

  /** GET /api/dashboard/dev/flow?file=... — full recorded flow */
  app.get("/api/dashboard/dev/flow", dashboardAuth, (c) => {
    const flow = readFlow(c.req.query("file") ?? "");
    if (!flow) return c.text("Not found", 404);
    return c.json({ flow });
  });

  /**
   * POST /api/dashboard/dev/replay {file} — re-send a recorded request to
   * Anthropic with the sharer's token and return the fresh response. Lets you
   * reproduce a bug against the exact captured request body later.
   */
  app.post("/api/dashboard/dev/replay", dashboardAuth, async (c) => {
    const { file } = await c.req.json<{ file?: string }>();
    const flow = readFlow(file ?? "");
    if (!flow) return c.text("Not found", 404);
    // Defense-in-depth: flow.path is receiver-influenced. It's only recorded for
    // allow-listed api.anthropic.com paths (all "/"-prefixed) so host-confusion
    // SSRF (…api.anthropic.com@evil.com) is unreachable today — but validate here
    // too so loosening the recorder later can't reintroduce token-exfil.
    if (!/^\/[^/]/.test(flow.path)) {
      return c.text("Invalid recorded path", 400);
    }
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${await getFreshAccessToken()}`,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      };
      if (flow.beta) headers["anthropic-beta"] = flow.beta;
      const res = await fetch("https://api.anthropic.com" + flow.path, {
        method: flow.method,
        headers,
        body: flow.method === "POST" ? flow.reqBody : undefined,
      });
      const text = await res.text();
      return c.json({ status: res.status, body: text.slice(0, 40000) });
    } catch (err) {
      return c.json({ error: String(err) });
    }
  });

  /** GET /api/dashboard/state-files — list the ~/.claude-share JSON state files */
  app.get("/api/dashboard/state-files", dashboardAuth, (c) => {
    const baseDir = path.join(os.homedir(), ".claude-share");
    const files: Array<{ name: string; size: number; modifiedAt: string }> = [];
    const collect = (dir: string, prefix: string) => {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith(".json")) {
            const stat = fs.statSync(path.join(dir, entry.name));
            files.push({
              name: prefix + entry.name,
              size: stat.size,
              modifiedAt: stat.mtime.toISOString(),
            });
          } else if (entry.isDirectory() && entry.name === "connections") {
            collect(path.join(dir, entry.name), "connections/");
          }
        }
      } catch {}
    };
    collect(baseDir, "");
    files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    return c.json({ files });
  });

  /** GET /api/dashboard/state-file?name=... — read one state file with secrets redacted */
  app.get("/api/dashboard/state-file", dashboardAuth, (c) => {
    const name = c.req.query("name") ?? "";
    // Allow only "<file>.json" or "connections/<file>.json"; no traversal.
    if (!/^(connections\/)?[A-Za-z0-9._-]+\.json$/.test(name) || name.includes("..")) {
      return c.text("Invalid filename", 400);
    }
    const filePath = path.join(os.homedir(), ".claude-share", name);
    try {
      if (!fs.existsSync(filePath)) return c.text("File not found", 404);
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return c.json({ name, content: redactSecrets(parsed) });
    } catch (err) {
      return c.text(String(err), 500);
    }
  });

  /** POST /api/dashboard/revoke — revokes a client machine via web UI */
  app.post("/api/dashboard/revoke", dashboardAuth, async (c) => {
    const session = getSession()!;
    const { machineId } = await c.req.json<{ machineId: string }>();
    if (!machineId) return c.text("Missing machineId", 400);

    const ok = removeMachine(session, machineId);
    if (!ok) return c.text("Machine not found", 404);
    saveSession(session);
    return c.json({ ok: true });
  });

  return app;
}
