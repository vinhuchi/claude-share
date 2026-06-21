#!/usr/bin/env bun
/**
 * pack-vsix.ts — repack the patched Claude Code extension as a VSIX
 *
 * Usage:
 *   bun patches/pack-vsix.ts [--release]   # --release creates a GitHub release & uploads
 *
 * Output: dist/claude-code-patched-<version>-<platform>.vsix
 *
 * The VSIX is a ZIP with this structure:
 *   [Content_Types].xml
 *   extension.vsixmanifest
 *   extension/           ← all extension files go here
 *     package.json
 *     extension.js       ← already patched (proxy:!1 removed)
 *     resources/
 *     webview/
 *     node_modules/
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync, spawnSync } from "node:child_process";

// ── Find extension ────────────────────────────────────────────────────────────

function findExtDir(): string {
  const root = path.join(os.homedir(), ".vscode", "extensions");
  const dirs = fs.readdirSync(root)
    .filter((d) => d.startsWith("anthropic.claude-code-"))
    .sort()
    .reverse();
  if (!dirs.length) throw new Error("No anthropic.claude-code-* extension found");
  return path.join(root, dirs[0]);
}

function readVersion(extDir: string): { version: string; platform: string } {
  const manifest = fs.readFileSync(path.join(extDir, ".vsixmanifest"), "utf8");
  const version = manifest.match(/Id="claude-code"\s+Version="([^"]+)"/)?.[1]
    ?? manifest.match(/Version="([^"]+)"\s+Publisher="Anthropic"/)?.[1]
    ?? "0.0.0";
  const platform = manifest.match(/TargetPlatform="([^"]+)"/)?.[1] ?? "universal";
  return { version, platform };
}

// ── VSIX packing ──────────────────────────────────────────────────────────────

const EXCLUDE = new Set([
  ".vsixmanifest",   // goes to root, not extension/
  "extension.js.orig", // our backup
  "beautified",      // analysis dir, not needed
]);

function buildContentTypes(extDir: string): string {
  const exts = new Set<string>([".vsixmanifest"]);
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (EXCLUDE.has(entry.name)) continue;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name));
      } else {
        exts.add(path.extname(entry.name).toLowerCase() || ".bin");
      }
    }
  }
  walk(extDir);

  const mimeMap: Record<string, string> = {
    ".vsixmanifest": "text/xml",
    ".json": "application/json",
    ".js": "application/javascript",
    ".ts": "application/typescript",
    ".css": "text/css",
    ".html": "text/html",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".pem": "text/plain",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".node": "application/octet-stream",
    ".exe": "application/octet-stream",
    ".dll": "application/octet-stream",
    ".bin": "application/octet-stream",
    ".map": "application/json",
    ".lock": "text/plain",
    ".schema": "application/json",
  };

  const defaults = [...exts]
    .map((ext) => {
      const ct = mimeMap[ext] ?? "application/octet-stream";
      return `  <Default Extension="${ext}" ContentType="${ct}" />`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
${defaults}
</Types>`;
}

function packVsix(extDir: string, outPath: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vsix-pack-"));

  try {
    // Write [Content_Types].xml
    fs.writeFileSync(path.join(tmp, "[Content_Types].xml"), buildContentTypes(extDir), "utf8");

    // Copy .vsixmanifest to root
    fs.copyFileSync(path.join(extDir, ".vsixmanifest"), path.join(tmp, "extension.vsixmanifest"));

    // Copy extension files into extension/ subdir
    const extOut = path.join(tmp, "extension");
    fs.mkdirSync(extOut);
    copyDir(extDir, extOut);

    // Create ZIP using PowerShell (Windows) or zip (Unix)
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    if (process.platform === "win32") {
      // PowerShell Compress-Archive only supports .zip — pack to .zip then rename
      const zipPath = outPath.replace(/\.vsix$/, ".zip");
      const ps = `Compress-Archive -Path "${tmp}\\*" -DestinationPath "${zipPath}" -Force`;
      execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: "inherit" });
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
      fs.renameSync(zipPath, outPath);
    } else {
      execSync(`cd "${tmp}" && zip -r "${outPath}" .`, { stdio: "inherit", shell: true });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function copyDir(src: string, dest: string) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ── GitHub release ────────────────────────────────────────────────────────────

function createGitHubRelease(vsixPath: string, version: string, platform: string) {
  const tag = `vsix-${version}`;
  const title = `Claude Code ${version} (patched, ${platform})`;
  const notes = [
    `Patched Claude Code ${version} for claude-share receivers.`,
    ``,
    `Changes from upstream:`,
    `- Removed \`proxy:!1\` from 6 internal API calls so HTTPS_PROXY is respected`,
    ``,
    `**Install:** Extensions → ··· → Install from VSIX…`,
    `**Then:** set \`HTTPS_PROXY\` before launching VS Code (see claude-share docs).`,
  ].join("\n");

  // Check if tag already exists
  const existing = spawnSync("gh", ["release", "view", tag], { encoding: "utf8" });
  if (existing.status === 0) {
    console.log(`Release ${tag} already exists — uploading asset only.`);
    execSync(`gh release upload ${tag} "${vsixPath}" --clobber`, { stdio: "inherit" });
  } else {
    execSync(
      `gh release create ${tag} "${vsixPath}" --title "${title}" --notes "${notes.replace(/"/g, '\\"')}"`,
      { stdio: "inherit" },
    );
  }

  console.log(`\nRelease: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/${tag}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const doRelease = args.includes("--release");

  const extDir = findExtDir();
  const { version, platform } = readVersion(extDir);
  console.log(`Extension: anthropic.claude-code-${version}-${platform}`);

  // Verify patches are applied
  const code = fs.readFileSync(path.join(extDir, "extension.js"), "utf8");
  const proxyCount = (code.match(/proxy:!1/g) ?? []).length;
  if (proxyCount > 0) {
    console.error(`\n✗ ${proxyCount} proxy:!1 still present — run: bun patches/apply.ts first`);
    process.exit(1);
  }
  console.log("✓ Patches verified (0 proxy:!1 remaining)");

  const outName = `claude-code-patched-${version}-${platform}.vsix`;
  const outPath = path.join(import.meta.dir, "..", "dist", outName);

  console.log(`Packing → dist/${outName} ...`);
  packVsix(extDir, outPath);

  const size = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
  console.log(`Done. ${size} MB`);

  if (doRelease) {
    console.log("\nCreating GitHub release...");
    createGitHubRelease(outPath, version, platform);
  } else {
    console.log(`\nUpload manually: gh release create vsix-${version} "${outPath}"`);
    console.log(`Or run with --release to do it automatically.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
