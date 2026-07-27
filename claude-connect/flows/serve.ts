import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";

import * as p from "@clack/prompts";

import { getOrCreateBridge, stopBridge } from "../cloudflared";
import { logger } from "../logger";
import { buildProxyUrl, loadConnections } from "../storage";

const execFileAsync = promisify(execFile);

// Stable CA bundle (MITM CA + real roots) — a PERMANENT path, unlike launchClaude's
// per-run temp file that gets deleted on exit. The Claude desktop app / any GUI
// inherits NODE_EXTRA_CA_CERTS pointing here, so it survives across app restarts.
const CA_BUNDLE = path.join(os.homedir(), ".claude-share", "ca-bundle.pem");

// Env vars we manage. HTTPS/HTTP_PROXY route Anthropic traffic through the sharer;
// the CA-bundle vars make Node AND non-Node tools trust the MITM cert while still
// verifying real sites (bun/Node treat NODE_EXTRA_CA_CERTS as REPLACING the store,
// so the bundle must include the real roots too).
const PROXY_VARS = ["HTTPS_PROXY", "HTTP_PROXY"];
const CA_VARS = [
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
];

async function setUserEnv(name: string, value: string): Promise<void> {
  // setx writes a PERSISTENT user env var (HKCU\Environment). Only inherited by
  // processes started AFTER — so the app must be restarted to pick it up.
  try {
    await execFileAsync("setx", [name, value]);
  } catch (err) {
    logger.warn(`[serve] setx ${name} failed`, err);
  }
}

async function deleteUserEnv(name: string): Promise<void> {
  try {
    await execFileAsync("reg", ["delete", "HKCU\\Environment", "/v", name, "/f"]);
  } catch {
    // not set — fine
  }
}

export async function serveFlow(): Promise<void> {
  p.intro("claude-connect --serve");

  const conns = loadConnections().sort(
    (a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime(),
  );
  if (conns.length === 0) {
    p.log.error("No saved connection. Pair first: claude-connect --share=\"<url>\"");
    process.exit(1);
  }
  const conn = conns[0];
  p.log.info(
    `Using ${conn.systemName}'s share` +
      (conn.cloudflare ? ` (via ${conn.cloudflare.hostname})` : ""),
  );

  // Resolve the proxy endpoint. Cloudflare → open the shared, auto-healed bridge
  // and dial its localhost port; bore → dial the public URL directly.
  let proxyBase: string;
  if (conn.cloudflare) {
    const spin = p.spinner();
    spin.start("Opening Cloudflare bridge…");
    try {
      proxyBase = await getOrCreateBridge(
        conn.cloudflare.hostname,
        conn.cloudflare.serviceTokenId,
        conn.cloudflare.serviceTokenSecret,
      );
      spin.stop(`Cloudflare bridge ready (${conn.cloudflare.hostname}).`);
    } catch (err) {
      spin.stop("Failed.");
      p.log.error(`Cloudflare bridge failed: ${(err as Error).message}`);
      process.exit(1);
    }
  } else if (conn.publicServerUrl) {
    proxyBase = conn.publicServerUrl;
  } else {
    p.log.error("Connection has no reachable endpoint.");
    process.exit(1);
  }

  const proxyUrl = buildProxyUrl(proxyBase, conn.proxyUser, conn.proxyPass);

  // Write the STABLE CA bundle (MITM CA + real roots).
  try {
    fs.mkdirSync(path.dirname(CA_BUNDLE), { recursive: true });
    fs.writeFileSync(
      CA_BUNDLE,
      [conn.caPem.trim(), ...tls.rootCertificates].join("\n") + "\n",
      { mode: 0o600 },
    );
  } catch (err) {
    p.log.error(`Could not write CA bundle: ${(err as Error).message}`);
    process.exit(1);
  }

  // Persist env so the desktop app (and any new terminal) inherits it.
  for (const v of PROXY_VARS) await setUserEnv(v, proxyUrl);
  for (const v of CA_VARS) await setUserEnv(v, CA_BUNDLE);

  p.log.success("Persistent env set (HTTPS_PROXY + CA bundle).");
  p.log.info(`  proxy: ${proxyBase}`);
  p.log.info(`  ca:    ${CA_BUNDLE}`);
  p.log.warn(
    "⚠ Restart the Claude desktop app (fully quit from tray) so it inherits the new env.",
  );

  if (!conn.cloudflare) {
    p.outro("Bore share — no local bridge to keep alive. Env is set; you can close this.");
    return;
  }

  // Cloudflare: keep this process alive as the bridge watchdog. The desktop app
  // has no watchdog of its own, so without this a dropped bridge would leave
  // NODE_EXTRA_CA_CERTS pointing at a dead port → ConnectionRefused.
  p.log.info("Watchdog running — keeping the Cloudflare bridge alive. Leave this open.");
  p.outro("Ctrl+C to stop (env stays; run `claude-connect --unserve` to remove it).");

  const cf = conn.cloudflare;
  let healing = false;
  const iv = setInterval(() => {
    if (healing) return;
    healing = true;
    void getOrCreateBridge(cf.hostname, cf.serviceTokenId, cf.serviceTokenSecret)
      .catch((err) => logger.warn("[serve] bridge heal failed", err))
      .finally(() => {
        healing = false;
      });
  }, 15_000);
  iv.unref?.();

  await new Promise(() => {}); // keep alive
}

/**
 * Headless bridge keeper (for a scheduled task / always-on process): keeps the
 * ONE shared Cloudflare bridge alive on its pinned port, independent of any
 * `claude` session. So even between sessions — or if a foreground session's
 * own watchdog isn't running — the stable port is always up and every launch
 * dials a live proxy. Does NOT touch env (unlike --serve).
 */
export async function keepBridgeFlow(): Promise<void> {
  const conn = loadConnections()
    .sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime())
    .find((c) => c.cloudflare);
  if (!conn?.cloudflare) {
    logger.warn("[keep-bridge] no saved Cloudflare connection — nothing to keep alive");
    process.exit(1);
  }
  const cf = conn.cloudflare;
  logger.info(`[keep-bridge] keeping ${cf.hostname} bridge alive (pinned port)`);

  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await getOrCreateBridge(cf.hostname, cf.serviceTokenId, cf.serviceTokenSecret);
    } catch (err) {
      logger.warn("[keep-bridge] heal failed", err);
    } finally {
      busy = false;
    }
  };
  await tick();
  const iv = setInterval(tick, 15_000);
  iv.unref?.();
  await new Promise(() => {}); // run forever
}

export async function unserveFlow(): Promise<void> {
  p.intro("claude-connect --unserve");
  for (const v of [...PROXY_VARS, ...CA_VARS]) await deleteUserEnv(v);
  stopBridge();
  try {
    fs.unlinkSync(CA_BUNDLE);
  } catch {}
  p.log.success("Removed persistent env + killed the shared bridge.");
  p.outro("Restart the Claude desktop app / terminals to clear the old env.");
}
