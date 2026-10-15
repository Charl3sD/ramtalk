import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decodePayload,
  encodePayload,
  payloadToQrText,
  qrTextToPayloadBytes,
  type PairingPayload,
} from '../../src/lib/signaling/codec';
import { MAX_CANDIDATES, summarizeSdp } from '../../src/lib/signaling/sdp';

const load = (f: string) => readFileSync(new URL(`../fixtures/sdp/${f}`, import.meta.url), 'utf8');
const pub = () => {
  const k = crypto.getRandomValues(new Uint8Array(65));
  k[0] = 0x04;
  return k;
};

function payload(file: string, role: 'offer' | 'answer' = 'offer'): PairingPayload {
  return { role, sessionId: crypto.getRandomValues(new Uint8Array(8)), publicKey: pub(), sdp: summarizeSdp(load(file)) };
}

describe('pairing payload codec', () => {
  it.each([
    'chrome-camera-offer.sdp',
    'chrome-nocamera-answer.sdp',
    'firefox-camera-offer.sdp',
    'firefox-nocamera-answer.sdp',
    'synthetic-ipv6-offer.sdp',
  ])('round-trips %s through bytes and QR text', (f) => {
    const p = payload(f, f.includes('answer') ? 'answer' : 'offer');
    const text = payloadToQrText(encodePayload(p));
    expect(text).toMatch(/^[0-9A-Z $%*+\-./:]+$/);
    expect(decodePayload(qrTextToPayloadBytes(text))).toEqual(p);
  });

  it('stays within the QR size budget in the worst case', () => {
    const p = payload('firefox-camera-offer.sdp');
    p.sdp.ufrag = 'u'.repeat(32);
    p.sdp.pwd = 'p'.repeat(64);
    p.sdp.candidates = Array.from({ length: MAX_CANDIDATES }, (_, i) => ({
      address: `2001:db8:1234:5678:9abc:def0:1234:${(i + 1).toString(16)}`,
      port: 60000 + i,
    }));
    const text = payloadToQrText(encodePayload(p));
    expect(text.length).toBeLessThan(500);
  });

  it('typical payloads are small', () => {
    expect(payloadToQrText(encodePayload(payload('chrome-camera-offer.sdp'))).length).toBeLessThan(300);
  });

  it('rejects foreign or corrupted codes', () => {
    const bytes = encodePayload(payload('chrome-camera-offer.sdp'));
    expect(() => qrTextToPayloadBytes('https://example.com')).toThrow();
    expect(() => decodePayload(bytes.slice(0, bytes.length - 1))).toThrow();
    expect(() => decodePayload(Uint8Array.from([...bytes, 0]))).toThrow();
    const wrongMagic = bytes.slice();
    wrongMagic[0] = 0x00;
    expect(() => decodePayload(wrongMagic)).toThrow(/not a ramtalk code/);
    const badKey = bytes.slice();
    badKey[10] = 0x02;
    expect(() => decodePayload(badKey)).toThrow();
    expect(() => decodePayload(new Uint8Array())).toThrow();
  });

  it('fuzz: random bytes never decode to a crash other than PayloadError', () => {
    for (let i = 0; i < 2000; i++) {
      const b = crypto.getRandomValues(new Uint8Array(Math.floor(Math.random() * 200)));
      b[0] = 0xc1;
      try {
        decodePayload(b);
      } catch (e) {
        expect((e as Error).name).toBe('Error');
        expect((e as Error).constructor.name).toBe('PayloadError');
      }
    }
  });
});
