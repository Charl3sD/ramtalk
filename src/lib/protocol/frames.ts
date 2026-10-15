// Frames exchanged inside the encrypted channel. Everything here comes from the peer and is
// untrusted: decodeFrame validates every field and size before the app sees it.

import { ByteReader, ByteWriter, fromHex, toHex } from '../signaling/bytes';

export const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_NAME_CHARS = 40;
export const MAX_FILENAME_CHARS = 255;
export const ID_BYTES = 16;

export type Frame =
  | { t: 'hello'; name: string; confirm: Uint8Array<ArrayBuffer> }
  | { t: 'text'; id: string; ts: number; md: string }
  | { t: 'file-meta'; id: string; name: string; mime: string; size: number }
  | { t: 'file-chunk'; id: string; idx: number; data: Uint8Array<ArrayBuffer> }
  | { t: 'file-end'; id: string }
  | { t: 'file-cancel'; id: string }
  | { t: 'typing' }
  | { t: 'bye' };

const TYPE = {
  hello: 1,
  text: 2,
  'file-meta': 3,
  'file-chunk': 4,
  'file-end': 5,
  'file-cancel': 6,
  typing: 7,
  bye: 8,
} as const satisfies Record<Frame['t'], number>;

/** Frame bytes added around a file chunk's data. */
export const CHUNK_FRAME_OVERHEAD = 1 + ID_BYTES + 4;

export class FrameError extends Error {}

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

export function newId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(ID_BYTES)));
}

function json(type: number, body: unknown): Uint8Array<ArrayBuffer> {
  return new ByteWriter().u8(type).bytes(enc.encode(JSON.stringify(body))).finish();
}

export function encodeFrame(f: Frame): Uint8Array<ArrayBuffer> {
  switch (f.t) {
    case 'hello':
      return json(TYPE.hello, { name: f.name, confirm: toHex(f.confirm) });
    case 'text':
      return json(TYPE.text, { id: f.id, ts: f.ts, md: f.md });
    case 'file-meta':
      return json(TYPE['file-meta'], { id: f.id, name: f.name, mime: f.mime, size: f.size });
    case 'file-chunk':
      return new ByteWriter().u8(TYPE['file-chunk']).bytes(fromHex(f.id)).u32(f.idx).bytes(f.data).finish();
    case 'file-end':
      return new ByteWriter().u8(TYPE['file-end']).bytes(fromHex(f.id)).finish();
    case 'file-cancel':
      return new ByteWriter().u8(TYPE['file-cancel']).bytes(fromHex(f.id)).finish();
    case 'typing':
      return Uint8Array.of(TYPE.typing);
    case 'bye':
      return Uint8Array.of(TYPE.bye);
  }
}

/** Returns null for unknown frame types (forward compatibility); throws on malformed known ones. */
export function decodeFrame(bytes: Uint8Array<ArrayBuffer>): Frame | null {
  if (bytes.length === 0) throw new FrameError('empty frame');
  const type = bytes[0];
  const body = bytes.subarray(1);
  try {
    switch (type) {
      case TYPE.hello: {
        const o = parseJson(body);
        const name = str(o.name, MAX_NAME_CHARS * 4).trim().slice(0, MAX_NAME_CHARS);
        const confirm = fromHex(str(o.confirm, 64));
        if (confirm.length !== 32) throw new FrameError('bad confirm tag');
        return { t: 'hello', name, confirm };
      }
      case TYPE.text: {
        if (body.length > MAX_TEXT_BYTES + 256) throw new FrameError('text too large');
        const o = parseJson(body);
        const md = str(o.md, MAX_TEXT_BYTES);
        if (enc.encode(md).length > MAX_TEXT_BYTES) throw new FrameError('text too large');
        return { t: 'text', id: id(o.id), ts: num(o.ts), md };
      }
      case TYPE['file-meta']: {
        const o = parseJson(body);
        const size = num(o.size);
        if (!Number.isSafeInteger(size) || size < 0) throw new FrameError('bad size');
        return {
          t: 'file-meta',
          id: id(o.id),
          name: str(o.name, MAX_FILENAME_CHARS * 4),
          mime: str(o.mime, 255),
          size,
        };
      }
      case TYPE['file-chunk']: {
        const r = new ByteReader(body);
        const fid = toHex(r.bytes(ID_BYTES));
        const idx = r.u32();
        return { t: 'file-chunk', id: fid, idx, data: body.subarray(ID_BYTES + 4) };
      }
      case TYPE['file-end']:
      case TYPE['file-cancel']: {
        if (body.length !== ID_BYTES) throw new FrameError('bad id');
        return { t: type === TYPE['file-end'] ? 'file-end' : 'file-cancel', id: toHex(body) };
      }
      case TYPE.typing:
        return { t: 'typing' };
      case TYPE.bye:
        return { t: 'bye' };
      default:
        return null;
    }
  } catch (e) {
    if (e instanceof FrameError) throw e;
    throw new FrameError(`malformed frame: ${(e as Error).message}`);
  }
}

function parseJson(body: Uint8Array<ArrayBuffer>): Record<string, unknown> {
  const v: unknown = JSON.parse(dec.decode(body));
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new FrameError('expected object');
  return v as Record<string, unknown>;
}

function str(v: unknown, max: number): string {
  if (typeof v !== 'string' || v.length > max) throw new FrameError('bad string');
  return v;
}

function num(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new FrameError('bad number');
  return v;
}

function id(v: unknown): string {
  if (typeof v !== 'string' || !/^[0-9a-f]{32}$/.test(v)) throw new FrameError('bad id');
  return v;
}
