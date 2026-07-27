import * as p from "@clack/prompts";

import { resolveActiveUrl, resolveAnyActive } from "../health";
import { launchClaude } from "../launch";
import { loadConnections, writeActiveConnection } from "../storage";
import type { SavedConnection } from "../types";

export async function reconnectFlow(
  uuid?: string,
  claudeArgs: string[] = [],
  cwd?: string,
) {
  const connections = loadConnections();

  if (connections.length === 0) {
    p.log.warn("No saved connections. Run without flags to pair.");
    process.exit(0);
  }

  p.intro("claude-connect — reconnect");

  let chosen: SavedConnection;
  let resolvedUrl: string;

  if (uuid && !uuid.startsWith("-")) {
    const match = connections.find((c) => c.id.startsWith(uuid));
    if (!match) {
      p.log.error(`No connection matching ${uuid}`);
      process.exit(1);
    }
    chosen = match;
    const spin = p.spinner();
    spin.start(`Checking ${chosen.systemName}...`);
    const resolved = await resolveActiveUrl(chosen);
    if (!resolved.alive) {
      spin.stop("Server offline or session expired.");
      process.exit(1);
    }
    spin.stop("Connected.");
    resolvedUrl = resolved.url;
  } else {
    // Auto-scan all connections, use first alive one
    const spin = p.spinner();
    spin.start(`Scanning ${connections.length} saved connection(s)...`);
    const active = await resolveAnyActive(connections);
    if (!active) {
      spin.stop("No active sharers found.");
      process.exit(1);
    }
    spin.stop(`Found: ${active.conn.systemName}`);
    chosen = active.conn;
    resolvedUrl = active.url;
    // Keep active-connection.json fresh
    writeActiveConnection(chosen, resolvedUrl);
  }

  await launchClaude(
    resolvedUrl,
    chosen.caPem,
    chosen,
    claudeArgs,
    chosen.sharerAccount ?? null,
    cwd,
    "bore",
    { bore: resolvedUrl },
  );
}
