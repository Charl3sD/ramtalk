// Minimal binary reader/writer used by the pairing payload codec.

export class ByteWriter {
  private buf = new Uint8Array(256);
  private len = 0;

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new RangeError(`u8 out of range: ${v}`);
    this.ensure(1);
    this.buf[this.len++] = v;
    return this;
  }

  u16(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new RangeError(`u16 out of range: ${v}`);
    this.ensure(2);
    this.buf[this.len++] = v >>> 8;
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  u32(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new RangeError(`u32 out of range: ${v}`);
    this.ensure(4);
    new DataView(this.buf.buffer).setUint32(this.len, v);
    this.len += 4;
    return this;
  }

  bytes(b: Uint8Array<ArrayBuffer>): this {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }

  /** Length-prefixed (u8) ASCII string. */
  str8(s: string): this {
    const b = new TextEncoder().encode(s);
    if (b.length > 0xff) throw new RangeError('string too long');
    return this.u8(b.length).bytes(b);
  }

  finish(): Uint8Array<ArrayBuffer> {
    return this.buf.slice(0, this.len);
  }
}

export class ByteReader {
  private off = 0;
  constructor(private readonly buf: Uint8Array<ArrayBuffer>) {}

  private need(n: number): void {
    if (this.off + n > this.buf.length) throw new RangeError('payload truncated');
  }

  u8(): number {
    this.need(1);
    return this.buf[this.off++]!;
  }

  u16(): number {
    this.need(2);
    const v = (this.buf[this.off]! << 8) | this.buf[this.off + 1]!;
    this.off += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = new DataView(this.buf.buffer, this.buf.byteOffset).getUint32(this.off);
    this.off += 4;
    return v;
  }

  bytes(n: number): Uint8Array<ArrayBuffer> {
    this.need(n);
    const out = this.buf.slice(this.off, this.off + n);
    this.off += n;
    return out;
  }

  str8(): string {
    const n = this.u8();
    return new TextDecoder('utf-8', { fatal: true }).decode(this.bytes(n));
  }

  get remaining(): number {
    return this.buf.length - this.off;
  }
}

export function toHex(b: Uint8Array<ArrayBuffer>): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function fromHex(s: string): Uint8Array<ArrayBuffer> {
  if (s.length % 2 !== 0 || /[^0-9a-f]/i.test(s)) throw new Error('invalid hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concatBytes(...parts: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
