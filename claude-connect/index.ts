#!/usr/bin/env node
import "@shared/patch-console";
import * as p from "@clack/prompts";

import { platform } from "@shared/platforms";
import { checkForUpdate, forceUpgrade } from "@shared/checkVersion";
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
import { resolveActiveUrl, resolveAnyActive } from "./health";
import { launchClaude, launchClaudeReal } from "./launch";
import { logger } from "./logger";
import { parseConnectUrl } from "./pairing";
import {
  findConnectionByServerUrl,
  hasAgreedToTerms,
  loadConnections,
  pruneExpiredConnections,
  saveTermsAgreed,
} from "./storage";

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

await checkForUpdate();

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

// Identify which arg indices belong to claude-connect itself
const ownIdxs = new Set<number>();
args.forEach((a, i) => {
  if (a === "--list" || a === "-l") ownIdxs.add(i);
  if (a === "--cleanup") ownIdxs.add(i);
  if (a === "--real") ownIdxs.add(i);
  if (a === "--skip-permissions") ownIdxs.add(i);
  if (a === "--reconnect" || a === "-r") {
    ownIdxs.add(i);
    if (args[i + 1] && !args[i + 1].startsWith("-")) ownIdxs.add(i + 1);
  }
  if (a.startsWith("--share=")) ownIdxs.add(i);
  if (a.startsWith("--dir=")) ownIdxs.add(i);
});

async function askLaunchMode(currentArgs: string[]): Promise<string[]> {
  // If already specified via flag, skip prompt
  if (
    args.includes("--skip-permissions") ||
    currentArgs.includes("--dangerously-skip-permissions")
  ) {
    return ["--dangerously-skip-permissions", ...currentArgs];
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
    ? ["--dangerously-skip-permissions", ...currentArgs]
    : currentArgs;
}

const claudeArgs = args.filter((_, i) => !ownIdxs.has(i));
const dirArg = args.find((a) => a.startsWith("--dir="))?.slice("--dir=".length).trim();
const shareArg = args.find((a) => a.startsWith("--share="));

pruneExpiredConnections();

if (!hasAgreedToTerms()) {
  p.intro("claude-connect");
  p.log.warn(
    "Heads up: you're connecting to someone else's Claude Code at your own discretion.\n" +
      "By design, the sharer's machine could potentially see your Claude Code messages\n" +
      "if they're running a modified, unofficial build of this program. Please connect\n" +
      "only to people you trust.\n\n" +
      "Once connected, you might still see your own email or organization name shown\n" +
      "in Claude Code. That's expected behavior and safe to ignore.",
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

// ── Dispatch ──────────────────────────────────────────────────────────────────

if (args[0] === "--list" || args[0] === "-l") {
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

  // Check if we already have credentials for this sharer
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
      );
    } else {
      // Session changed, server restarted, or TLS cert rotated (sharer restart generates
      // a new CA, so the old caPem fails verification and health returns alive=false).
      // The user provided an explicit new URL, so always attempt fresh pairing — if the
      // sharer is truly offline, pairFlow will fail with a network error naturally.
      await pairFlow(parsed, claudeArgs, dirArg);
    }
  } else {
    await pairFlow(parsed, claudeArgs, dirArg);
  }
} else {
  // No --share flag: check for active saved connections first
  const saved = loadConnections();

  if (saved.length > 0) {
    const spin = p.spinner();
    spin.start("Checking active sharers...");

    const results = await Promise.all(
      saved.map(async (c) => {
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
            label: `${r.conn.systemName}'s share`,
            hint: r.url,
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
        const finalArgs = await askLaunchMode(claudeArgs);
        await launchClaudeReal(finalArgs, dirArg);
      } else if (pick === "__new__") {
        await pairFlow(undefined, claudeArgs, dirArg);
      } else {
        const chosen = active.find((r) => r.conn.id === pick)!;
        const finalArgs = await askLaunchMode(claudeArgs);
        await launchClaude(
          chosen.url,
          chosen.conn.caPem,
          chosen.conn,
          finalArgs,
          chosen.conn.sharerAccount ?? null,
          dirArg,
        );
      }
    } else {
      await pairFlow(undefined, claudeArgs, dirArg);
    }
  } else {
    await pairFlow(undefined, claudeArgs, dirArg);
  }
}
