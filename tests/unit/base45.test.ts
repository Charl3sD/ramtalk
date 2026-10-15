import { describe, expect, it } from 'vitest';
import { base45Decode, base45Encode } from '../../src/lib/signaling/base45';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('base45 (RFC 9285 vectors)', () => {
  it.each([
    ['AB', 'BB8'],
    ['Hello!!', '%69 VD92EX0'],
    ['base-45', 'UJCLQE7W581'],
    ['ietf!', 'QED8WEX0'],
  ])('%s <-> %s', (plain, encoded) => {
    expect(base45Encode(enc(plain))).toBe(encoded);
    expect(dec(base45Decode(encoded))).toBe(plain);
  });

  it('round-trips arbitrary bytes', () => {
    for (let n = 0; n < 300; n += 7) {
      const b = crypto.getRandomValues(new Uint8Array(n));
      expect(base45Decode(base45Encode(b))).toEqual(b);
    }
  });

  it.each(['GGW', 'A', 'abc', 'ZZZZ', '@@@'])('rejects invalid input %j', (s) => {
    expect(() => base45Decode(s)).toThrow();
  });
});
