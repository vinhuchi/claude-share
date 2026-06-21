const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function toBase58(bytes: Uint8Array): string {
  let num = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  const result: string[] = [];
  while (num > 0n) {
    result.push(ALPHABET[Number(num % 58n)]);
    num /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    result.push(ALPHABET[0]);
  }
  return result.reverse().join("");
}

export function fromBase58(str: string): Uint8Array {
  let num = 0n;
  for (const char of str) {
    const idx = ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base58 character: ${char}`);
    num = num * 58n + BigInt(idx);
  }
  // Each leading '1' encodes a leading 0x00 byte (standard base58).
  let leadingZeros = 0;
  for (const char of str) {
    if (char !== ALPHABET[0]) break;
    leadingZeros++;
  }
  let hex = num.toString(16);
  if (hex.length % 2 !== 0) hex = "0" + hex; // Buffer.from truncates odd-length hex
  const body = num > 0n ? Buffer.from(hex, "hex") : Buffer.alloc(0);
  return Uint8Array.from(Buffer.concat([Buffer.alloc(leadingZeros), body]));
}
