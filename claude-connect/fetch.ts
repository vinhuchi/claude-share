import https from "node:https";

export interface ApiFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
  signal?: AbortSignal;
  /** CA cert PEM — enables TLS verification for HTTPS requests */
  ca?: string;
  /** Skip TLS verification entirely (safe for the first /pair call since the response is E2E encrypted) */
  rejectUnauthorized?: boolean;
}

export interface ApiFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

// Native fetch can't be given a custom CA cert, so we use node:https for HTTPS
// URLs (once the CA cert is known) and fall back to native fetch for HTTP.
export async function apiFetch(
  url: string,
  opts: ApiFetchOptions = {},
): Promise<ApiFetchResponse> {
  const {
    ca,
    rejectUnauthorized = true,
    timeout = 10_000,
    signal,
    method = "GET",
    headers = {},
    body,
  } = opts;

  if (url.startsWith("https:")) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = https.request(
        {
          hostname: parsed.hostname,
          port: parseInt(parsed.port || "443", 10),
          path: parsed.pathname + parsed.search,
          method,
          headers,
          ca,
          rejectUnauthorized,

          // Important: node fails to derive servername automatically when dealing with IP based URLs
          servername: parsed.hostname,
        },
        (res) => {
          let data = "";
          // Decode as UTF-8 so multi-byte sequences split across TCP chunks
          // aren't corrupted by per-chunk Buffer-to-string coercion.
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            data += chunk;
          });
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            resolve({
              ok: status >= 200 && status < 300,
              status,
              // Parse lazily inside the promise so a malformed body rejects
              // the returned promise instead of throwing synchronously.
              json: () =>
                new Promise((res, rej) => {
                  try {
                    res(JSON.parse(data));
                  } catch (e) {
                    rej(e);
                  }
                }),
            });
          });
          res.on("error", reject);
        },
      );
      req.setTimeout(timeout, () =>
        req.destroy(new Error("Request timed out")),
      );
      signal?.addEventListener("abort", () =>
        req.destroy(new Error("Aborted")),
      );
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }

  // HTTP — use native fetch
  const fetchSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
    : AbortSignal.timeout(timeout);
  const res = await fetch(url, { method, headers, body, signal: fetchSignal });
  return { ok: res.ok, status: res.status, json: () => res.json() };
}
