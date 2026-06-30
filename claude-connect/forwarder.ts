import http from "node:http";
import tls from "node:tls";

const ANTHROPIC_HOST = "api.anthropic.com";
const ANTHROPIC_PORT = 443;

/**
 * Outer TLS → CONNECT → inner TLS (MITM intercepts, presents api.anthropic.com cert
 * signed by caPem). Returns a ready TLS socket that speaks plain HTTP/1.1 to the MITM.
 */
function openTunnel(
  proxyHost: string,
  proxyPort: number,
  proxyAuth: string,
  caPem: string,
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const outer = tls.connect({
      host: proxyHost,
      port: proxyPort,
      ca: caPem,
      servername: proxyHost,
      rejectUnauthorized: true,
    });

    outer.once("error", reject);
    outer.once("secureConnect", () => {
      outer.write(
        `CONNECT ${ANTHROPIC_HOST}:${ANTHROPIC_PORT} HTTP/1.1\r\n` +
          `Host: ${ANTHROPIC_HOST}:${ANTHROPIC_PORT}\r\n` +
          `Proxy-Authorization: ${proxyAuth}\r\n\r\n`,
      );

      let buf = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (!buf.includes("\r\n\r\n")) return;
        outer.removeListener("data", onData);

        const str = buf.toString("ascii");
        if (!str.startsWith("HTTP/1.1 200") && !str.startsWith("HTTP/1.0 200")) {
          outer.destroy();
          reject(new Error(`CONNECT failed: ${str.split("\r\n")[0]}`));
          return;
        }

        const inner = tls.connect({
          socket: outer,
          ca: caPem,
          servername: ANTHROPIC_HOST,
          rejectUnauthorized: true,
        });
        inner.once("secureConnect", () => resolve(inner));
        inner.once("error", (err) => { outer.destroy(); reject(err); });
      };
      outer.on("data", onData);
    });
  });
}

/**
 * Starts a local HTTP server on 127.0.0.1 that forwards every request to
 * api.anthropic.com through the sharer's MITM proxy tunnel.
 *
 * Set ANTHROPIC_BASE_URL=http://127.0.0.1:<port> in Open Design (or any app)
 * to route its Anthropic API calls through the sharer.
 */
export function startLocalForwarder(
  proxyUrl: string,
  caPem: string,
): Promise<{ port: number; close: () => void }> {
  const parsed = new URL(proxyUrl);
  const proxyHost = parsed.hostname;
  const proxyPort = parseInt(parsed.port || "443", 10);
  const proxyAuth =
    "Basic " +
    Buffer.from(
      `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`,
    ).toString("base64");

  const server = http.createServer((req, res) => {
    openTunnel(proxyHost, proxyPort, proxyAuth, caPem)
      .then((tunnel) => {
        // Write raw HTTP/1.1 request to the tunnel — avoids http.request
        // createConnection pitfalls that can fall back to a direct plain-HTTP
        // connection to api.anthropic.com:443 (which returns 400).
        let header = `${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1\r\nhost: ${ANTHROPIC_HOST}\r\n`;
        for (const [k, v] of Object.entries(req.headers)) {
          if (k.toLowerCase() === "host") continue;
          header += `${k}: ${Array.isArray(v) ? v.join(", ") : v}\r\n`;
        }
        header += "\r\n";
        tunnel.write(header);
        req.pipe(tunnel, { end: false });

        // Parse response status + headers, then stream the body
        let buf = Buffer.alloc(0);
        let headersDone = false;

        tunnel.on("data", (chunk: Buffer) => {
          if (headersDone) {
            if (!res.writableEnded) res.write(chunk);
            return;
          }
          buf = Buffer.concat([buf, chunk]);
          const end = buf.indexOf("\r\n\r\n");
          if (end === -1) return;

          headersDone = true;
          const headerStr = buf.slice(0, end).toString("latin1");
          const lines = headerStr.split("\r\n");
          const statusCode = parseInt(lines[0].split(" ")[1] ?? "200", 10);
          const resHeaders: Record<string, string> = {};
          for (const line of lines.slice(1)) {
            const i = line.indexOf(":");
            if (i === -1) continue;
            resHeaders[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
          }

          res.writeHead(statusCode, resHeaders);
          const body = buf.slice(end + 4);
          if (body.length > 0 && !res.writableEnded) res.write(body);
        });

        tunnel.on("end", () => { if (!res.writableEnded) res.end(); });
        tunnel.on("error", () => {
          if (!res.headersSent) res.writeHead(502).end();
          else if (!res.writableEnded) res.end();
        });
        req.on("close", () => tunnel.destroy());
      })
      .catch((err: Error) => {
        if (!res.headersSent) res.writeHead(502).end(err.message);
      });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ port, close: () => server.close() });
    });
  });
}
