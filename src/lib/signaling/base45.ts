// RFC 9285 Base45. Its alphabet is exactly the QR "alphanumeric" character set, so a
// base45 string can be encoded in a QR code's alphanumeric mode (5.5 bits/char), which is
// denser than base64 in byte mode and survives scanners that return text.

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const LOOKUP = new Map<string, number>([...ALPHABET].map((c, i) => [c, i]));

export function base45Encode(bytes: Uint8Array<ArrayBuffer>): string {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    let n = bytes[i]! * 256 + bytes[i + 1]!;
    const c = n % 45;
    n = (n - c) / 45;
    const d = n % 45;
    const e = (n - d) / 45;
    out += ALPHABET[c]! + ALPHABET[d]! + ALPHABET[e]!;
  }
  if (bytes.length % 2 === 1) {
    const n = bytes[bytes.length - 1]!;
    out += ALPHABET[n % 45]! + ALPHABET[Math.floor(n / 45)]!;
  }
  return out;
}

export function base45Decode(text: string): Uint8Array<ArrayBuffer> {
  if (text.length % 3 === 1) throw new Error('invalid base45 length');
  const out = new Uint8Array(Math.floor(text.length / 3) * 2 + (text.length % 3 === 2 ? 1 : 0));
  let o = 0;
  const val = (ch: string): number => {
    const v = LOOKUP.get(ch);
    if (v === undefined) throw new Error('invalid base45 character');
    return v;
  };
  for (let i = 0; i < text.length; i += 3) {
    if (i + 2 < text.length) {
      const n = val(text[i]!) + val(text[i + 1]!) * 45 + val(text[i + 2]!) * 45 * 45;
      if (n > 0xffff) throw new Error('invalid base45 triplet');
      out[o++] = n >> 8;
      out[o++] = n & 0xff;
    } else {
      const n = val(text[i]!) + val(text[i + 1]!) * 45;
      if (n > 0xff) throw new Error('invalid base45 pair');
      out[o++] = n;
    }
  }
  return out;
}
