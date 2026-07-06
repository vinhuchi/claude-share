#!/usr/bin/env node
import "@shared/patch-console";
import { execFile } from "node:child_process";
import fs from "node:fs";
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

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", reason);
  process.exit(1);
});

// Exits with a clear error if the platform is unsupported
platform();

import { createPortDetector } from "./port/detector";
import { createMitmProxy } from "./proxy/mitm";
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

const CLAUDE_SHARE_CONFIG = path.join(
  os.homedir(),
  ".claude-share",
  "config.json",
);

function hasAgreedToTerms(): boolean {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(CLAUDE_SHARE_CONFIG, "utf8"),
    ) as Record<string, unknown>;
    return cfg["hasShareTermsAgreed"] === true;
  } catch {
    return false;
  }
}

function saveTermsAgreed(): void {
  const dir = path.dirname(CLAUDE_SHARE_CONFIG);
  fs.mkdirSync(dir, { recursive: true });
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CLAUDE_SHARE_CONFIG, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {}
  cfg["hasShareTermsAgreed"] = true;
  fs.writeFileSync(CLAUDE_SHARE_CONFIG, JSON.stringify(cfg, null, 2), {
    mode: 0o600,
  });
}

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

  if (!hasAgreedToTerms()) {
    if (isHeadless) {
      process.stderr.write(
        "[claude-share] ERROR: Terms not yet agreed. Run interactively once first to accept terms.\n",
      );
      process.exit(1);
    }
    p.log.warn(
      "Heads up: You're sharing your Claude Code at your own risk.\n" +
        "This is an open-source project and we are not liable for any damage or\n" +
        "suspension of your Claude Code subscription. Make sure you trust the\n" +
        "person you are sharing your subscription with.\n\n" +
        "This CLI is built to share your Claude Code with a few friends in need.\n" +
        "Sharing it with a lot of people can be a direct recipe for an account ban.\n" +
        "We love Claude Code and the purpose of this CLI is to help your friends\n" +
        "sometimes when they've hit their limit or just want to try it out.",
    );
    const agreed = await p.confirm({
      message: "Do you understand and want to continue?",
      initialValue: false,
    });
    if (p.isCancel(agreed) || !agreed) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    saveTermsAgreed();
  }

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
  const apiApp = createApiApp(
    urls,
    mitmProxy.caCertPem,
    sharerAccount,
    systemName,
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
      tlsSocket.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
          logger.error("[tls] socket error", err);
        }
      });

      tlsSocket.once("data", (chunk) => {
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
          upstream.on("error", () => tlsSocket.destroy());
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

  let tunnel: Awaited<ReturnType<typeof startTunnel>>;
  let publicUrl: string | null = null;
  let tunnelDown = false;
  let tunnelStartedAt: Date | null = null;
  let rerenderApp: (() => void) | null = null;

  if (boreReady) {
    logger.info("Starting bore tunnel");
    try {
      tunnel = await startTunnel(PORT, () => {
        tunnelDown = true;
        logger.error("bore tunnel disconnected unexpectedly");
        rerenderApp?.();
      });
      publicUrl = tunnel.publicUrl;
      urls.public = publicUrl;
      if (publicUrl) {
        tunnelStartedAt = new Date();
        logger.info(`Tunnel active: ${publicUrl}`);
      } else {
        logger.warn(
          "Unable to generate public URL: bore did not return a port",
        );
      }
    } catch (err) {
      logger.warn("Could not start bore tunnel", err);
      tunnel = { publicUrl: null, close: () => {} };
    }
  } else {
    tunnel = { publicUrl: null, close: () => {} };
  }

  function cleanup() {
    resetTerminalModes();
    mitmProxy.close();
    tunnel.close();
    detector.close();
    tlsTermServer.close();
    (honoServer as any).close?.();
    stopTokenRefresh();
    destroySession();
  }

  process.on("exit", resetTerminalModes);

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
