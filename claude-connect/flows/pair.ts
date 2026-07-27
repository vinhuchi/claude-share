import * as p from "@clack/prompts";

import { getOrCreateBridge } from "../cloudflared";
import { apiFetch } from "../fetch";
import { launchClaude } from "../launch";
import { logger } from "../logger";
import { decryptBlob, parseConnectUrl } from "../pairing";
import {
  getDeviceName,
  writeActiveConnection,
  writeConnection,
} from "../storage";
import type {
  CloudflareTunnelInfo,
  ConnectionFile,
  SavedConnection,
} from "../types";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Security (see CLAUDE.md): only the first 5 chars of the pairingCode may be
// sent over HTTP for session lookup — the full code is the private decryption key.
const PAIRING_LOOKUP_PREFIX_LEN = 5;

export async function pairFlow(
  prefill?: {
    serverUrl: string;
    pairingCode: string;
    cloudflare?: CloudflareTunnelInfo;
  },
  claudeArgs: string[] = [],
  cwd?: string,
) {
  p.intro("claude-connect — pair with a new sharer");

  let serverUrl: string;
  let pairingCode: string;
  let cloudflare: CloudflareTunnelInfo | undefined;

  if (prefill) {
    serverUrl = prefill.serverUrl;
    pairingCode = prefill.pairingCode;
    cloudflare = prefill.cloudflare;
    p.log.info(`Connecting to ${serverUrl}`);
  } else {
    const input = await p.text({
      message: "Connect link or sharer URL:",
      placeholder: "claudeshare://192.168.x.x:25866/connect/CODE",
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
      cloudflare = parsed.cloudflare;
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

  let serverHostname: string;
  try {
    serverHostname = new URL(serverUrl).hostname;
  } catch {
    p.log.error(`Invalid server URL: ${serverUrl}`);
    process.exit(1);
  }

  // Cloudflare Tunnel: the sharer's hostname is a tcp:// ingress that can't be
  // dialed directly — open a local `cloudflared access tcp` bridge and talk to
  // that localhost port for BOTH pairing and the Claude session. The sharer's
  // cert already SANs `localhost`, so the pinned TLS check still passes.
  let dialUrl = serverUrl;
  if (cloudflare) {
    const cfSpin = p.spinner();
    cfSpin.start("Opening Cloudflare tunnel bridge…");
    try {
      dialUrl = await getOrCreateBridge(
        cloudflare.hostname,
        cloudflare.serviceTokenId,
        cloudflare.serviceTokenSecret,
      );
      cfSpin.stop(`Cloudflare bridge ready (${cloudflare.hostname}).`);
    } catch (err) {
      cfSpin.stop("Failed.");
      p.log.error(`Cloudflare bridge failed: ${(err as Error).message}`);
      process.exit(1);
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
    const res = await apiFetch(`${dialUrl}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: pairingCode.slice(0, PAIRING_LOOKUP_PREFIX_LEN),
        name,
      }),
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
    if (typeof blob !== "string") {
      spin.stop("Failed.");
      p.log.error("Server returned a malformed response.");
      process.exit(1);
    }
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

  const saved: SavedConnection = {
    id: connectionId,
    systemName: file.systemName ?? serverHostname,
    publicServerUrl: file.publicServerUrl,
    sessionId: file.sessionId,
    sharedUntil: file.sharedUntil,
    caPem: file.caPem,
    savedAt: new Date().toISOString(),
    sharerAccount: file.sharerAccount ?? null,
    proxyUser: file.proxyUser,
    proxyPass: file.proxyPass,
    cloudflare: cloudflare ?? null,
  };
  writeConnection(saved);

  // Use the best available route for both the VS Code extension's
  // active-connection.json and the launched Claude proxy/session, matching
  // reconnect's "best route" semantics. For a Cloudflare share we MUST keep
  // dialing the local bridge (the sharer's publicServerUrl is the bore path,
  // which may be exactly what's blocked/unreachable here).
  const bestUrl = cloudflare ? dialUrl : file.publicServerUrl ?? serverUrl;
  writeActiveConnection(saved, bestUrl);

  await launchClaude(
    bestUrl,
    file.caPem,
    saved,
    claudeArgs,
    file.sharerAccount ?? null,
    cwd,
    cloudflare ? "cloudflare" : "bore",
    {
      bore: file.publicServerUrl ?? undefined,
      cloudflare: cloudflare ? dialUrl : undefined,
    },
    cloudflare
      ? () =>
          getOrCreateBridge(
            cloudflare!.hostname,
            cloudflare!.serviceTokenId,
            cloudflare!.serviceTokenSecret,
          ).then(() => {})
      : undefined,
  );
}
