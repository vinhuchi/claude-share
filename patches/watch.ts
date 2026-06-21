#!/usr/bin/env bun
/**
 * watch.ts — watch ~/.vscode/extensions/ for new Claude Code versions, auto-apply patches
 *
 * Usage:
 *   bun patches/watch.ts [--ext-root <path>]
 *
 * Detects when VS Code installs a new anthropic.claude-code-* version and immediately
 * applies patches. Useful when auto-update is still enabled.
 *
 * For zero-friction setup: add this to startup (Task Scheduler / systemd / launchd).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

function getExtRoot(args: string[]): string {
  const idx = args.indexOf("--ext-root");
  if (idx !== -1) return args[idx + 1];
  return path.join(os.homedir(), ".vscode", "extensions");
}

function listClaudeVersions(root: string): string[] {
  try {
    return fs
      .readdirSync(root)
      .filter((e) => e.startsWith("anthropic.claude-code-"))
      .sort();
  } catch {
    return [];
  }
}

async function applyTo(extDir: string) {
  const applyScript = path.join(import.meta.dir, "apply.ts");
  console.log(`\n[watch] New version detected: ${path.basename(extDir)}`);
  console.log("[watch] Applying patches...");

  return new Promise<void>((resolve) => {
    const child = spawn("bun", [applyScript, "--ext", extDir], {
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        console.error(`[watch] apply.ts exited with code ${code}`);
        console.error("[watch] Run: bun patches/adapt.ts --ext", extDir, "to get re-derivation prompt.");
      } else {
        console.log("[watch] Patches applied successfully.");
      }
      resolve();
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const root = getExtRoot(args);

  console.log(`[watch] Monitoring: ${root}`);

  let known = new Set(listClaudeVersions(root));
  console.log(`[watch] Known versions: ${[...known].join(", ") || "(none)"}`);

  // Apply patches to the current latest version immediately on startup
  const current = listClaudeVersions(root).at(-1);
  if (current) {
    const extJs = path.join(root, current, "extension.js");
    const backupJs = path.join(root, current, "extension.js.orig");
    if (!fs.existsSync(backupJs)) {
      await applyTo(path.join(root, current));
    } else {
      console.log(`[watch] ${current} already patched, skipping.`);
    }
  }

  fs.watch(root, { persistent: true }, async (event, filename) => {
    if (!filename?.startsWith("anthropic.claude-code-")) return;

    const current = listClaudeVersions(root);
    const newVersions = current.filter((v) => !known.has(v));
    if (newVersions.length === 0) return;

    for (const v of newVersions) {
      known.add(v);
      // Wait briefly for VS Code to finish extracting before patching
      await Bun.sleep(3000);
      await applyTo(path.join(root, v));
    }
  });

  console.log("[watch] Watching for updates... (Ctrl+C to stop)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
