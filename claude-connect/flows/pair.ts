import fs from "node:fs";

import * as p from "@clack/prompts";

import { apiFetch } from "../fetch";
import { launchClaude } from "../launch";
import { logger } from "../logger";
import { decryptBlob, parseConnectUrl } from "../pairing";
import {
  connectionPath,
  ensureConnectionsDir,
  getDeviceName,
} from "../storage";
import type { ConnectionFile, SavedConnection } from "../types";

export async function pairFlow(
  prefill?: { serverUrl: string; pairingCode: string },
  claudeArgs: string[] = [],
  cwd?: string,
) {
  p.intro("claude-connect — pair with a new sharer");

  let serverUrl: string;
  let pairingCode: string;

  if (prefill) {
    serverUrl = prefill.serverUrl;
    pairingCode = prefill.pairingCode;
    p.log.info(`Connecting to ${serverUrl}`);
  } else {
    const input = await p.text({
      message: "Connect link or sharer URL:",
      placeholder: "claudeshare://192.168.x.x:2586/connect/CODE",
      validate: (v) =>
        v?.startsWith("claudeshare://") || v?.startsWith("https://")
          ? undefined
          : "Must be a claudeshare:// URL",
    });
    if (p.isCancel(input)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }

    const parsed = parseConnectUrl((input as string).trim());
    if (parsed) {
      serverUrl = parsed.serverUrl;
      pairingCode = parsed.pairingCode;
    } else {
      serverUrl = (input as string).trim();
      const codeInput = await p.text({
        message: "Pairing code (from their terminal):",
        validate: (v) => ((v?.trim().length ?? 0) > 0 ? undefined : "Required"),
      });
      if (p.isCancel(codeInput)) {
        p.cancel("Cancelled.");
        process.exit(0);
      }
      pairingCode = (codeInput as string).trim();
    }
  }

  const name = getDeviceName();
  p.log.info(`Connecting as "${name}"`);

  const spin = p.spinner();
  spin.start("Pairing...");

  let blob: string;
  let connectionId: string;
  try {
    // rejectUnauthorized: false is safe here — the /pair response is E2E encrypted
    // with the pairingCode as the key, so a MITM cannot read or forge a valid response.
    const res = await apiFetch(`${serverUrl}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairingCode.slice(0, 5), name }),
      timeout: 10_000,
      rejectUnauthorized: false,
    });
    if (!res.ok) {
      spin.stop("Failed.");
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string } | null;
        if (body?.error) message = body.error;
      } catch {}
      logger.error(`Pairing failed: ${message}`, { serverUrl });
      p.log.error(message);
      process.exit(1);
    }
    const data = (await res.json()) as { blob: string; machineId: string };
    blob = data.blob;
    connectionId = data.machineId;
    const UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(connectionId)) {
      spin.stop("Failed.");
      p.log.error("Server returned an invalid machine ID.");
      process.exit(1);
    }
  } catch (err) {
    spin.stop("Network error.");
    logger.error("Pairing network error", err);
    p.log.error((err as Error).message);
    process.exit(1);
  }

  let file: ConnectionFile;
  try {
    file = decryptBlob(blob, pairingCode);
  } catch {
    spin.stop("Decryption failed.");
    p.log.error("Wrong pairing code or corrupted response.");
    process.exit(1);
  }

  spin.stop("Paired successfully.");

  ensureConnectionsDir();
  const saved: SavedConnection = {
    id: connectionId,
    systemName: file.systemName ?? new URL(serverUrl).hostname,
    lanServerUrl: file.lanServerUrl,
    publicServerUrl: file.publicServerUrl,
    sessionId: file.sessionId,
    sharedUntil: file.sharedUntil,
    caPem: file.caPem,
    savedAt: new Date().toISOString(),
    sharerAccount: file.sharerAccount ?? null,
    proxyUser: file.proxyUser,
    proxyPass: file.proxyPass,
  };
  fs.writeFileSync(
    connectionPath(connectionId),
    JSON.stringify(saved, null, 2),
  );

  await launchClaude(
    serverUrl,
    file.caPem,
    saved,
    claudeArgs,
    file.sharerAccount ?? null,
    cwd,
  );
}
