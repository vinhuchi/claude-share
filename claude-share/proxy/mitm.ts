import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import zlib from "node:zlib";

import { Proxy } from "http-mitm-proxy";

import { generateServerCert, type ServerCert } from "../ca/serverCert";
import { logger } from "../logger";
import { logRequest, setResponseStatus, setErrorLogFile } from "./requestLog";
import { recordTokens } from "./tokenCounter";
import { recordUsageEvent } from "./usageLog";
import { isRecording, isIncludingMessages, saveFlow } from "./flowLog";
import { getAccessToken, getFreshAccessToken } from "./token";
import { resolveMachineId } from "../session/manager";

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

function redactEmails(obj: any): any {
  if (typeof obj === "string") {
    return obj.replace(EMAIL_RE, "[REDACTED]");
  }
  if (Array.isArray(obj)) {
    return obj.map(redactEmails);
  }
  if (obj && typeof obj === "object") {
    const res: any = {};
    for (const key of Object.keys(obj)) {
      res[key] = redactEmails(obj[key]);
    }
    return res;
  }
  return obj;
}

const CTX_LOG_ID = Symbol("logId");
const CTX_MACHINE_ID = Symbol("machineId");
const CTX_REQUEST_BODY = Symbol("requestBody");
const CTX_REQUEST_BODY_READY = Symbol("requestBodyReady");
const CTX_RETRIED = Symbol("retried");
const socketMachineId = new WeakMap<object, string>();

// Domains the proxy intercepts and forwards to Anthropic with injected token
const INTERCEPT_DOMAINS = new Set([
  "api.anthropic.com",
  "platform.anthropic.com",
  "platform.claude.com",
  "mcp-proxy.anthropic.com",
]);

// Domains allowed to pass through without interception or token injection
const PASSTHROUGH_DOMAINS = new Set(["raw.githubusercontent.com"]);

// api.anthropic.com allowed paths
const API_ALLOWED_PATHS: Array<{ method: string | null; prefix: string }> = [
  { method: null, prefix: "/api/hello" },
  { method: "POST", prefix: "/v1/messages" },
  { method: "GET", prefix: "/v1/models" },
  // OAuth account profile — Claude Code fetches this to learn the account's
  // entitlements (e.g. Fable/Mythos access). Blocking it makes Claude Code
  // fall back to "no entitlement", so gated models like claude-fable-5 read as
  // "not available for your account" even when the sharer's account has them.
  { method: "GET", prefix: "/api/oauth/profile" },
  { method: "GET", prefix: "/api/claude_cli_profile" },
  // Plan usage/limits — powers Claude Code's own `/usage` (session 5h, weekly,
  // per-model incl. Fable). Allowing it lets the receiver run `/usage` and lets
  // the dashboard show the sharer's real utilization.
  { method: "GET", prefix: "/api/oauth/usage" },
  // WebFetch preflight domain-reputation check — blocking it makes Claude Code
  // report "Unable to verify if domain X is safe to fetch" for every WebFetch.
  { method: "GET", prefix: "/api/web/domain_info" },
];

// api.anthropic.com paths that are always blocked regardless of method
const API_BLOCKED_PREFIXES = ["/v1/files", "/v1/fine_tuning", "/v1/assistants"];

function isApiAllowed(method: string, reqPath: string): boolean {
  for (const blocked of API_BLOCKED_PREFIXES) {
    if (reqPath.startsWith(blocked)) return false;
  }
  for (const allowed of API_ALLOWED_PATHS) {
    if (reqPath.startsWith(allowed.prefix)) {
      if (allowed.method === null || allowed.method === method.toUpperCase())
        return true;
    }
  }
  return false;
}

// platform.anthropic.com allowed paths
function isPlatformAnthropicAllowed(reqPath: string): boolean {
  return reqPath.startsWith("/api/auth/");
}

// platform.claude.com allowed paths
function isPlatformClaudeAllowed(reqPath: string): boolean {
  return reqPath.startsWith("/v1/oauth/");
}

export interface MitmProxy {
  /** Feed a socket that has already been identified as a CONNECT request */
  handleSocket(socket: net.Socket): void;
  /** PEM of the CA cert that signs intercepted TLS connections */
  caCertPem: string;
  /** TLS server cert for the API port, signed by the MITM CA */
  serverCert: ServerCert;
  close(): void;
}

/**
 * Starts the MITM proxy on a random localhost port.
 * Resolves only after the RSA CA is ready so CONNECT handling never races.
 */
export async function createMitmProxy(
  lanIp: string | null = null,
  checkAuth: (authHeader: string) => boolean = () => false,
  publicHostname: string = "bore.pub",
  getSession: (() => import("../session/manager").Session | null) | null = null,
): Promise<MitmProxy> {
  // Persist the MITM CA across restarts. http-mitm-proxy generates the CA into
  // <sslCaDir>/certs/ca.pem + keys/ca.private.key on first listen and reuses it
  // if already present — so a stable dir keeps the CA fingerprint constant.
  // (A fresh temp dir per run rotated the CA, invalidating every receiver's
  // saved caPem and breaking reconnects after a sharer restart.)
  const sslCaDir = path.join(os.homedir(), ".claude-share", "mitm-ca");
  await fs.promises.mkdir(sslCaDir, { recursive: true, mode: 0o700 });

  return new Promise<MitmProxy>((resolve, reject) => {
    let proxyPort = 0;
    let proxyReady = false;
    const pendingSockets: net.Socket[] = [];

    const proxy = new Proxy();
    proxy.use(Proxy.gunzip);

    // The library calls console.error() before invoking onError handlers, so we
    // patch _onError directly to suppress benign keep-alive teardowns at the source.
    // Only swallow when no client is actually waiting on a response — otherwise a
    // stale keep-alive socket to api.anthropic.com getting reset (a normal race once
    // keepAlive is on) would silently drop the client's request instead of the library's
    // usual fallback of replying 504, leaving the client hanging forever.
    const _origOnError = (proxy as any)._onError.bind(proxy);
    (proxy as any)._onError = (kind: string, ctx: any, err: Error) => {
      const code = (err as NodeJS.ErrnoException)?.code;
      const isBenign = code === "ECONNRESET" || code === "HPE_INVALID_EOF_STATE";
      const clientAwaitingResponse =
        ctx?.proxyToClientResponse && !ctx.proxyToClientResponse.headersSent;

      // Stale keep-alive socket race: the pooled connection to api.anthropic.com
      // died between being pulled from the agent's free list and this request
      // writing to it. Retry once on a fresh, non-pooled connection instead of
      // surfacing the library's default 504 — same recovery Claude Code's own
      // CLI uses for this exact ECONNRESET/EPIPE race (disableKeepAlive + fresh
      // client + retry in its withRetry.ts).
      // A POST body we never buffered (e.g. platform.claude.com OAuth calls,
      // which don't go through the redaction filter below) can't be replayed
      // safely — fall through to the library's default 504 for those instead
      // of retrying with a truncated/empty body.
      const method = ctx?.clientToProxyRequest?.method;
      const bodyReplayable = method !== "POST" || ctx?.[CTX_REQUEST_BODY_READY] !== undefined;

      if (
        kind === "PROXY_TO_SERVER_REQUEST_ERROR" &&
        code === "ECONNRESET" &&
        clientAwaitingResponse &&
        bodyReplayable &&
        !ctx[CTX_RETRIED]
      ) {
        ctx[CTX_RETRIED] = true;
        logger.warn(
          `[mitm] ECONNRESET (stale keep-alive) on ${method ?? "?"} ` +
            `${ctx?.clientToProxyRequest?.url ?? "?"} — retrying once on fresh connection`,
        );
        retryOnFreshConnection(ctx);
        return;
      }

      if (isBenign && !clientAwaitingResponse) return;
      _origOnError(kind, ctx, err);
    };

    function retryOnFreshConnection(ctx: any) {
      const options = { ...ctx.proxyToServerRequestOptions, agent: false as const };
      const transport = ctx.isSSL ? https : http;

      const send = (body?: string) => {
        const retryReq = transport.request(options, (retryRes: any) => {
          const clientRes = ctx.proxyToClientResponse;
          if (!clientRes || clientRes.headersSent) return;
          logger.info(
            `[mitm] retry succeeded (HTTP ${retryRes.statusCode}) on ` +
              `${ctx?.clientToProxyRequest?.url ?? "?"}`,
          );
          const headers = { ...retryRes.headers };
          delete headers["authorization"];
          delete headers["set-cookie"];
          delete headers["x-api-key"];
          delete headers["anthropic-organization-id"];
          clientRes.writeHead(retryRes.statusCode ?? 502, headers);
          retryRes.pipe(clientRes);
        });
        retryReq.on("error", (retryErr: Error) => {
          const rc = (retryErr as NodeJS.ErrnoException)?.code ?? "ERR";
          logger.error(
            `[mitm] retry on fresh connection failed: code=${rc} ` +
              `${ctx?.clientToProxyRequest?.url ?? "?"} — ${retryErr.message}`,
          );
          _origOnError("PROXY_TO_SERVER_REQUEST_ERROR", ctx, retryErr);
        });
        if (typeof body === "string") {
          retryReq.end(Buffer.from(body));
        } else {
          retryReq.end();
        }
      };

      // Wait for the full (redacted) body to be buffered before replaying —
      // the stale-socket error can race ahead of the client finishing its upload.
      const bodyReady: Promise<string> | undefined = ctx[CTX_REQUEST_BODY_READY];
      if (bodyReady) {
        bodyReady.then(send).catch(() => send());
      } else {
        send();
      }
    }

    proxy.onError((ctx: any, err: any) => {
      if (!err) return;
      const code = (err as NodeJS.ErrnoException)?.code ?? "ERR";
      const host = (ctx?.clientToProxyRequest?.headers?.host ?? "").split(":")[0] || "unknown";
      const method = ctx?.clientToProxyRequest?.method ?? "";
      const reqPath = ctx?.clientToProxyRequest?.url ?? "";
      const retried = ctx?.[CTX_RETRIED] ? " (after retry)" : "";
      logger.error(
        `[mitm] proxy error: code=${code} ${method} ${host}${reqPath}${retried} — ${err?.message ?? err}`,
      );

      // A proxy error with no HTTP response is otherwise invisible on the
      // dashboard (only >=400 responses get an error log). Surface real failures
      // to api.anthropic.com so they show up in the Errors tab for debugging.
      const clientAwaiting =
        ctx?.proxyToClientResponse && !ctx.proxyToClientResponse.headersSent;
      if (clientAwaiting && host === "api.anthropic.com") {
        const logId = ctx?.[CTX_LOG_ID];
        if (logId !== undefined) setResponseStatus(logId, 502);
        try {
          const logDir = path.join(os.homedir(), ".claude-share", "logs");
          fs.mkdirSync(logDir, { recursive: true });
          const logFilename = `api-error-conn-${Date.now()}.log`;
          const reqBody = ctx?.[CTX_REQUEST_BODY] ?? "(not captured)";
          const content = [
            `TIMESTAMP: ${new Date().toISOString()}`,
            `METHOD: ${method}`,
            `PATH: ${reqPath}`,
            `ERROR: connection/proxy error (no HTTP response reached the client)`,
            `ERROR CODE: ${code}`,
            `RETRIED: ${ctx?.[CTX_RETRIED] ? "yes" : "no"}`,
            `ERROR MESSAGE: ${err?.message ?? String(err)}`,
            `REQUEST BODY (FIRST 5000 CHARS):\n${String(reqBody).slice(0, 5000)}`,
          ].join("\n\n");
          fs.writeFileSync(path.join(logDir, logFilename), content, "utf8");
          if (logId !== undefined) setErrorLogFile(logId, logFilename);
        } catch (logErr) {
          logger.error("[mitm] failed to write connection error log", logErr);
        }
      }
    });

    proxy.onRequest((ctx: any, callback: () => void) => {
      const host = ctx.clientToProxyRequest.headers.host ?? "";
      const hostname = host.split(":")[0];
      const method = ctx.clientToProxyRequest.method ?? "GET";
      const reqPath = ctx.clientToProxyRequest.url ?? "/";

      if (PASSTHROUGH_DOMAINS.has(hostname)) {
        return callback();
      }

      if (!INTERCEPT_DOMAINS.has(hostname)) {
        logRequest(method, hostname, reqPath, "blocked");
        ctx.proxyToClientResponse.writeHead(403, {
          "Content-Type": "text/plain",
        });
        ctx.proxyToClientResponse.end("Not allowed by claude-share policy");
        return;
      }

      if (hostname === "api.anthropic.com" && !isApiAllowed(method, reqPath)) {
        logRequest(method, hostname, reqPath, "blocked");
        ctx.proxyToClientResponse.writeHead(403, {
          "Content-Type": "text/plain",
        });
        ctx.proxyToClientResponse.end("Not allowed by claude-share policy");
        return;
      }
      if (
        hostname === "platform.anthropic.com" &&
        !isPlatformAnthropicAllowed(reqPath)
      ) {
        logRequest(method, hostname, reqPath, "blocked");
        ctx.proxyToClientResponse.writeHead(403, {
          "Content-Type": "text/plain",
        });
        ctx.proxyToClientResponse.end("Not allowed by claude-share policy");
        return;
      }
      if (
        hostname === "platform.claude.com" &&
        !isPlatformClaudeAllowed(reqPath)
      ) {
        logRequest(method, hostname, reqPath, "blocked");
        ctx.proxyToClientResponse.writeHead(403, {
          "Content-Type": "text/plain",
        });
        ctx.proxyToClientResponse.end("Not allowed by claude-share policy");
        return;
      }

      // Resolve machineId: try WeakMap(socket→id) first, fall back to connectRequest header
      const reqSocket = ctx.clientToProxyRequest?.socket;
      let machineId: string | undefined = reqSocket ? socketMachineId.get(reqSocket) : undefined;
      if (!machineId) {
        const connectAuth = ctx.connectRequest?.headers?.["proxy-authorization"] ?? "";
        if (connectAuth) {
          const session = getSession?.();
          if (session) {
            machineId = resolveMachineId(session, connectAuth) ?? undefined;
          }
        }
      }

      if (machineId) {
        ctx[CTX_MACHINE_ID] = machineId;
      }

      ctx[CTX_LOG_ID] = logRequest(method, hostname, reqPath, "allowed", machineId);

      ctx.proxyToServerRequestOptions.headers =
        ctx.proxyToServerRequestOptions.headers ?? {};

      // Re-read the on-disk token if the cached snapshot is stale, so we never
      // forward a token the sharer's CLI has already rotated out. Header rewrites,
      // body redaction and callback() run in finally regardless of the outcome.
      getFreshAccessToken()
        .then((token) => {
          ctx.proxyToServerRequestOptions.headers["authorization"] = `Bearer ${token}`;
        })
        .catch((err) => {
          logger.error("[mitm] fresh token fetch failed, using cached token", err);
          ctx.proxyToServerRequestOptions.headers["authorization"] = `Bearer ${getAccessToken()}`;
        })
        .finally(() => {
          delete ctx.proxyToServerRequestOptions.headers["x-api-key"];
          delete ctx.proxyToServerRequestOptions.headers["x-forwarded-for"];
          delete ctx.proxyToServerRequestOptions.headers["x-real-ip"];

          // Redact emails in request body before forwarding to Anthropic
          if (method === "POST" && hostname === "api.anthropic.com") {
            delete ctx.proxyToServerRequestOptions.headers["content-length"];
            ctx.proxyToServerRequestOptions.headers["transfer-encoding"] = "chunked";
            const chunks: Buffer[] = [];
            // Retry (see retryOnFreshConnection) must not resend before the
            // client has finished uploading its body — a stale-socket ECONNRESET
            // can fire before flush() below runs, and reading ctx[CTX_REQUEST_BODY]
            // synchronously at that point would replay an empty body and Anthropic
            // rejects it with "Input is a zero-length, empty document".
            let resolveBodyReady!: (body: string) => void;
            ctx[CTX_REQUEST_BODY_READY] = new Promise<string>((resolve) => {
              resolveBodyReady = resolve;
            });
            ctx.addRequestFilter(
              new Transform({
                transform(chunk, _enc, done) {
                  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                  done();
                },
                flush(done) {
                  const body = Buffer.concat(chunks).toString("utf8");
                  let redacted = body;
                  try {
                    const parsed = JSON.parse(body);
                    const redactedObj = redactEmails(parsed);
                    redacted = JSON.stringify(redactedObj);
                  } catch (err) {
                    // Fallback to regex replace if body is not valid JSON
                    redacted = body.replace(EMAIL_RE, "[REDACTED]");
                  }
                  ctx[CTX_REQUEST_BODY] = redacted;
                  resolveBodyReady(redacted);
                  this.push(Buffer.from(redacted));
                  done();
                },
              }),
            );
          }

          callback();
        });
    });

    proxy.onResponse((ctx: any, callback: () => void) => {
      const logId = ctx[CTX_LOG_ID];
      const status = ctx.serverToProxyResponse.statusCode ?? 0;
      if (logId !== undefined) {
        setResponseStatus(logId, status);
      }

      // When Anthropic rejects with 401, the sharer's token is invalid/expired.
      // Replace the body so the receiver sees the real cause instead of a generic
      // "authentication_error" that looks like a proxy credentials problem.
      const host = (ctx.clientToProxyRequest?.headers?.host ?? "").split(
        ":",
      )[0];

      // Log EVERY Anthropic error response (>=400) to disk — method, path,
      // status, decoded response body, and request body — so any failure is
      // diagnosable, not just 400s. Added before the 401 rewrite below so we
      // still capture Anthropic's original body even when we replace it for the
      // client. Files land in ~/.claude-share/logs/api-error-<status>-<ts>.log
      // and are linked to the dashboard row via setErrorLogFile.
      if (status >= 400 && host === "api.anthropic.com") {
        const encoding = (ctx.serverToProxyResponse?.headers?.["content-encoding"] ?? "") as string;
        const resChunks: Buffer[] = [];
        ctx.addResponseFilter(
          new Transform({
            transform(chunk, _enc, done) {
              resChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
              this.push(chunk);
              done();
            },
            flush(done) {
              const raw = Buffer.concat(resChunks);
              let resBody: string;
              try {
                if (encoding === "gzip") resBody = zlib.gunzipSync(raw).toString("utf8");
                else if (encoding === "deflate") resBody = zlib.inflateSync(raw).toString("utf8");
                else if (encoding === "br") resBody = zlib.brotliDecompressSync(raw).toString("utf8");
                else resBody = raw.toString("utf8");
              } catch {
                resBody = raw.toString("utf8");
              }
              const reqBody = ctx[CTX_REQUEST_BODY] ?? "(not captured)";

              const logDir = path.join(os.homedir(), ".claude-share", "logs");
              try {
                fs.mkdirSync(logDir, { recursive: true });
                const logFilename = `api-error-${status}-${Date.now()}.log`;
                const logPath = path.join(logDir, logFilename);
                const logContent = [
                  `TIMESTAMP: ${new Date().toISOString()}`,
                  `METHOD: ${ctx.clientToProxyRequest?.method ?? ""}`,
                  `PATH: ${ctx.clientToProxyRequest?.url ?? ""}`,
                  `RESPONSE STATUS: ${status}`,
                  `RESPONSE BODY:\n${resBody}\n`,
                  `REQUEST BODY (FIRST 5000 CHARS):\n${reqBody.slice(0, 5000)}\n`,
                  `REQUEST BODY (FULL):\n${reqBody}`,
                ].join("\n\n");

                fs.writeFileSync(logPath, logContent, "utf8");
                if (logId !== undefined) {
                  setErrorLogFile(logId, logFilename);
                }
                logger.error(`[mitm] API ${status} error. Logged request/response to ${logPath}`);
              } catch (logErr) {
                logger.error("[mitm] failed to write API error log", logErr);
              }
              done();
            },
          }),
        );
      }

      if (status === 401 && host === "api.anthropic.com") {
        const body = Buffer.from(
          JSON.stringify({
            type: "error",
            error: {
              type: "authentication_error",
              message:
                "[claude-share] The sharer's Anthropic token is invalid or expired. ",
            },
          }),
        );
        const respHeaders = ctx.serverToProxyResponse.headers;
        if (respHeaders) {
          respHeaders["content-length"] = String(body.length);
          delete respHeaders["content-encoding"];
          delete respHeaders["transfer-encoding"];
        }
        ctx.addResponseFilter(
          new Transform({
            transform(_chunk, _enc, done) {
              done(); // discard original 401 body
            },
            flush(done) {
              this.push(body);
              done();
            },
          }),
        );
      }

      // Dev recorder: capture the non-message API calls (usage, profile,
      // models, telemetry, …) with full request/response. Messages are excluded
      // here and handled by the opt-in path in the token block below.
      // Scoped to api.anthropic.com only — never the platform.* OAuth hosts,
      // whose responses can carry raw tokens/auth codes.
      const recPath = ctx.clientToProxyRequest?.url ?? "/";
      if (
        isRecording() &&
        host === "api.anthropic.com" &&
        !recPath.startsWith("/v1/messages")
      ) {
        const recEnc = (ctx.serverToProxyResponse?.headers?.["content-encoding"] ?? "") as string;
        const recChunks: Buffer[] = [];
        ctx.addResponseFilter(
          new Transform({
            transform(chunk, _enc, done) {
              recChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
              this.push(chunk);
              done();
            },
            flush(done) {
              const raw = Buffer.concat(recChunks);
              let resBody: string;
              try {
                if (recEnc === "gzip") resBody = zlib.gunzipSync(raw).toString("utf8");
                else if (recEnc === "deflate") resBody = zlib.inflateSync(raw).toString("utf8");
                else if (recEnc === "br") resBody = zlib.brotliDecompressSync(raw).toString("utf8");
                else resBody = raw.toString("utf8");
              } catch {
                resBody = raw.toString("utf8");
              }
              saveFlow({
                id: Math.random().toString(36).slice(2, 10),
                ts: Date.now(),
                machineId: ctx[CTX_MACHINE_ID],
                method: ctx.clientToProxyRequest?.method ?? "GET",
                path: recPath,
                model: "",
                status,
                reqBody: ctx[CTX_REQUEST_BODY] ?? "",
                resBody,
              });
              done();
            },
          }),
        );
      }

      // Strip any response headers that could leak the sharer's credentials
      const respHeaders = ctx.serverToProxyResponse.headers;
      if (respHeaders) {
        delete respHeaders["authorization"];
        delete respHeaders["set-cookie"];
        delete respHeaders["x-api-key"];
        delete respHeaders["anthropic-organization-id"];
      }

      // Sniff token usage from /v1/messages responses
      const machineId: string | undefined = ctx[CTX_MACHINE_ID];
      const reqPath = ctx.clientToProxyRequest?.url ?? "";
      const isMessages =
        machineId &&
        status === 200 &&
        (ctx.clientToProxyRequest?.headers?.host ?? "").split(":")[0] === "api.anthropic.com" &&
        reqPath.startsWith("/v1/messages");

      if (isMessages) {
        const encoding = (ctx.serverToProxyResponse?.headers?.["content-encoding"] ?? "") as string;
        const chunks: Buffer[] = [];
        ctx.addResponseFilter(
          new Transform({
            transform(chunk, _enc, done) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
              this.push(chunk);
              done();
            },
            flush(done) {
              const raw = Buffer.concat(chunks);
              const decode = (buf: Buffer): string => {
                try {
                  if (encoding === "gzip") return zlib.gunzipSync(buf).toString("utf8");
                  if (encoding === "deflate") return zlib.inflateSync(buf).toString("utf8");
                  if (encoding === "br") return zlib.brotliDecompressSync(buf).toString("utf8");
                } catch {}
                return buf.toString("utf8");
              };
              const body = decode(raw);
              const inps = [...body.matchAll(/"input_tokens"\s*:\s*(\d+)/g)].map(m => m[1]);
              const outs = [...body.matchAll(/"output_tokens"\s*:\s*(\d+)/g)].map(m => m[1]);
              const caches = [...body.matchAll(/"cache_read_input_tokens"\s*:\s*(\d+)/g)].map(m => m[1]);
              const cacheWrites = [...body.matchAll(/"cache_creation_input_tokens"\s*:\s*(\d+)/g)].map(m => m[1]);

              const inp = inps.length > 0 ? parseInt(inps[inps.length - 1], 10) : 0;
              const out = outs.length > 0 ? parseInt(outs[outs.length - 1], 10) : 0;
              const cache = caches.length > 0 ? parseInt(caches[caches.length - 1], 10) : 0;
              const cacheWrite = cacheWrites.length > 0 ? parseInt(cacheWrites[cacheWrites.length - 1], 10) : 0;

              // The model actually served appears in the message_start event.
              const modelMatch = body.match(/"model"\s*:\s*"([^"]+)"/);
              const model = modelMatch ? modelMatch[1] : "unknown";

              if (inp > 0 || out > 0) {
                recordTokens(machineId!, inp, out, cache, cacheWrite);
                recordUsageEvent({
                  ts: Date.now(),
                  machineId: machineId!,
                  model,
                  input: inp,
                  output: out,
                  cacheRead: cache,
                  cacheWrite,
                });
              }

              // Dev recorder: message flows carry prompts, so only record them
              // when the user explicitly opts in (Include messages).
              if (isRecording() && isIncludingMessages()) {
                const betaHeader = ctx.clientToProxyRequest?.headers?.["anthropic-beta"];
                saveFlow({
                  id: Math.random().toString(36).slice(2, 10),
                  ts: Date.now(),
                  machineId,
                  method: "POST",
                  path: reqPath,
                  model,
                  status,
                  beta: typeof betaHeader === "string" ? betaHeader : undefined,
                  reqBody: ctx[CTX_REQUEST_BODY] ?? "",
                  resBody: body,
                });
              }
              done();
            },
          }),
        );
      }

      callback();
    });

    proxy.onConnect(
      (req: any, socket: any, head: any, callback: () => void) => {
        const connectAuth = req.headers["proxy-authorization"] ?? "";
        if (!checkAuth(connectAuth)) {
          // Surface rejected tunnels on the dashboard — otherwise a receiver with
          // a stale/invalid proxyPass (407) fails completely invisibly, since
          // logRequest normally only runs after CONNECT is authorized.
          const target = ((req.url as string) ?? "").split(":")[0] || "unknown";
          const id = logRequest("CONNECT", target, "(proxy auth rejected)", "blocked");
          setResponseStatus(id, 407);
          socket.write(
            "HTTP/1.1 407 Proxy Authentication Required\r\n" +
              'Proxy-Authenticate: Basic realm="claude-share"\r\n' +
              "Content-Length: 0\r\n" +
              "\r\n",
          );
          socket.destroy();
          return;
        }

        // Resolve and store machineId for this tunnel
        const session = getSession?.();
        if (session) {
          const mid = resolveMachineId(session, connectAuth);
          if (mid) socketMachineId.set(socket, mid);
        }

        const [hostname, portStr] = ((req.url as string) ?? "").split(":");
        if (INTERCEPT_DOMAINS.has(hostname)) {
          callback();
          return;
        }
        // Non-Anthropic domain: transparent TCP tunnel — no cert, no decryption.
        // The client's TLS handshake goes straight to the real server.
        const port = parseInt(portStr, 10) || 443;
        socket.setNoDelay(true);
        const upstream = net.connect(port, hostname, () => {
          upstream.setNoDelay(true);
          socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
          if (head?.length) upstream.write(head);
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        upstream.on("error", () => socket.destroy());
        socket.on("error", () => upstream.destroy());
      },
    );

    // Listen on a random localhost port — CA generation completes before callback fires.
    // keepAlive reuses the TLS connection to api.anthropic.com across requests instead of
    // renegotiating a fresh handshake every message (http-mitm-proxy defaults this to false).
    proxy.listen(
      { port: 0, host: "127.0.0.1", sslCaDir, keepAlive: true },
      (err?: Error | null) => {
        if (err) return reject(err);

        (async () => {
          proxyPort = (proxy as any).httpServer.address().port;
          proxyReady = true;
          const caCertPem = fs.readFileSync(
            path.join(sslCaDir, "certs", "ca.pem"),
            "utf8",
          );
          const caKeyPem = fs.readFileSync(
            path.join(sslCaDir, "keys", "ca.private.key"),
            "utf8",
          );
          const serverCert = await generateServerCert(
            caCertPem,
            caKeyPem,
            lanIp,
            publicHostname,
          );

          for (const s of pendingSockets) pipeToProxy(s);
          pendingSockets.length = 0;

          resolve({
            caCertPem,
            serverCert,
            handleSocket(socket) {
              if (proxyReady) {
                pipeToProxy(socket);
              } else {
                pendingSockets.push(socket);
              }
            },
            close() {
              proxy.close();
              fs.rm(sslCaDir, { recursive: true, force: true }, () => {});
            },
          });
        })().catch(reject);
      },
    );

    function pipeToProxy(socket: net.Socket) {
      const upstream = net.connect(proxyPort, "127.0.0.1");
      socket.setNoDelay(true);
      upstream.setNoDelay(true);
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
    }
  });
}
