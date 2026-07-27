#!/usr/bin/env node
import "@shared/patch-console";
import * as p from "@clack/prompts";

import { platform } from "@shared/platforms";
import { checkForUpdate, forceUpgrade } from "@shared/checkVersion";
import { resetTerminalModes } from "@shared/terminal";
import pkg from "../package.json";

if (process.argv.includes("-v") || process.argv.includes("--version")) {
  process.stdout.write(pkg.version + "\n");
  process.exit(0);
}

if (process.argv.includes("--upgrade")) {
  await forceUpgrade();
  process.exit(0);
}

import { pairFlow } from "./flows/pair";
import { reconnectFlow } from "./flows/reconnect";
import { listFlow } from "./flows/list";
import { cleanupFlow } from "./flows/cleanup";
import { serveFlow, unserveFlow, keepBridgeFlow } from "./flows/serve";
import { startLocalForwarder } from "./forwarder";
import { probeUrl, resolveActiveUrl, resolveAnyActive } from "./health";
import { launchClaude, launchClaudeReal } from "./launch";
import { logger } from "./logger";
import { parseConnectUrl } from "./pairing";
import { getOrCreateBridge } from "./cloudflared";
import type { CloudflareTunnelInfo } from "./types";
import {
  buildProxyUrl,
  findConnectionByCloudflareHost,
  findConnectionByServerUrl,
  loadConnections,
  pruneExpiredConnections,
} from "./storage";

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", reason);
  process.exit(1);
});

process.on("exit", resetTerminalModes);

/**
 * Open a `cloudflared access tcp` bridge for a Cloudflare share and return the
 * localhost URL to dial. Mirrors pairFlow's bridge setup so reconnect/menu
 * paths reach the sharer over Cloudflare instead of silently falling back to
 * bore (or being dropped entirely when bore is down).
 */
async function openCloudflareDial(cf: CloudflareTunnelInfo): Promise<string> {
  const spin = p.spinner();
  spin.start("Opening Cloudflare tunnel bridge…");
  try {
    const url = await getOrCreateBridge(
      cf.hostname,
      cf.serviceTokenId,
      cf.serviceTokenSecret,
    );
    spin.stop(`Cloudflare bridge ready (${cf.hostname}).`);
    return url;
  } catch (err) {
    spin.stop("Failed.");
    p.log.error(`Cloudflare bridge failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

/** Heal callback for launchClaude: re-ensure the shared bridge on its pinned
 *  port if it dropped, so a mid-session ConnectionRefused self-recovers. */
function cfHeal(cf: CloudflareTunnelInfo): () => Promise<void> {
  return () =>
    getOrCreateBridge(cf.hostname, cf.serviceTokenId, cf.serviceTokenSecret).then(
      () => {},
    );
}

// Exits with a clear error if the platform is unsupported
platform();

await checkForUpdate();

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

// Identify which arg indices belong to claude-connect itself
const ownIdxs = new Set<number>();
args.forEach((a, i) => {
  if (a === "--list" || a === "-l") ownIdxs.add(i);
  if (a === "--cleanup") ownIdxs.add(i);
  if (a === "--serve") ownIdxs.add(i);
  if (a === "--unserve") ownIdxs.add(i);
  if (a === "--keep-bridge") ownIdxs.add(i);
  if (a === "--real") ownIdxs.add(i);
  if (a === "--proxy") ownIdxs.add(i);
  if (a === "--skip-permissions") ownIdxs.add(i);
  if (a === "--reconnect" || a === "-r") {
    ownIdxs.add(i);
    if (args[i + 1] && !args[i + 1].startsWith("-")) ownIdxs.add(i + 1);
  }
  if (a.startsWith("--share=")) ownIdxs.add(i);
  if (a.startsWith("--dir=")) ownIdxs.add(i);
});

const claudeArgs = args.filter((_, i) => !ownIdxs.has(i));
const dirArg = args.find((a) => a.startsWith("--dir="))?.slice("--dir=".length).trim();
const shareArg = args.find((a) => a.startsWith("--share="));

pruneExpiredConnections();

// --cleanup wipes saved credentials and exits; no need to agree to terms first.
if (args.includes("--cleanup")) {
  await cleanupFlow();
}


// ── Dispatch ──────────────────────────────────────────────────────────────────

if (args.includes("--serve")) {
  await serveFlow();
} else if (args.includes("--unserve")) {
  await unserveFlow();
} else if (args.includes("--keep-bridge")) {
  await keepBridgeFlow();
} else if (args.includes("--proxy")) {
  p.intro("claude-connect — proxy mode");

  const saved = loadConnections();
  const active = await resolveAnyActive(saved);

  if (!active) {
    p.log.error("No active sharer found. Pair first with: claude-connect --share=<url>");
    process.exit(1);
  }

  p.log.info(`Using ${active.conn.systemName}'s share (${active.url})`);

  const proxyUrl = buildProxyUrl(active.url, active.conn.proxyUser, active.conn.proxyPass);
  const { port, close } = await startLocalForwarder(proxyUrl, active.conn.caPem);

  p.log.success(`Forwarder running — set in Open Design or any app:`);
  p.log.info(`ANTHROPIC_BASE_URL=http://127.0.0.1:${port}`);
  p.outro("Press Ctrl+C to stop.");

  process.on("SIGINT", () => { close(); process.exit(0); });
  process.on("SIGTERM", () => { close(); process.exit(0); });

  await new Promise(() => {}); // keep alive
} else if (args[0] === "--list" || args[0] === "-l") {
  await listFlow();
} else if (args.includes("--real")) {
  await launchClaudeReal(claudeArgs, dirArg);
} else if (args[0] === "--reconnect" || args[0] === "-r") {
  await reconnectFlow(args[1], claudeArgs, dirArg);
} else if (shareArg) {
  const connectUrl = shareArg.slice("--share=".length).trim();
  const parsed = parseConnectUrl(connectUrl);
  if (!parsed) {
    p.log.error(
      "Invalid --share URL. Expected: claudeshare://host:port/connect/CODE",
    );
    process.exit(1);
  }

  if (parsed.cloudflare) {
    // Resume a previously-paired Cloudflare share (open a fresh bridge, reuse
    // saved creds) instead of re-pairing every run — re-pairing burns a fresh
    // single-use code and leaves a duplicate saved connection behind. Fall back
    // to a fresh pair (with the code in the URL) only if none exists or it's dead.
    const existingCf = findConnectionByCloudflareHost(parsed.cloudflare.hostname);
    let resumed = false;
    if (existingCf) {
      const dialUrl = await openCloudflareDial(parsed.cloudflare);
      const h = await probeUrl(dialUrl, existingCf.caPem);
      if (h.alive) {
        p.intro("claude-connect");
        p.log.info(
          `Resuming existing connection for ${existingCf.systemName} (via ${parsed.cloudflare.hostname})`,
        );
        resumed = true; // launchClaude spawns Claude and never returns
        await launchClaude(
          dialUrl,
          existingCf.caPem,
          existingCf,
          claudeArgs,
          existingCf.sharerAccount ?? null,
          dirArg,
          "cloudflare",
          { bore: existingCf.publicServerUrl ?? undefined, cloudflare: dialUrl },
          cfHeal(parsed.cloudflare),
        );
      }
    }
    if (!resumed) await pairFlow(parsed, claudeArgs, dirArg);
  } else {
    const existing = findConnectionByServerUrl(parsed.serverUrl);
    if (existing) {
      const resolved = await resolveActiveUrl(existing);
      if (resolved.alive && resolved.sessionId === existing.sessionId) {
        // Same session still running — skip pairing entirely
        p.intro("claude-connect");
        p.log.info(`Resuming existing connection for ${existing.systemName}`);
        await launchClaude(
          resolved.url,
          existing.caPem,
          existing,
          claudeArgs,
          existing.sharerAccount ?? null,
          dirArg,
          "bore",
          { bore: resolved.url },
        );
      } else {
        // Session changed, server restarted, or TLS cert rotated (sharer restart
        // generates a new CA, so the old caPem fails verification and health
        // returns alive=false). The user provided an explicit new URL, so always
        // attempt fresh pairing — if the sharer is truly offline, pairFlow will
        // fail with a network error naturally.
        await pairFlow(parsed, claudeArgs, dirArg);
      }
    } else {
      await pairFlow(parsed, claudeArgs, dirArg);
    }
  }
} else {
  // No --share flag: check for active saved connections first
  const saved = loadConnections();

  if (saved.length > 0) {
    const spin = p.spinner();
    spin.start("Checking active sharers...");

    const results = await Promise.all(
      saved.map(async (c) => {
        // Cloudflare shares can't be health-probed without opening a bridge —
        // too heavy to do for every saved connection during the picker scan —
        // so surface them as available and open the bridge lazily on selection.
        if (c.cloudflare) {
          return { conn: c, url: "", alive: true };
        }
        const resolved = await resolveActiveUrl(c);
        return {
          conn: c,
          url: resolved.url,
          alive: resolved.alive && resolved.sessionId === c.sessionId,
        };
      }),
    );

    spin.stop();

    const active = results.filter((r) => r.alive);

    if (active.length > 0) {
      p.intro("claude-connect");
      const pick = await p.select({
        message: "Launch Claude with:",
        options: [
          ...active.map((r) => ({
            value: r.conn.id,
            label: r.conn.cloudflare
              ? `${r.conn.systemName}'s share (via ${r.conn.cloudflare.hostname})`
              : `${r.conn.systemName}'s share`,
            hint: r.conn.cloudflare ? `cloudflare · ${r.conn.cloudflare.hostname}` : r.url,
          })),
          {
            value: "__real__",
            label: "My own account",
            hint: "use your own Claude subscription, no proxy",
          },
          {
            value: "__new__",
            label: "Pair with a new sharer…",
            hint: "enter a connect URL",
          },
        ],
      });
      if (p.isCancel(pick)) {
        p.cancel("Cancelled.");
        process.exit(0);
      }
      if (pick === "__real__") {
        // Permission mode is now asked inside launchClaudeReal so every path
        // (--share, pair, reconnect, picker) prompts consistently.
        await launchClaudeReal(claudeArgs, dirArg);
      } else if (pick === "__new__") {
        await pairFlow(undefined, claudeArgs, dirArg);
      } else {
        const chosen = active.find((r) => r.conn.id === pick)!;
        const dialUrl = chosen.conn.cloudflare
          ? await openCloudflareDial(chosen.conn.cloudflare)
          : chosen.url;
        await launchClaude(
          dialUrl,
          chosen.conn.caPem,
          chosen.conn,
          claudeArgs,
          chosen.conn.sharerAccount ?? null,
          dirArg,
          chosen.conn.cloudflare ? "cloudflare" : "bore",
          chosen.conn.cloudflare
            ? { bore: chosen.conn.publicServerUrl ?? undefined, cloudflare: dialUrl }
            : { bore: chosen.url },
          chosen.conn.cloudflare ? cfHeal(chosen.conn.cloudflare) : undefined,
        );
      }
    } else {
      await pairFlow(undefined, claudeArgs, dirArg);
    }
  } else {
    await pairFlow(undefined, claudeArgs, dirArg);
  }
}
