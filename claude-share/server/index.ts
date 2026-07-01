import { Hono } from "hono";
import { html } from "hono/html";

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
  type ConnectionFile,
  type SharerAccount,
} from "../session/manager";

import { getTotalStats, getMachineStats } from "../proxy/tokenCounter";
import { getEntries } from "../proxy/requestLog";

interface Urls {
  public: string | null;
  lan: string | null;
}

export function createApiApp(
  urls: Urls,
  caPem: string,
  sharerAccount: SharerAccount | null,
  systemName: string,
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
    return c.json({
      ok: true,
      sessionActive: !!session && !isSessionExpired(session),
      sessionId: session?.id ?? null,
    });
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

    const file: ConnectionFile = {
      publicServerUrl: urls.public,
      sessionId: session.id,
      sharedUntil: session.sharedUntil.toISOString(),
      caPem,
      sharerAccount,
      systemName,
      proxyUser: machine.id,
      proxyPass: machine.proxyPass,
    };

    const blob = encryptConnectionFile(session, file);
    return c.json({ blob, machineId: machine.id });
  });

  /** POST /session/start — receiver opened a Claude session */
  app.post("/session/start", async (c) => {
    const session = getSession();
    if (!session) return c.json({ error: "No active session" }, 503);
    const { machineId } = await c.req.json<{ machineId: string }>();
    const ms = addMachineSession(session, machineId);
    if (!ms) return c.json({ error: "Machine not found" }, 404);
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

        <main class="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6 space-y-6">
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
                    </div>
                </div>

                <!-- Session Time Card -->
                <div class="glass-panel p-5 rounded-2xl flex flex-col justify-between">
                    <div>
                        <h3 class="text-base font-semibold text-zinc-300 mb-1">Time Remaining</h3>
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

            <!-- API 400 Error History -->
            <div id="error-logs-section" class="hidden glass-panel rounded-2xl overflow-hidden border-l-red-500 border-l-2">
                <div class="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/10">
                    <div class="flex items-center gap-2">
                        <h3 class="text-base font-semibold text-zinc-200">API 400 Error History</h3>
                        <span class="px-2 py-0.5 text-[10px] font-bold bg-red-950/20 text-red-400 border border-red-900/30 rounded-md">Error Logger</span>
                    </div>
                    <button onclick="loadErrorLogsList()" class="text-xs text-cyan-400 font-semibold hover:text-cyan-300">Refresh</button>
                </div>
                <div class="p-4 bg-zinc-950/50 max-h-48 overflow-y-auto space-y-2 text-xs" id="error-logs-list-container">
                    <!-- List of 400 error logs -->
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

        function formatExpiry(expiryStr) {
            const ms = new Date(expiryStr).getTime() - Date.now();
            if (ms <= 0) return 'Expired';
            const h = Math.floor(ms / 3600000);
            const m = Math.floor((ms % 3600000) / 60000);
            const s = Math.floor((ms % 60000) / 1000);
            return \`\${h}h \${m}m \${s}s\`;
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
                    logsContainer.innerHTML = \`<span class="text-zinc-600 italic">No request logs recorded yet.</span>\`;
                    return;
                }
                
                data.logs.forEach(l => {
                    const time = new Date(l.ts).toLocaleTimeString();
                    const machineName = l.machineId ? (window.machinesMap[l.machineId] || l.machineId.slice(0, 8)) : 'System';
                    
                    let statusBadge = '<span class="text-zinc-500">pending...</span>';
                    if (l.status !== null) {
                        const isError = l.status >= 400;
                        const colorClass = isError ? 'text-red-400' : 'text-green-400';
                        statusBadge = \`<span class="\${colorClass}">\${l.status}</span>\`;
                        if (l.errorLogFile) {
                            statusBadge += \` <button onclick="viewErrorDetails('\${l.errorLogFile}')" class="px-1.5 py-0.5 rounded text-[10px] font-semibold text-red-400 bg-red-950/20 border border-red-900/30 hover:bg-red-950/40 transition">Details</button>\`;
                        }
                    }
                    
                    const outcomeColor = l.outcome === 'allowed' ? 'text-cyan-500' : 'text-red-500';
                    const pathText = l.path;
                    
                    const logLine = document.createElement('div');
                    logLine.className = 'flex flex-wrap items-center gap-x-2 text-zinc-300 py-0.5 border-b border-zinc-900/30';
                    logLine.innerHTML = \`
                        <span class="text-zinc-500 font-normal">\${time}</span>
                        <span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-zinc-900 text-zinc-400 border border-zinc-800">\${escapeHtml(machineName)}</span>
                        <span class="font-semibold text-zinc-200">\${l.method}</span>
                        <span class="text-zinc-400 flex-1 truncate select-all">\${escapeHtml(pathText)}</span>
                        <span class="text-[10px] uppercase font-semibold \${outcomeColor}">\${l.outcome}</span>
                        <span>·</span>
                        \${statusBadge}
                    \`;
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
                const section = el('error-logs-section');
                
                if (data.logs.length === 0) {
                    section.classList.add('hidden');
                    return;
                }
                
                section.classList.remove('hidden');
                container.innerHTML = '';
                
                data.logs.forEach(log => {
                    const time = new Date(log.createdAt).toLocaleString();
                    const sizeKB = (log.size / 1024).toFixed(1) + ' KB';
                    
                    const div = document.createElement('div');
                    div.className = 'flex items-center justify-between p-2.5 bg-zinc-900 border border-zinc-800 rounded-lg hover:border-zinc-700 transition';
                    div.innerHTML = \`
                        <div class="flex flex-col">
                            <span class="font-semibold text-red-400">Bad Request (400)</span>
                            <span class="text-zinc-500 text-[10px]">\${time} (\${sizeKB})</span>
                        </div>
                        <button onclick="viewErrorDetails('\${log.filename}')" class="px-2.5 py-1 text-xs font-semibold text-cyan-400 bg-cyan-950/20 border border-cyan-900/30 hover:bg-cyan-950/50 rounded transition">View Details</button>
                    \`;
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
                const connectUrl = 'claudeshare://' + bestUrl.replace(/^https?:\\/\\//, '') + '/connect/' + data.pairingCode;
                el('pairing-link-text').value = connectUrl;
                el('pairing-code-text').value = data.pairingCode;
                el('connect-cmd-text').value = \`claude-connect --share "\${connectUrl}"\`;
                
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
                    mBody.innerHTML = \`<tr><td colspan="5" class="py-6 text-center text-zinc-500">No connected devices yet.</td></tr>\`;
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
                        
                        const tr = document.createElement('tr');
                        tr.className = 'border-b border-zinc-800 hover:bg-zinc-900/30 transition';
                        tr.innerHTML = \`
                            <td class="py-3 px-4 font-semibold flex items-center gap-2">
                                <span class="w-2 h-2 rounded-full \${active ? 'bg-green-500 animate-pulse' : 'bg-yellow-500'}"></span>
                                \${escapeHtml(m.name)}
                            </td>
                            <td class="py-3 px-4 text-zinc-400 text-sm font-mono"> \${m.id.slice(0, 8)}</td>
                            <td class="py-3 px-4 text-zinc-400 text-sm">
                                \${fmtTokens(m.stats.inputTokens)} in · \${fmtTokens(m.stats.outputTokens)} out<br/>
                                <span class="text-zinc-500 text-xs">\${fmtTokens(m.stats.cacheReadTokens)} cr · \${fmtTokens(m.stats.cacheWriteTokens)} cw</span>
                            </td>
                            <td class="py-3 px-4 text-sm">
                                <span class="font-semibold">\$\${cost}</span><br/>
                                <span class="text-zinc-500 text-xs">\${m.stats.requests} req</span>
                            </td>
                            <td class="py-3 px-4 text-right">
                                <button onclick="revokeMachine('\${m.id}')" class="px-2.5 py-1 text-xs font-semibold text-red-400 border border-red-950/30 bg-red-950/10 hover:bg-red-950/30 hover:text-red-300 rounded transition">Revoke</button>
                            </td>
                        \`;
                        mBody.appendChild(tr);
                    });
                }
                filterSelect.value = selectedVal;
                
                // Fetch logs as well
                await loadLogs();
                // Fetch error logs list
                await loadErrorLogsList();
            } catch (err) {
                console.error(err);
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
            
            if (getPairingCode()) {
                showDashboard();
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

    // Check if globally blocked
    if (globalBlockTime > now) {
      const remainingSecs = Math.ceil((globalBlockTime - now) / 1000);
      return c.text(`Too many failed attempts globally. Blocked for another ${remainingSecs} seconds.`, 429);
    }

    // Check if IP blocked
    const record = failedLogins.get(ip);
    if (record && record.blockedUntil > now) {
      const remainingSecs = Math.ceil((record.blockedUntil - now) / 1000);
      return c.text(`Too many failed attempts. Blocked for another ${remainingSecs} seconds.`, 429);
    }

    const session = getSession();
    if (!session || isSessionExpired(session)) {
      return c.text("Session expired", 401);
    }

    const code = c.req.header("x-pairing-code");
    const adminPass = process.env.DASHBOARD_PASSWORD;
    const isValid = (code && code === session.pairingCode) || (adminPass && code === adminPass);

    if (!isValid) {
      // 1. Record IP failure
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
    }

    // Success - reset attempts
    failedLogins.delete(ip);
    return next();
  };

  /** GET /api/dashboard/stats — returns data for the web UI */
  app.get("/api/dashboard/stats", dashboardAuth, (c) => {
    const session = getSession()!;
    const localPort = urls.lan ? parseInt(new URL(urls.lan).port || "25866", 10) : 25866;

    const machines = [...session.machines.values()].map((m) => {
      const stats = getMachineStats(m.id);
      return {
        id: m.id,
        name: m.name,
        pairedAt: m.pairedAt.toISOString(),
        stats,
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
      localPort,
      pairingCode: session.pairingCode,
      sharedUntil: session.sharedUntil.toISOString(),
      totalStats,
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

  /** GET /api/dashboard/error-logs — list recent API 400 error logs */
  app.get("/api/dashboard/error-logs", dashboardAuth, (c) => {
    const logDir = path.join(os.homedir(), ".claude-share", "logs");
    try {
      if (!fs.existsSync(logDir)) return c.json({ logs: [] });
      const files = fs.readdirSync(logDir)
        .filter((f) => f.startsWith("api-error-400-") && f.endsWith(".log"))
        .map((f) => {
          const stats = fs.statSync(path.join(logDir, f));
          return {
            filename: f,
            createdAt: stats.mtime.toISOString(),
            size: stats.size,
          };
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return c.json({ logs: files });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  /** GET /api/dashboard/error-logs/:filename — read specific API 400 error log */
  app.get("/api/dashboard/error-logs/:filename", dashboardAuth, (c) => {
    const filename = c.req.param("filename");
    if (!filename.startsWith("api-error-400-") || !filename.endsWith(".log") || filename.includes("..") || filename.includes("/")) {
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
