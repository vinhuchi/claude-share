import net from "node:net";

import { logger } from "../logger";

type Handler = (socket: net.Socket) => void;

interface PortDetectorOptions {
  onConnect: Handler; // HTTP CONNECT (proxy traffic)
  onHttp: Handler; // plain HTTP (API server traffic)
  onTls: Handler; // TLS ClientHello (HTTPS API traffic)
}

/**
 * Creates a single TCP server that routes connections by sniffing the first bytes.
 * CONNECT → MITM proxy; TLS ClientHello → HTTPS API; plain HTTP → HTTP API.
 */
export function createPortDetector(options: PortDetectorOptions): net.Server {
  return net.createServer((socket) => {
    // A client that completes the TCP handshake but never sends its first bytes
    // (port scanners, half-open/dead receiver sockets, slow-loris) would pin an
    // FD forever, since routing only happens on the "data" event. On a public
    // bore.pub tunnel this is constant background traffic — enough of it and the
    // server can no longer accept() while the process still looks "online".
    // Drop such sockets after 15s. Cleared as soon as we route a real client.
    const firstByteTimer = setTimeout(() => {
      logger.warn("[detector] no first bytes within 15s — dropping idle socket");
      socket.destroy();
    }, 15_000);
    firstByteTimer.unref?.();

    socket.once("data", (chunk) => {
      clearTimeout(firstByteTimer);
      // HTTP CONNECT starts with "CONNECT "
      const isConnect = chunk.slice(0, 8).toString("ascii").toUpperCase().startsWith("CONNECT");
      // TLS ClientHello starts with 0x16 (content type: handshake)
      const isTls = !isConnect && chunk[0] === 0x16;

      const handler = isConnect ? options.onConnect : isTls ? options.onTls : options.onHttp;
      socket.unshift(chunk);
      handler(socket);
    });

    socket.on("close", () => clearTimeout(firstByteTimer));

    socket.on("error", (err) => {
      clearTimeout(firstByteTimer);
      if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
        logger.error("[detector] socket error", err);
      }
      socket.destroy(); // guarantee the FD is released on any error
    });
  });
}

