#!/usr/bin/env bun
/**
 * adapt.ts — when extension updates break patches, this generates a Claude prompt
 * that explains each broken patch semantically so an agent can re-derive anchor strings.
 *
 * Usage:
 *   bun patches/adapt.ts [--ext <path-to-new-ext-dir>]
 *
 * Flow:
 *   1. Run apply.ts --dry-run to find which patches fail
 *   2. For failing patches: show semantic description + surrounding beautified code
 *   3. Output a self-contained Claude prompt to re-derive anchor strings
 *
 * The prompt can be pasted into Claude to get updated anchors for patches.json.
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

function findExtensionDir(extArg?: string): string {
  if (extArg) return extArg;
  const root = path.join(os.homedir(), ".vscode", "extensions");
  const dirs = fs
    .readdirSync(root)
    .filter((e) => e.startsWith("anthropic.claude-code-"))
    .sort()
    .reverse();
  if (dirs.length === 0) throw new Error("No anthropic.claude-code-* found");
  return path.join(root, dirs[0]);
}

function checkPatch(code: string, patch: Patch): "ok" | "anchor-missing" | "anchor-not-unique" | "target-missing" {
  const idx = code.indexOf(patch.anchor);
  if (idx === -1) return "anchor-missing";
  if (code.indexOf(patch.anchor, idx + 1) !== -1) return "anchor-not-unique";
  const winStart = Math.max(0, idx - patch.window_before);
  const winEnd = Math.min(code.length, idx + patch.anchor.length + patch.window_after);
  const window = code.slice(winStart, winEnd);
  if (window.indexOf(patch.remove) === -1) return "target-missing";
  return "ok";
}

// Find all occurrences of 'proxy:!1' in the code with surrounding context
function findAllProxyBypasses(code: string): Array<{ pos: number; context: string }> {
  const results: Array<{ pos: number; context: string }> = [];
  let idx = 0;
  while (true) {
    const pos = code.indexOf("proxy:!1", idx);
    if (pos === -1) break;
    const start = Math.max(0, pos - 150);
    const end = Math.min(code.length, pos + 50);
    results.push({ pos, context: code.slice(start, end) });
    idx = pos + 1;
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const extIdx = args.indexOf("--ext");
  const extDir = findExtensionDir(extIdx !== -1 ? args[extIdx + 1] : undefined);
  const extJs = path.join(extDir, "extension.js");

  const patchesPath = path.join(import.meta.dir, "patches.json");
  const patches: Patch[] = JSON.parse(fs.readFileSync(patchesPath, "utf8"));

  const code = fs.readFileSync(extJs, "utf8");
  const version = path.basename(extDir);

  const results = patches.map((p) => ({ patch: p, status: checkPatch(code, p) }));
  const ok = results.filter((r) => r.status === "ok");
  const broken = results.filter((r) => r.status !== "ok");

  console.log(`\nExtension: ${version}`);
  console.log(`Patches OK: ${ok.length}/${patches.length}`);

  if (broken.length === 0) {
    console.log("All patches apply cleanly. No adaptation needed.");
    return;
  }

  console.log(`Broken: ${broken.map((r) => r.patch.id).join(", ")}\n`);

  // Find all proxy:!1 occurrences in new code for the prompt
  const allProxies = findAllProxyBypasses(code);

  const prompt = `
You are helping update anchor strings in patches.json after Claude Code extension updated to ${version}.

## What are anchors?

Each patch removes \`proxy:!1\` from a specific call site in the minified extension.js.
The \`anchor\` field is a unique string found near that \`proxy:!1\` in the minified code.
\`window_before\` + \`window_after\` define how far from the anchor to search for \`proxy:!1\`.

## All \`proxy:!1\` occurrences in the new ${version} extension.js:

${allProxies.map((p, i) => `### occurrence #${i + 1} (pos=${p.pos})\n\`\`\`\n${p.context}\n\`\`\``).join("\n\n")}

## Broken patches that need new anchors:

${broken
  .map(
    ({ patch, status }) => `### ${patch.id} [${status}]
**Description:** ${patch.description}
**Semantic location:** ${patch.semantic}
**Current anchor (not found):** ${JSON.stringify(patch.anchor)}
**Looking for:** \`${patch.remove}\` within ${patch.window_before + patch.anchor.length + patch.window_after} chars
`
  )
  .join("\n")}

## Task

For each broken patch above, identify which \`proxy:!1\` occurrence (#1–#${allProxies.length}) it corresponds to based on the semantic description.
Then provide a new \`anchor\` string that:
1. Appears **exactly once** in the file (check the occurrence context)
2. Is **within ${Math.max(...broken.map((r) => r.patch.window_after))} chars** before \`proxy:!1\` (so the window covers it)
3. Is **unique enough** to not appear elsewhere in the bundle

Return updated JSON entries for patches.json, e.g.:
\`\`\`json
{ "id": "...", "anchor": "<new anchor>", "window_before": 5, "window_after": <N> }
\`\`\`
`.trim();

  const outPath = path.join(import.meta.dir, "adapt-prompt.md");
  fs.writeFileSync(outPath, prompt, "utf8");
  console.log(`Claude prompt written to: ${outPath}`);
  console.log("Paste it into Claude to get updated anchor strings for patches.json.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
