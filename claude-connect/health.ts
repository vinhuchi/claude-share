import { cache } from "@shared/cache";
import { apiFetch } from "./fetch";
import type { SavedConnection } from "./types";

export interface ActiveConnection {
  conn: SavedConnection;
  url: string;
  sessionId: string | null;
}

interface HealthResult {
  alive: boolean;
  sessionId: string | null;
}

export interface ResolvedUrl {
  url: string;
  alive: boolean;
  sessionId: string | null;
}

/**
 * @description This function checks the /health route to check if server is online and allows connections
 * @param serverUrl
 * @param caPem
 * @param timeout
 * @returns HealthResult
 */
async function checkHealth(
  serverUrl: string,
  caPem?: string,
  timeout = 2000,
): Promise<HealthResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeout);

  try {
    const res = await apiFetch(`${serverUrl}/health`, {
      signal: controller.signal,
      ca: caPem,
    });

    const body = (await res.json()) as {
      ok: boolean;
      sessionActive: boolean;
      sessionId?: string;
    };
    return {
      alive: body.ok && body.sessionActive,
      sessionId: body.sessionId ?? null,
    };
  } catch {
    return { alive: false, sessionId: null };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Health-probe an already-resolved dial URL directly (e.g. a Cloudflare bridge's
 * localhost port), instead of re-deriving it from conn.publicServerUrl the way
 * resolveActiveUrl does — used to decide resume-vs-repair for a Cloudflare share.
 */
export async function probeUrl(
  url: string,
  caPem?: string,
  timeout = 8000,
): Promise<HealthResult> {
  return checkHealth(url, caPem, timeout);
}
/**
 * @description Takes the connection file to figure out the
 *  fastest route (LAN or Public URL) to reach server.
 *  (Caches resolved url for 30 secs)
 * @param conn
 * @returns Resolved URL
 */
export async function resolveActiveUrl(
  conn: SavedConnection,
): Promise<ResolvedUrl> {
  const cacheKey = `resolvedUrl:${conn.id}`;
  const cached = cache.get<ResolvedUrl>(cacheKey);
  if (cached) return cached;

  const candidates: Array<{ url: string; timeout: number }> = [];

  if (conn.publicServerUrl) {
    candidates.push({ url: conn.publicServerUrl, timeout: 5_000 });
  }

  const fallback: ResolvedUrl = {
    url: candidates[0]?.url ?? "",
    alive: false,
    sessionId: null,
  };

  if (candidates.length === 0) return fallback;

  const overallTimeout = new Promise<ResolvedUrl>((resolve) =>
    setTimeout(() => resolve(fallback), 5_000),
  );

  const race = Promise.any(
    candidates.map(async ({ url, timeout }) => {
      const h = await checkHealth(url, conn.caPem, timeout);
      if (!h.alive) throw new Error("not alive");
      return { url, alive: true as const, sessionId: h.sessionId };
    }),
  ).catch(() => {
    return fallback;
  });

  const result = await Promise.race([race, overallTimeout]);
  if (result.alive) cache.set(cacheKey, result, 30_000);
  return result;
}

/**
 * Scans all saved connections in parallel and returns the first alive one.
 * Used as fallback when the active connection changes (sharer restart, URL change).
 */
export async function resolveAnyActive(
  connections: SavedConnection[],
): Promise<ActiveConnection | null> {
  if (connections.length === 0) return null;

  const results = await Promise.all(
    connections.map(async (conn) => {
      const resolved = await resolveActiveUrl(conn);
      if (!resolved.alive) return null;
      return { conn, url: resolved.url, sessionId: resolved.sessionId };
    }),
  );

  return results.find((r) => r !== null) ?? null;
}
