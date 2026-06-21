#!/usr/bin/env bun
/**
 * apply.ts — patch Claude Code extension.js to remove proxy:!1 from specific API calls
 *
 * Usage:
 *   bun patches/apply.ts [--ext <path-to-extension-dir>] [--dry-run]
 *
 * Strategy: anchor-based windowed replacement.
 *   Each patch has a unique anchor string found near proxy:!1 in the minified bundle.
 *   We locate the anchor, then search within a small window for the exact string to remove.
 *   No line numbers, no full regex over entire file — survives minifier reformatting
 *   as long as the anchor string and the call structure stay the same.
 *
 * When extension updates and a patch breaks: run adapt.ts to get Claude prompt.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

interface Patch {
  id: string;
  description: string;
  semantic: string;
  anchor: string;
  window_before: number;
  window_after: number;
  remove: string;
}

function findExtensionDir(base?: string): string {
  const root =
    base ??
    path.join(os.homedir(), ".vscode", "extensions");
  const entries = fs.readdirSync(root);
  const dirs = entries
    .filter((e) => e.startsWith("anthropic.claude-code-"))
    .sort()
    .reverse();
  if (dirs.length === 0) throw new Error(`No anthropic.claude-code-* found in ${root}`);
  const chosen = dirs[0];
  console.log(`Extension: ${chosen}`);
  return path.join(root, chosen);
}

function applyPatch(code: string, patch: Patch): { code: string; ok: boolean; error?: string } {
  const anchorIdx = code.indexOf(patch.anchor);
  if (anchorIdx === -1) {
    return { code, ok: false, error: `anchor not found: ${JSON.stringify(patch.anchor.slice(0, 60))}` };
  }

  // Check anchor is unique
  const second = code.indexOf(patch.anchor, anchorIdx + 1);
  if (second !== -1) {
    return { code, ok: false, error: `anchor not unique (appears at ${anchorIdx} and ${second})` };
  }

  const winStart = Math.max(0, anchorIdx - patch.window_before);
  const winEnd = Math.min(code.length, anchorIdx + patch.anchor.length + patch.window_after);
  const window = code.slice(winStart, winEnd);

  const removeIdx = window.indexOf(patch.remove);
  if (removeIdx === -1) {
    return { code, ok: false, error: `"${patch.remove}" not found in window around anchor` };
  }

  const patched =
    code.slice(0, winStart) +
    window.slice(0, removeIdx) +
    window.slice(removeIdx + patch.remove.length) +
    code.slice(winEnd);

  return { code: patched, ok: true };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const extIdx = args.indexOf("--ext");
  const extBase = extIdx !== -1 ? args[extIdx + 1] : undefined;

  const extDir = findExtensionDir(extBase);
  const extJs = path.join(extDir, "extension.js");
  const backupJs = path.join(extDir, "extension.js.orig");

  const patchesPath = path.join(import.meta.dir, "patches.json");
  const patches: Patch[] = JSON.parse(fs.readFileSync(patchesPath, "utf8"));

  let code = fs.readFileSync(extJs, "utf8");
  const originalCode = code;

  let allOk = true;
  for (const patch of patches) {
    const result = applyPatch(code, patch);
    if (result.ok) {
      code = result.code;
      console.log(`✓ ${patch.id}`);
    } else {
      console.error(`✗ ${patch.id}: ${result.error}`);
      allOk = false;
    }
  }

  if (!allOk) {
    console.error("\nSome patches failed. Run: bun patches/adapt.ts to get re-derivation prompt.");
  }

  if (dryRun) {
    console.log("\n[dry-run] No files written.");
    return;
  }

  if (code === originalCode) {
    console.log("\nNo changes (all patches already applied or all failed).");
    return;
  }

  if (!fs.existsSync(backupJs)) {
    fs.copyFileSync(extJs, backupJs);
    console.log(`\nBackup: extension.js.orig`);
  }

  fs.writeFileSync(extJs, code, "utf8");
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
