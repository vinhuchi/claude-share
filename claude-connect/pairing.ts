import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

import { fromBase58 } from "@shared/base58";
import type { ConnectionFile } from "./types";

export function decryptBlob(blob: string, pairingCode: string): ConnectionFile {
  // Pairing code is the full 32-byte session key encoded in base58
  const codeBytes = fromBase58(pairingCode);
  if (codeBytes.length < 32) throw new Error("Pairing code too short");
  const key = codeBytes.slice(0, 32);

  const nonceHex = blob.slice(0, 48);
  const ctHex = blob.slice(48);
  const nonce = Uint8Array.from(Buffer.from(nonceHex, "hex"));
  const ciphertext = Uint8Array.from(Buffer.from(ctHex, "hex"));

  const cipher = xchacha20poly1305(key, nonce);
  const plaintext = cipher.decrypt(ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext)) as ConnectionFile;
}

// Format: claudeshare://host:port/connect/<pairingCode>  (or https:// for backwards compat)
// The server does not need to handle this path — it's parsed client-side only.
export function parseConnectUrl(
  url: string,
): { serverUrl: string; pairingCode: string } | null {
  if (!/^(claudeshare|https):\/\//.test(url)) return null;
  const normalised = url.replace(/^claudeshare:\/\//, "https://");
  // Tolerate an optional trailing slash and ignore any query string / hash.
  const match = normalised.match(
    /^(https:\/\/.+?)\/connect\/([A-Za-z0-9]+)\/?(?:[?#].*)?$/,
  );
  if (!match) return null;
  return { serverUrl: match[1], pairingCode: match[2] };
}
