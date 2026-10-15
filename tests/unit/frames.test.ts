import { describe, expect, it } from 'vitest';
import { decodeFrame, encodeFrame, FrameError, MAX_TEXT_BYTES, newId, type Frame } from '../../src/lib/protocol/frames';

describe('frames', () => {
  const id = newId();
  const frames: Frame[] = [
    { t: 'hello', name: 'Ada', confirm: new Uint8Array(32).fill(7) },
    { t: 'text', id, ts: 1700000000000, md: '**hi** 👋' },
    { t: 'file-meta', id, name: 'cat.jpg', mime: 'image/jpeg', size: 12345 },
    { t: 'file-chunk', id, idx: 42, data: Uint8Array.of(1, 2, 3) },
    { t: 'file-end', id },
    { t: 'file-cancel', id },
    { t: 'typing' },
    { t: 'bye' },
  ];

  it.each(frames)('round-trips $t', (f) => {
    expect(decodeFrame(encodeFrame(f))).toEqual(f);
  });

  it('ignores unknown frame types', () => {
    expect(decodeFrame(Uint8Array.of(200, 1, 2))).toBeNull();
  });

  it.each([
    ['empty', new Uint8Array()],
    ['bad json', Uint8Array.of(2, 0x7b)],
    ['array body', Uint8Array.of(2, ...new TextEncoder().encode('[]'))],
    ['bad id', Uint8Array.of(2, ...new TextEncoder().encode('{"id":"x","ts":1,"md":"a"}'))],
    ['bad size', Uint8Array.of(3, ...new TextEncoder().encode(`{"id":"${'a'.repeat(32)}","name":"a","mime":"b","size":-1}`))],
    ['short chunk', Uint8Array.of(4, 1, 2, 3)],
    ['short end', Uint8Array.of(5, 1, 2)],
    ['bad hello tag', Uint8Array.of(1, ...new TextEncoder().encode('{"name":"a","confirm":"00"}'))],
    ['invalid utf-8', Uint8Array.of(2, 0xff, 0xfe)],
  ])('rejects %s', (_, bytes) => {
    expect(() => decodeFrame(bytes)).toThrow(FrameError);
  });

  it('rejects oversized text', () => {
    const big = encodeFrame({ t: 'text', id, ts: 1, md: 'a'.repeat(MAX_TEXT_BYTES + 1) });
    expect(() => decodeFrame(big)).toThrow(FrameError);
  });

  it('truncates long names', () => {
    const f = decodeFrame(encodeFrame({ t: 'hello', name: '  ' + 'x'.repeat(100), confirm: new Uint8Array(32) }));
    expect(f?.t === 'hello' && f.name.length).toBe(40);
  });
});
