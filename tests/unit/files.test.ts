import { describe, expect, it } from 'vitest';
import {
  blobTypeFor,
  chunkSizeFor,
  FileLimitError,
  IncomingFiles,
  MAX_FILE_BYTES,
  MAX_TOTAL_INCOMING_BYTES,
  sanitizeFilename,
  sanitizeMime,
} from '../../src/lib/protocol/files';
import { newId } from '../../src/lib/protocol/frames';
import { SEAL_OVERHEAD } from '../../src/lib/crypto/session';

describe('chunkSizeFor', () => {
  it('keeps sealed frames within the peer limit', () => {
    expect(chunkSizeFor(65536) + SEAL_OVERHEAD + 21).toBe(65536);
    expect(chunkSizeFor(16384) + SEAL_OVERHEAD + 21).toBe(16384);
    expect(chunkSizeFor(1073741823)).toBe(chunkSizeFor(65536));
    expect(chunkSizeFor(0)).toBe(chunkSizeFor(65536));
  });
});

describe('sanitizeFilename', () => {
  it.each([
    ['../../etc/passwd', '_.._etc_passwd'],
    ['..\\..\\boot.ini', '_.._boot.ini'],
    ['report.pdf', 'report.pdf'],
    ['  .hidden', 'hidden'],
    ['a‮txt.exe', 'a_txt.exe'],
    ['con:tro\u0000l?.txt', 'con_tro_l_.txt'],
    ['', 'file'],
    ['...', 'file'],
  ])('%j -> %j', (input, out) => {
    expect(sanitizeFilename(input)).toBe(out);
  });

  it('caps length but keeps the extension', () => {
    const n = sanitizeFilename('x'.repeat(400) + '.jpeg');
    expect(n.length).toBe(255);
    expect(n.endsWith('.jpeg')).toBe(true);
  });
});

describe('MIME handling', () => {
  it('normalizes or replaces bad MIME types', () => {
    expect(sanitizeMime('Image/PNG')).toBe('image/png');
    expect(sanitizeMime('text/html; charset=utf-8')).toBe('application/octet-stream');
    expect(sanitizeMime('')).toBe('application/octet-stream');
  });

  it('only allowlisted images keep their type in memory', () => {
    expect(blobTypeFor('image/png')).toBe('image/png');
    expect(blobTypeFor('image/svg+xml')).toBe('application/octet-stream');
    expect(blobTypeFor('text/html')).toBe('application/octet-stream');
  });
});

describe('IncomingFiles', () => {
  it('reassembles chunks in order', async () => {
    const inc = new IncomingFiles();
    const id = newId();
    expect(inc.start(id, 'a.txt', 'text/plain', 6)).toEqual({ name: 'a.txt', mime: 'text/plain' });
    expect(inc.chunk(id, 0, new TextEncoder().encode('abc'))).toBe(3);
    expect(inc.chunk(id, 1, new TextEncoder().encode('def'))).toBe(6);
    const r = inc.finish(id)!;
    expect(await r.blob.text()).toBe('abcdef');
    expect(r.blob.type).toBe('application/octet-stream');
    expect(inc.has(id)).toBe(false);
  });

  it('rejects out-of-order and oversized data', () => {
    const inc = new IncomingFiles();
    const id = newId();
    inc.start(id, 'a', 'x/y', 4);
    expect(() => inc.chunk(id, 1, new Uint8Array(1))).toThrow(FileLimitError);
    inc.chunk(id, 0, new Uint8Array(4));
    expect(() => inc.chunk(id, 1, new Uint8Array(1))).toThrow(/larger than announced/);
  });

  it('rejects files that end early', () => {
    const inc = new IncomingFiles();
    const id = newId();
    inc.start(id, 'a', 'x/y', 4);
    inc.chunk(id, 0, new Uint8Array(2));
    expect(() => inc.finish(id)).toThrow(/ended early/);
  });

  it('enforces per-file, total and duplicate limits', () => {
    const inc = new IncomingFiles();
    expect(() => inc.start(newId(), 'a', 'x/y', MAX_FILE_BYTES + 1)).toThrow(FileLimitError);
    const ids = [newId(), newId(), newId()];
    inc.start(ids[0]!, 'a', 'x/y', MAX_FILE_BYTES);
    inc.start(ids[1]!, 'a', 'x/y', MAX_FILE_BYTES);
    expect(() => inc.start(ids[2]!, 'a', 'x/y', MAX_TOTAL_INCOMING_BYTES - 2 * MAX_FILE_BYTES + 1)).toThrow(/not enough room/);
    expect(() => inc.start(ids[0]!, 'a', 'x/y', 1)).toThrow(/duplicate/);
    inc.cancel(ids[1]!); // releases its reservation
    inc.start(ids[2]!, 'a', 'x/y', MAX_FILE_BYTES);
  });

  it('ignores chunks for unknown/cancelled files', () => {
    const inc = new IncomingFiles();
    const id = newId();
    inc.start(id, 'a', 'x/y', 4);
    inc.cancel(id);
    expect(inc.chunk(id, 0, new Uint8Array(1))).toBeNull();
    expect(inc.finish(id)).toBeNull();
  });

  it('handles empty files', async () => {
    const inc = new IncomingFiles();
    const id = newId();
    inc.start(id, 'empty', 'x/y', 0);
    expect((await inc.finish(id)!.blob.arrayBuffer()).byteLength).toBe(0);
  });
});
