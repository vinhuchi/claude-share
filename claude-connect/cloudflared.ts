import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import * as p from "@clack/prompts";

import { logger } from "./logger";

const execFileAsync = promisify(execFile);

// Where we install cloudflared if it isn't already on PATH.
const LOCAL_DIR = path.join(os.homedir(), ".local", "bin");
const LOCAL_PATH = path.join(
  LOCAL_DIR,
  process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
);

// ── Binary discovery / install ──────────────────────────────────────────────

async function getCloudflaredPath(): Promise<string | null> {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const { stdout } = await execFileAsync(cmd, ["cloudflared"]);
    const first = stdout.split(/\r?\n/)[0]?.trim();
    if (first) return first;
  } catch {}
  try {
    await fs.promises.access(LOCAL_PATH, fs.constants.X_OK);
    return LOCAL_PATH;
  } catch {}
  return null;
}

export async function isCloudflaredInstalled(): Promise<boolean> {
  return (await getCloudflaredPath()) !== null;
}

function httpsGet(url: string): Promise<import("http").IncomingMessage> {
  return new Promise((resolve, reject) => {
    const attempt = (target: string) => {
      https
        .get(target, { headers: { "User-Agent": "claude-connect" } }, (res) => {
          if (
            (res.statusCode === 301 || res.statusCode === 302) &&
            res.headers.location
          ) {
            res.resume();
            attempt(res.headers.location);
          } else {
            resolve(res);
          }
        })
        .on("error", reject);
    };
    attempt(url);
  });
}

function downloadToFile(url: string, dest: string): Promise<void> {
  return httpsGet(url).then(
    (res) =>
      new Promise<void>((resolve, reject) => {
        if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
          res.resume();
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
        file.on("error", reject);
      }),
  );
}

// Node process.platform+arch → cloudflared release asset name.
function assetName(): string {
  const arch =
    process.arch === "arm64" ? "arm64" : process.arch === "arm" ? "arm" : "amd64";
  if (process.platform === "win32") return `cloudflared-windows-${arch}.exe`;
  if (process.platform === "darwin") return `cloudflared-darwin-${arch}.tgz`;
  return `cloudflared-linux-${arch}`; // raw binary
}

export async function installCloudflared(): Promise<void> {
  const spin = p.spinner();
  spin.start("Downloading cloudflared from GitHub...");
  try {
    const asset = assetName();
    const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
    await fs.promises.mkdir(LOCAL_DIR, { recursive: true });

    if (asset.endsWith(".tgz")) {
      // macOS ships a tarball containing a `cloudflared` binary.
      const tmp = path.join(os.tmpdir(), `cloudflared-${Date.now()}.tgz`);
      await downloadToFile(url, tmp);
      await execFileAsync("tar", ["xzf", tmp, "-C", LOCAL_DIR, "cloudflared"]);
      await fs.promises.rm(tmp, { force: true });
    } else {
      await downloadToFile(url, LOCAL_PATH);
    }
    if (process.platform !== "win32") await fs.promises.chmod(LOCAL_PATH, 0o755);
    spin.stop(`cloudflared installed to ${LOCAL_PATH}`);
  } catch (err) {
    spin.stop("cloudflared install failed.");
    throw new Error(`Could not install cloudflared: ${(err as Error).message}`);
  }
}

// ── access tcp bridge ───────────────────────────────────────────────────────

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const s = net.connect(port, "127.0.0.1");
      s.once("connect", () => {
        s.destroy();
        resolve();
      });
      s.once("error", () => {
        s.destroy();
        if (Date.now() > deadline) reject(new Error("cloudflared access timed out"));
        else setTimeout(tryConnect, 300);
      });
    };
    tryConnect();
  });
}

export interface AccessBridge {
  localPort: number;
  close(): void;
}

/**
 * Cloudflare's `tcp://` tunnel ingress can't be dialed by a raw TCP client — the
 * connecting side must run `cloudflared access tcp`, which opens a local port
 * that relays raw bytes through Cloudflare's edge to the origin. We dial that
 * local port instead of the public hostname. It's a byte-level bridge: the
 * session's pinned TLS handshake (against caPem) still happens end-to-end,
 * unchanged, exactly like through bore.pub.
 */
export async function startAccessTcp(
  hostname: string,
  serviceTokenId?: string,
  serviceTokenSecret?: string,
): Promise<AccessBridge> {
  const bin = (await getCloudflaredPath()) ?? "cloudflared";
  const localPort = await freePort();

  const args = [
    "access",
    "tcp",
    "--hostname",
    hostname,
    "--url",
    `127.0.0.1:${localPort}`,
  ];
  if (serviceTokenId && serviceTokenSecret) {
    args.push(
      "--service-token-id",
      serviceTokenId,
      "--service-token-secret",
      serviceTokenSecret,
    );
  }

  // cloudflared must reach Cloudflare's edge DIRECTLY — never through an
  // inherited HTTP(S)_PROXY (a proxy this receiver set for a previous share
  // session, or a system-wide proxy). A proxy URL with an `https://` scheme in
  // particular makes cloudflared bail with "proxy: unknown scheme: https" and
  // the bridge never comes up. Strip the proxy vars for the child.
  const env = { ...process.env };
  for (const k of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    delete env[k];
  }

  const proc = spawn(bin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    env,
  });

  let closed = false;
  const onLog = (chunk: Buffer) => {
    const t = chunk.toString().trim();
    if (t) logger.info(`[cloudflared] ${t.slice(0, 200)}`);
  };
  proc.stdout?.on("data", onLog);
  proc.stderr?.on("data", onLog);
  proc.on("exit", (code) => {
    if (!closed) logger.error(`[cloudflared] access tcp exited (code ${code})`);
  });

  try {
    await waitForPort(localPort, 30_000);
  } catch (err) {
    proc.kill();
    throw err;
  }

  return {
    localPort,
    close() {
      closed = true;
      proc.kill();
    },
  };
}

// ── Shared, auto-healing bridge ───────────────────────────────────────────────
//
// The old per-session model spawned a NEW cloudflared on a random port for every
// launch and killed it on exit. Hard-exits leaked the process (they piled up),
// and because HTTPS_PROXY was pinned to that random port, a dropped/killed bridge
// orphaned the whole session → "Unable to connect to API (ConnectionRefused)".
//
// Instead we keep ONE shared, DETACHED cloudflared per hostname on a port pinned
// in a lock file. Every session reuses it (no leak), and because the port is
// stable, a dead bridge self-heals on the SAME port — HTTPS_PROXY stays valid and
// Claude reconnects on its own.

const BRIDGE_LOCK = path.join(os.homedir(), ".claude-share", "cf-bridge.json");
const BRIDGE_LOG = path.join(os.homedir(), ".claude-share", "logs", "cf-bridge.log");

interface BridgeLock {
  hostname: string;
  port: number;
  pid: number;
}

function readBridgeLock(): BridgeLock | null {
  try {
    return JSON.parse(fs.readFileSync(BRIDGE_LOCK, "utf8")) as BridgeLock;
  } catch {
    return null;
  }
}

function writeBridgeLock(lock: BridgeLock): void {
  try {
    fs.mkdirSync(path.dirname(BRIDGE_LOCK), { recursive: true });
    fs.writeFileSync(BRIDGE_LOCK, JSON.stringify(lock), { mode: 0o600 });
  } catch {}
}

function pidAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function isPortListening(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.setTimeout(timeoutMs, () => done(false));
  });
}

// Serialize concurrent callers so two launches starting at once don't both spawn.
let bridgeInFlight: Promise<string> | null = null;

/**
 * Return a localhost URL bridging to a Cloudflare `tcp://` share. Reuses a single
 * shared, detached cloudflared (pinned port in a lock file) across sessions, and
 * respawns it on the SAME port when it has died — so this doubles as the heal
 * function: call it again and it's a no-op if healthy, a respawn if not.
 */
export async function getOrCreateBridge(
  hostname: string,
  serviceTokenId?: string,
  serviceTokenSecret?: string,
): Promise<string> {
  if (bridgeInFlight) return bridgeInFlight;
  bridgeInFlight = (async () => {
    const lock = readBridgeLock();
    const sameHost = lock?.hostname === hostname;

    // Healthy shared bridge already up → reuse.
    if (lock && sameHost && pidAlive(lock.pid) && (await isPortListening(lock.port))) {
      return `https://127.0.0.1:${lock.port}`;
    }

    // Dead/hung bridge for this host: reap the old process so its port frees up,
    // then respawn on the SAME port to keep every session's HTTPS_PROXY valid.
    if (lock && sameHost && lock.pid && pidAlive(lock.pid)) {
      try {
        process.kill(lock.pid);
      } catch {}
    }

    if (!(await isCloudflaredInstalled())) {
      await installCloudflared();
    }
    const bin = (await getCloudflaredPath()) ?? "cloudflared";
    const port = lock && sameHost && lock.port ? lock.port : await freePort();

    const args = ["access", "tcp", "--hostname", hostname, "--url", `127.0.0.1:${port}`];
    if (serviceTokenId && serviceTokenSecret) {
      args.push("--service-token-id", serviceTokenId, "--service-token-secret", serviceTokenSecret);
    }

    // cloudflared must reach Cloudflare's edge DIRECTLY — strip any inherited
    // proxy env (an https-scheme proxy makes it bail "unknown scheme: https").
    const env = { ...process.env };
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
      delete env[k];
    }

    let logFd: number | undefined;
    try {
      fs.mkdirSync(path.dirname(BRIDGE_LOG), { recursive: true });
      logFd = fs.openSync(BRIDGE_LOG, "a");
    } catch {}

    // Detached + unref so the bridge OUTLIVES the session that spawned it and can
    // be shared by later sessions. shell:false so proc.pid is cloudflared itself
    // (needed for the pidAlive check + reaping).
    const proc = spawn(bin, args, {
      detached: true,
      stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"],
      shell: false,
      windowsHide: true,
      env,
    });
    proc.unref();
    writeBridgeLock({ hostname, port, pid: proc.pid ?? 0 });

    try {
      await waitForPort(port, 30_000);
    } catch (err) {
      try {
        proc.kill();
      } catch {}
      throw err;
    }
    return `https://127.0.0.1:${port}`;
  })();

  try {
    return await bridgeInFlight;
  } finally {
    bridgeInFlight = null;
  }
}

/** Kill the shared bridge and remove its lock (used by `--unserve`). */
export function stopBridge(): void {
  const lock = readBridgeLock();
  if (lock?.pid && pidAlive(lock.pid)) {
    try {
      process.kill(lock.pid);
    } catch {}
  }
  try {
    fs.unlinkSync(BRIDGE_LOCK);
  } catch {}
}
