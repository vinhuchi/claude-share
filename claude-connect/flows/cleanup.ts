import * as p from "@clack/prompts";

import { loadConnections, resetAll } from "../storage";

export async function cleanupFlow() {
  p.intro("claude-connect — cleanup");

  const count = loadConnections().length;
  if (count === 0) {
    p.log.info("No saved connections. Removing any cached CA / active link.");
  } else {
    p.log.info(`Found ${count} saved connection(s).`);
  }

  const ok = await p.confirm({
    message:
      "Remove all saved credentials (connections + cached CA)? Device name is kept.",
    initialValue: false,
  });
  if (p.isCancel(ok) || !ok) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  const { connections } = resetAll();
  p.log.success(`Removed ${connections} connection(s) and the cached CA.`);
  p.outro("Done.");
  process.exit(0);
}
