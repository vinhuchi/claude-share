#!/usr/bin/env node
import "@shared/patch-console";
import { execFile } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import * as p from "@clack/prompts";
import { serve } from "@hono/node-server";
import { render } from "ink";
import React from "react";

import { platform } from "@shared/platforms";
import { checkForUpdate, forceUpgrade } from "@shared/checkVersion";
import { resetTerminalModes } from "@shared/terminal";
import { logger } from "./logger";
import pkg from "../package.json";

if (process.argv.includes("-v") || process.argv.includes("--version")) {
  process.stdout.write(pkg.version + "\n");
  process.exit(0);
}

// main() assigns this to its cleanup() once the tunnel/servers exist. The
// uncaught handlers below are registered at module load (before main runs), so
// without this hook they exit(1) WITHOUT tearing anything down — orphaning the
// non-detached bore child, which keeps the saved port registration and forces
// the restarted sharer onto a new public URL (receivers then see "offline").
let fatalCleanup: (() => void) | null = null;

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", err);
  try {
    fatalCleanup?.();
  } catch {}
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", reason);
  try {
    fatalCleanup?.();
  } catch {}
  process.exit(1);
});

// Exits with a clear error if the platform is unsupported
platform();

import { createPortDetector } from "./port/detector";
import { createMitmProxy } from "./proxy/mitm";
import { getEntries } from "./proxy/requestLog";
import { flushPendingSave } from "./proxy/tokenCounter";
import { initToken, stopTokenRefresh } from "./proxy/token";
import { createApiApp } from "./server/index";
import {
  createSession,
  loadSession,
  saveSession,
  destroySession,
  isSessionExpired,
  getSession,
  checkMachineAuth,
  UNLIMITED_DURATION_MS,
  isUnlimitedDate,
  type SharerAccount,
} from "./session/manager";
import { App } from "./tui/App";
import { isBoreInstalled, installBore, startTunnel } from "./tunnel/index";
import { verifyTokenOrExit } from "./proxy/verifyToken";

function readSharerAccount(): SharerAccount | null {
  try {
    const raw = fs.readFileSync(
      path.join(os.homedir(), ".claude.json"),
      "utf8",
    );
    const config = JSON.parse(raw) as Record<string, unknown>;
    const acct = config["oauthAccount"] as Record<string, string> | undefined;
    if (!acct) return null;
    return {
      emailAddress: acct["emailAddress"] ?? "",
      displayName: acct["displayName"] ?? "",
      organizationName: acct["organizationName"] ?? "",
    };
  } catch {
    return null;
  }
}

async function getSystemName(): Promise<string> {
  return platform().getSystemName();
}

function getLanIp(): string | null {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

async function promptDuration(): Promise<number> {
  const choice = await p.select({
    message: "How long do you want to share?",
    options: [
      { value: 6 * 60 * 60 * 1000, label: "6 hours" },
      { value: 24 * 60 * 60 * 1000, label: "24 hours" },
      { value: 7 * 24 * 60 * 60 * 1000, label: "1 week" },
      { value: UNLIMITED_DURATION_MS, label: "Unlimited" },
    ],
  });

  if (p.isCancel(choice)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  return choice as number;
}

function parseDurationFlag(): number {
  const arg = process.argv.find((a) => a.startsWith("--duration="));
  if (!arg) return 24 * 60 * 60 * 1000;
  const val = arg.slice("--duration=".length).trim().toLowerCase();
  if (val === "unlimited" || val === "inf" || val === "0") return UNLIMITED_DURATION_MS;
  if (val.endsWith("h")) return parseInt(val, 10) * 60 * 60 * 1000;
  if (val.endsWith("d")) return parseInt(val, 10) * 24 * 60 * 60 * 1000;
  if (val.endsWith("m")) return parseInt(val, 10) * 60 * 1000;
  return parseInt(val, 10) * 60 * 60 * 1000;
}

async function main() {
  if (process.argv.includes("--upgrade")) {
    await forceUpgrade();
    return;
  }

  await checkForUpdate();

  let canSetRawMode = false;
  if (typeof process.stdin.setRawMode === "function") {
    try {
      process.stdin.setRawMode(true);
      process.stdin.setRawMode(false);
      canSetRawMode = true;
    } catch {}
  }

  const isHeadless =
    !canSetRawMode ||
    process.argv.includes("--headless");

  p.intro("claude-share");

  const envTunnel =
    process.env.TUNNEL !== "0" && process.env.TUNNEL !== "false";

  // ── Resume saved session if still valid ──────────────────────────────────────
  const savedSession = loadSession();
  const isResuming = savedSession !== null;

  if (isResuming) {
    let exp: string;
    if (isUnlimitedDate(savedSession!.sharedUntil)) {
      exp = "Unlimited";
    } else {
      const remaining = Math.round((savedSession!.sharedUntil.getTime() - Date.now()) / 60000);
      exp = remaining > 60 ? `${Math.floor(remaining / 60)}h ${remaining % 60}m` : `${remaining}m`;
    }
    p.log.info(`Resuming previous session — ${exp} remaining, ${savedSession!.machines.size} machine(s) paired`);
  }

  let boreReady = false;
  if (!envTunnel) {
    p.log.info("TUNNEL=0 — sharing on LAN only.");
  } else if (!isResuming) {
    let shareMode: string;
    if (isHeadless) {
      // In headless mode default to internet if bore is/can be installed
      shareMode = "internet";
    } else {
      const choice = await p.select({
        message: "How do you want to share?",
        options: [
          {
            value: "internet",
            label: "Internet",
            hint: "EXPERIMENTAL: TCP tunnels via bore",
          },
          {
            value: "lan",
            label: "LAN only",
            hint: "Both machines require to be on the same network",
          },
        ],
      });
      if (p.isCancel(choice)) {
        p.cancel("Cancelled.");
        process.exit(0);
      }
      shareMode = choice as string;
    }

    if (shareMode === "internet") {
      if (await isBoreInstalled()) {
        boreReady = true;
      } else {
        try {
          await installBore();
          boreReady = true;
        } catch {
          p.log.warn("Could not install bore — sharing on LAN only.");
        }
      }
    }
  } else {
    // Resuming — assume internet mode if bore is available
    boreReady = await isBoreInstalled();
  }

  await initToken();
  await verifyTokenOrExit();

  let session;
  if (isResuming) {
    session = savedSession!;
  } else {
    const duration = isHeadless ? parseDurationFlag() : await promptDuration();
    session = createSession(duration);
    saveSession(session);
  }

  const DEFAULT_PORT = 25866;
  const argv = process.argv.slice(2);
  const portIdx = argv.findIndex((a) => a === "--port" || a === "-p");
  const portEq = argv.find(
    (a) => a.startsWith("--port=") || a.startsWith("-p="),
  );
  const portFlag =
    portEq != null
      ? parseInt(portEq.split("=")[1], 10)
      : portIdx !== -1
        ? parseInt(argv[portIdx + 1], 10)
        : null;
  let PORT =
    portFlag != null && !isNaN(portFlag)
      ? portFlag
      : parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  const lanIp = getLanIp();
  let lanUrl = lanIp ? `https://${lanIp}:${PORT}` : null;
  let loopbackUrl = `http://localhost:${PORT}`;

  const boreServer = process.env.BORE_SERVER ?? "bore.pub";

  // MITM proxy resolves only after its RSA CA is ready (no race on CONNECT)
  const mitmProxy = await createMitmProxy(
    lanIp,
    (auth) => {
      const session = getSession();
      return session ? checkMachineAuth(session, auth) : false;
    },
    boreServer,
    getSession,
  );
  logger.info("MITM proxy ready");

  // Mutable — publicUrl is filled in after the tunnel starts
  const urls = { public: null as string | null, lan: lanUrl };
  const sharerAccount = readSharerAccount();
  const systemName = await getSystemName();

  // Hono API on a random localhost-only port — not exposed externally
  // Tunnel state — declared before createApiApp so /health can report it, and
  // so the auto-respawn/watchdog below can mutate it (bore can die and must be
  // re-established without a manual pm2 restart).
  let tunnel: Awaited<ReturnType<typeof startTunnel>> = {
    publicUrl: null,
    close: () => {},
  };
  let publicUrl: string | null = null;
  let tunnelDown = false;
  let tunnelStartedAt: Date | null = null;
  let rerenderApp: (() => void) | null = null;
  let tunnelClosing = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = 1000;

  const apiApp = createApiApp(
    urls,
    mitmProxy.caCertPem,
    sharerAccount,
    systemName,
    () => tunnelDown,
  );
  const API_PORT = await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
  const honoServer = serve({
    fetch: apiApp.fetch,
    port: API_PORT,
    hostname: "127.0.0.1",
  });

  // Internal TLS termination server: accepts raw TLS bytes from the detector,
  // does the handshake, then routes by sniffing the first decrypted bytes:
  //   CONNECT → MITM proxy (HTTPS proxy tunnel)
  //   anything else → Hono API port (regular HTTPS API call)
  const tlsTermServer = tls.createServer(
    { cert: mitmProxy.serverCert.certPem, key: mitmProxy.serverCert.keyPem },
    (tlsSocket) => {
      // Post-handshake first-byte guard: the detector's 15s timer is cleared on
      // the raw ClientHello, so a peer that completes the TLS handshake then
      // sends no application bytes would be held forever (FD leak). Mirror the
      // detector — drop it after 15s, cleared once we route.
      const firstByteTimer = setTimeout(() => tlsSocket.destroy(), 15_000);
      firstByteTimer.unref?.();

      tlsSocket.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
          logger.error("[tls] socket error", err);
        }
      });
      tlsSocket.on("close", () => clearTimeout(firstByteTimer));

      tlsSocket.once("data", (chunk) => {
        clearTimeout(firstByteTimer);
        const isConnect = chunk
          .slice(0, 8)
          .toString("ascii")
          .toUpperCase()
          .startsWith("CONNECT");
        tlsSocket.unshift(chunk);
        if (isConnect) {
          mitmProxy.handleSocket(tlsSocket);
        } else {
          const upstream = net.connect(API_PORT, "127.0.0.1");
          tlsSocket.setNoDelay(true);
          upstream.setNoDelay(true);
          tlsSocket.pipe(upstream);
          upstream.pipe(tlsSocket);
          // Tear down BOTH sides on either error/close — otherwise a receiver
          // disconnect leaks the localhost upstream socket to the Hono port
          // until its timeout (confirmed FD leak under connection churn).
          upstream.on("error", () => tlsSocket.destroy());
          upstream.on("close", () => tlsSocket.destroy());
          tlsSocket.on("error", () => upstream.destroy());
          tlsSocket.on("close", () => upstream.destroy());
        }
      });
    },
  );
  const TLS_TERM_PORT = await new Promise<number>((resolve, reject) => {
    tlsTermServer.once("error", reject);
    tlsTermServer.listen(0, "127.0.0.1", () => {
      resolve((tlsTermServer.address() as net.AddressInfo).port);
    });
  });

  // Single public port: TLS ClientHello → TLS terminator (handles both HTTPS API
  // and HTTPS proxy CONNECT after decryption). Plain HTTP and bare CONNECT are
  // rejected — all traffic must be wrapped in TLS.
  const detector = createPortDetector({
    onConnect: (socket) => {
      socket.write(
        "HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n",
      );
      socket.destroy();
    },
    onTls: (socket) => {
      const upstream = net.connect(TLS_TERM_PORT, "127.0.0.1");
      socket.setNoDelay(true);
      upstream.setNoDelay(true);
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
    },
    onHttp: (socket) => {
      socket.write(
        "HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n",
      );
      socket.destroy();
    },
  });

  await new Promise<void>((resolve, reject) => {
    detector.once("error", reject);
    detector.listen(PORT, resolve);
  }).catch(async (err: NodeJS.ErrnoException) => {
    if (err.code !== "EADDRINUSE") throw err;

    const kill = await p.confirm({
      message: `Port ${PORT} is already in use. Kill the process and continue?`,
    });
    if (p.isCancel(kill)) {
      p.cancel("Cancelled.");
      process.exit(1);
    }

    if (!kill) {
      PORT = await new Promise<number>((resolve, reject) => {
        const srv = net.createServer();
        srv.once("error", reject);
        srv.listen(0, () => {
          const port = (srv.address() as net.AddressInfo).port;
          srv.close(() => resolve(port));
        });
      });
      lanUrl = lanIp ? `https://${lanIp}:${PORT}` : null;
      loopbackUrl = `http://localhost:${PORT}`;
      urls.lan = lanUrl;
      p.log.info(`Using port ${PORT} instead.`);
    } else {
      const { stdout } = await execFileAsync("lsof", [
        "-ti",
        `tcp:${PORT}`,
      ]).catch(() => ({ stdout: "" }));
      const pids = stdout.trim().split("\n").filter(Boolean);
      if (pids.length === 0) {
        p.log.error(`Could not find process on port ${PORT}.`);
        process.exit(1);
      }
      await execFileAsync("kill", ["-9", ...pids]);
      p.log.info(`Killed process on port ${PORT}, retrying…`);
    }

    await new Promise<void>((resolve, reject) => {
      detector.once("error", reject);
      detector.listen(PORT, resolve);
    });
  });
  logger.info(`Listening on port ${PORT}`);

  // The once("error", reject) used for the listen promise is a dead no-op once
  // listen has resolved, so a later listener error (e.g. EMFILE from FD
  // exhaustion) would be silently swallowed and wedge the process while pm2
  // still sees it "online". Attach a live handler: on FD exhaustion, exit so
  // pm2 restarts cleanly instead of leaving an unreachable server running.
  detector.on("error", (err: NodeJS.ErrnoException) => {
    logger.error("[detector] server error", err);
    if (err.code === "EMFILE" || err.code === "ENFILE") {
      logger.error(
        "[detector] file-descriptor exhaustion — exiting for pm2 to restart",
      );
      try {
        cleanup();
      } catch {}
      process.exit(1);
    }
  });

  // (Re)establish the bore tunnel. Called on first start and on every respawn;
  // saveBorePort() persists the port so a respawn keeps the same public URL and
  // existing connect links keep working.
  async function connectTunnel(): Promise<void> {
    if (tunnelClosing) return;
    try {
      tunnel = await startTunnel(PORT, onTunnelDown);
      publicUrl = tunnel.publicUrl;
      urls.public = publicUrl;
      if (publicUrl) {
        // If bore listened then died during the await, onTunnelDown already set
        // tunnelDown and scheduled a reconnect — don't clobber that "up" here
        // (which would falsely show the tunnel healthy against a dead child).
        if (!tunnelClosing && !reconnectTimer) {
          tunnelDown = false;
          tunnelStartedAt = new Date();
          reconnectDelay = 1000; // reset backoff on success
          logger.info(`Tunnel active: ${publicUrl}`);
        }
      } else {
        logger.warn("bore did not return a port — will retry");
        scheduleReconnect();
      }
    } catch (err) {
      logger.warn("Could not start bore tunnel — will retry", err);
      scheduleReconnect();
    }
    rerenderApp?.();
  }

  function onTunnelDown() {
    if (tunnelClosing) return;
    tunnelDown = true;
    logger.error(
      "[tunnel] leg=receiver→bore→sharer bore disconnected — respawning",
    );
    rerenderApp?.();
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (tunnelClosing || reconnectTimer) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000); // 1s→2s→…→30s
    logger.info(`[tunnel] reconnecting in ${Math.round(delay / 1000)}s`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      try {
        tunnel.close();
      } catch {}
      void connectTunnel();
    }, delay);
    reconnectTimer.unref?.();
  }

  if (boreReady) {
    logger.info("Starting bore tunnel");
    await connectTunnel();

    // Watchdog: bore.pub can silently drop the port registration without the
    // child process exiting (idle timeout), so onTunnelDown never fires. Probe
    // the PUBLIC url through the tunnel; on repeated failure, force a respawn.
    let healthFails = 0;
    const onWatchdogFail = (reason: string) => {
      healthFails++;
      logger.warn(`[tunnel] public /health check failed (${healthFails}/3): ${reason}`);
      if (healthFails >= 3) {
        healthFails = 0;
        // Local-liveness guard: if real proxied traffic reached us in the last
        // 90s, the tunnel is actually alive and the /health probe is just flaky
        // (a transient public-internet / bore.pub blip). Don't drop the active
        // receiver's connection with a needless respawn.
        const entries = getEntries();
        const lastReqTs = entries.length ? entries[0].ts.getTime() : 0;
        if (Date.now() - lastReqTs < 90_000) {
          logger.info("[tunnel] /health probe failing but recent proxied traffic seen — not respawning");
          return;
        }
        logger.error("[tunnel] public URL unreachable — forcing bore respawn");
        tunnelDown = true;
        rerenderApp?.();
        try {
          tunnel.close();
        } catch {}
        scheduleReconnect();
      }
    };
    const watchdog = setInterval(() => {
      if (tunnelClosing || tunnelDown || !publicUrl) return;
      const req = https.get(
        `${publicUrl}/health`,
        { rejectUnauthorized: false, timeout: 5000 },
        (res) => {
          res.resume();
          const s = res.statusCode ?? 0;
          if (s >= 200 && s < 500) healthFails = 0;
          else onWatchdogFail(`HTTP ${s}`);
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (e) => onWatchdogFail(e.message));
    }, 45_000);
    watchdog.unref();
  }

  let cleanedUp = false;
  function cleanup() {
    if (cleanedUp) return; // idempotent — now called from SIGINT/SIGTERM/exit/uncaught
    cleanedUp = true;
    tunnelClosing = true; // stop auto-respawn/watchdog from fighting shutdown
    if (reconnectTimer) clearTimeout(reconnectTimer);
    resetTerminalModes();
    mitmProxy.close();
    tunnel.close(); // kills the bore child
    detector.close();
    tlsTermServer.close();
    (honoServer as any).close?.();
    stopTokenRefresh();
    flushPendingSave(); // persist the last debounced token stats before we drop the session
    destroySession();
  }
  // Let the module-level uncaught handlers tear down (esp. kill bore) too.
  fatalCleanup = cleanup;

  // Backstop: guarantee the non-detached bore child dies on ANY exit path
  // (cleanup is idempotent + sync-safe), so it never orphans and squats the port.
  process.on("exit", () => {
    resetTerminalModes();
    cleanup();
  });

  if (isHeadless) {
    // ── Headless mode: no Ink TUI, log events to stdout ─────────────────────
    const connectUrl = (base: string) =>
      `claudeshare://${base.replace(/^https?:\/\//, "")}/connect/${session.pairingCode}`;

    if (publicUrl) process.stdout.write(`[claude-share] Public:  ${connectUrl(publicUrl)}\n`);
    if (lanUrl)    process.stdout.write(`[claude-share] LAN:     ${connectUrl(lanUrl)}\n`);
    process.stdout.write(`[claude-share] Local:   ${connectUrl(loopbackUrl)}\n`);

    const expiry = isUnlimitedDate(session.sharedUntil)
      ? "Unlimited"
      : session.sharedUntil.toISOString();
    process.stdout.write(`[claude-share] Sharing until ${expiry}\n`);
    process.stdout.write(`[claude-share] Ready. Port ${PORT}\n`);

    // Poll for machine changes and log them
    let knownMachineIds = new Set<string>(session.machines.keys());
    const poll = setInterval(() => {
      const s = getSession();
      if (!s) return;
      const current = new Map(s.machines);
      for (const [id, m] of current) {
        if (!knownMachineIds.has(id)) {
          process.stdout.write(`[claude-share] Machine connected: ${m.name} (${id.slice(0, 8)})\n`);
          knownMachineIds.add(id);
        }
      }
      for (const id of knownMachineIds) {
        if (!current.has(id)) {
          process.stdout.write(`[claude-share] Machine removed: ${id.slice(0, 8)}\n`);
          knownMachineIds.delete(id);
        }
      }
    }, 2000);
    poll.unref();

    process.on("SIGINT", () => { clearInterval(poll); cleanup(); process.exit(0); });
    process.on("SIGTERM", () => { clearInterval(poll); cleanup(); process.exit(0); });

    const expiryCheck = setInterval(() => {
      if (isSessionExpired(session)) {
        clearInterval(expiryCheck);
        clearInterval(poll);
        process.stdout.write("[claude-share] Session expired. Exiting.\n");
        cleanup();
        process.exit(0);
      }
    }, 60_000);
    expiryCheck.unref();
    return;
  }

  // ── Interactive TUI mode ─────────────────────────────────────────────────────
  function makeAppElement(): React.ReactElement {
    return React.createElement(App, {
      publicUrl,
      loopbackUrl,
      lanUrl,
      localPort: PORT,
      sharedUntil: session.sharedUntil,
      getSession: () => getSession(),
      tunnelDown,
      tunnelStartedAt,
      onExit: () => {
        cleanup();
        process.exit(0);
      },
    });
  }

  const { unmount, rerender } = render(makeAppElement());
  rerenderApp = () => rerender(makeAppElement());

  process.on("SIGINT", () => {
    unmount();
    cleanup();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    unmount();
    cleanup();
    process.exit(0);
  });

  const expiryCheck = setInterval(() => {
    if (isSessionExpired(session)) {
      clearInterval(expiryCheck);
      unmount();
      cleanup();
      process.exit(0);
    }
  }, 60_000);
  expiryCheck.unref();
}

main().catch((err) => {
  logger.error("Fatal error in main", err);
  process.exit(1);
});
