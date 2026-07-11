import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import * as p from "@clack/prompts";

const execFileAsync = promisify(execFile);

// Baked in at build time via --define; fall back to bore.pub in dev mode.
const BORE_SERVER = process.env.BORE_SERVER ?? "bore.pub";
const BORE_PASSWORD = process.env.BORE_PASSWORD ?? "";

const BORE_PORT_CACHE = path.join(os.homedir(), ".claude-share", "bore-port.json");

function loadSavedBorePort(): number | null {
  try {
    const data = JSON.parse(fs.readFileSync(BORE_PORT_CACHE, "utf8"));
    return typeof data.port === "number" ? data.port : null;
  } catch {
    return null;
  }
}

function saveBorePort(port: number): void {
  try {
    fs.mkdirSync(path.dirname(BORE_PORT_CACHE), { recursive: true });
    fs.writeFileSync(BORE_PORT_CACHE, JSON.stringify({ port }), { mode: 0o600 });
  } catch {}
}

// Where we install bore on Linux when it isn't already in PATH
const BORE_LOCAL_PATH = path.join(os.homedir(), ".local", "bin", "bore");

export interface Tunnel {
  publicUrl: string | null;
  close(): void;
}

// Returns the bore binary path (from PATH or the known local install location),
// or null if bore is not found.
async function getBorePath(): Promise<string | null> {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const { stdout } = await execFileAsync(cmd, ["bore"]);
    const p = stdout.trim();
    if (p) {
      const lines = p.split(/\r?\n/);
      return lines[0].trim();
    }
  } catch {}
  try {
    await fs.promises.access(BORE_LOCAL_PATH, fs.constants.X_OK);
    return BORE_LOCAL_PATH;
  } catch {}
  return null;
}

export async function isBoreInstalled(): Promise<boolean> {
  return (await getBorePath()) !== null;
}

// Follow redirects and return the final response.
function httpsGet(url: string): Promise<import("http").IncomingMessage> {
  return new Promise((resolve, reject) => {
    const attempt = (target: string) => {
      https
        .get(target, { headers: { "User-Agent": "claude-share" } }, (res) => {
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

async function fetchJson(url: string): Promise<unknown> {
  const res = await httpsGet(url);
  return new Promise((resolve, reject) => {
    let data = "";
    res.on("data", (c: Buffer) => (data += c));
    res.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    res.on("error", reject);
  });
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await httpsGet(url);
  if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
    res.resume();
    throw new Error(`Download failed: HTTP ${res.statusCode}`);
  }
  await new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    res.pipe(file);
    file.on("finish", () => file.close(() => resolve()));
    file.on("error", reject);
  });
}

// Node process.arch → bore release target triple prefix
const ARCH_MAP: Record<string, string> = {
  x64: "x86_64-unknown-linux-musl",
  arm64: "aarch64-unknown-linux-musl",
  arm: "armv7-unknown-linux-musleabihf",
  ia32: "i686-unknown-linux-musl",
};

async function installBoreLinux(): Promise<void> {
  const triple = ARCH_MAP[process.arch];
  if (!triple) {
    throw new Error(
      `No pre-built bore binary for arch "${process.arch}". ` +
        "Install bore manually: https://github.com/ekzhang/bore",
    );
  }

  const release = (await fetchJson(
    "https://api.github.com/repos/ekzhang/bore/releases/latest",
  )) as { tag_name: string };
  const tag = release.tag_name; // e.g. "v0.6.0"
  const filename = `bore-${tag}-${triple}.tar.gz`;
  const downloadUrl = `https://github.com/ekzhang/bore/releases/download/${tag}/${filename}`;

  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "bore-install-"),
  );
  const tarPath = path.join(tmpDir, filename);

  try {
    await downloadToFile(downloadUrl, tarPath);

    // Archive contains a single file named "bore" at root
    await execFileAsync("tar", ["xzf", tarPath, "-C", tmpDir, "bore"]);

    const installDir = path.dirname(BORE_LOCAL_PATH);
    await fs.promises.mkdir(installDir, { recursive: true });
    await fs.promises.copyFile(path.join(tmpDir, "bore"), BORE_LOCAL_PATH);
    await fs.promises.chmod(BORE_LOCAL_PATH, 0o755);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
}

export async function installBore(): Promise<void> {
  const spin = p.spinner();

  if (process.platform === "linux") {
    spin.start("Downloading bore binary from GitHub...");
    try {
      await installBoreLinux();
      spin.stop(`bore installed to ${BORE_LOCAL_PATH}`);
      return;
    } catch (err) {
      spin.stop(`Binary download failed: ${(err as Error).message}. Falling back to cargo...`);
    }
    // Fallback: cargo
    spin.start("Running: cargo install bore-cli");
    try {
      await execFileAsync("cargo", ["install", "bore-cli"]);
      spin.stop("bore installed via cargo.");
    } catch (err) {
      spin.stop("Installation failed.");
      throw new Error(`Could not install bore: ${(err as Error).message}`);
    }
    return;
  }

  if (process.platform === "darwin") {
    let bin: string;
    let args: string[];
    let label: string;
    try {
      await execFileAsync("which", ["brew"]);
      bin = "brew";
      args = ["install", "bore-cli"];
      label = "brew install bore-cli";
    } catch {
      bin = "cargo";
      args = ["install", "bore-cli"];
      label = "cargo install bore-cli";
    }
    spin.start(`Running: ${label}`);
    try {
      await execFileAsync(bin, args);
      spin.stop("bore installed.");
    } catch (err) {
      spin.stop("Installation failed.");
      throw new Error(`Could not install bore: ${(err as Error).message}`);
    }
    return;
  }

  throw new Error(
    "Unsupported platform — install bore manually: https://github.com/ekzhang/bore",
  );
}

export async function startTunnel(
  localPort: number,
  onDown?: () => void,
): Promise<Tunnel> {
  const boreBin = (await getBorePath()) ?? "bore";
  const savedPort = process.env.BORE_FIXED_PORT
    ? parseInt(process.env.BORE_FIXED_PORT, 10)
    : (loadSavedBorePort() ?? 39863);
  const args = ["local", String(localPort), "--to", BORE_SERVER];
  if (BORE_PASSWORD) args.push("--secret", BORE_PASSWORD);
  if (savedPort) args.push("--port", String(savedPort));

  return new Promise((resolve, reject) => {
    const proc = spawn(boreBin, args, { stdio: ["ignore", "pipe", "pipe"] });

    let settled = false;
    let closing = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error("bore timed out"));
      }
    }, 30_000);

    function onData(chunk: Buffer) {
      const text = chunk.toString();
      const match = text.match(/listening at \S+:(\d+)/i);
      if (match && !settled) {
        const port = parseInt(match[1], 10);
        if (savedPort && port !== savedPort) {
          settled = true;
          clearTimeout(timeout);
          proc.kill();
          reject(
            new Error(
              `Server assigned port ${port} instead of requested ${savedPort}`,
            ),
          );
          return;
        }
        settled = true;
        clearTimeout(timeout);
        saveBorePort(port);
        resolve({
          publicUrl: `https://${BORE_SERVER}:${port}`,
          close() {
            closing = true;
            proc.kill();
          },
        });
      }
    }

    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);

    proc.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    proc.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`bore exited with code ${code}`));
      } else if (!closing) {
        onDown?.();
      }
    });
  });
}
