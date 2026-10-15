import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bytesToIpv6,
  expandSdp,
  ipv6ToBytes,
  MAX_CANDIDATES,
  parseCandidate,
  summarizeSdp,
} from '../../src/lib/signaling/sdp';

const dir = new URL('../fixtures/sdp/', import.meta.url);
const fixtures = readdirSync(dir).filter((f) => f.endsWith('.sdp'));
const load = (f: string) => readFileSync(new URL(f, dir), 'utf8');

describe('summarizeSdp / expandSdp', () => {
  it('has fixtures from at least two browsers', () => {
    expect(fixtures.some((f) => f.startsWith('chrome'))).toBe(true);
    expect(fixtures.some((f) => f.startsWith('firefox'))).toBe(true);
  });

  it.each(fixtures)('%s survives summarize → expand → summarize', (f) => {
    const s = summarizeSdp(load(f));
    expect(s.fingerprint).toHaveLength(32);
    expect(s.candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    const again = summarizeSdp(expandSdp(s));
    expect(again).toEqual(s);
  });

  it('keeps offer/answer DTLS roles', () => {
    expect(summarizeSdp(load('chrome-camera-offer.sdp')).setup).toBe('actpass');
    expect(summarizeSdp(load('chrome-camera-answer.sdp')).setup).toBe('active');
    expect(summarizeSdp(load('firefox-camera-answer.sdp')).setup).toBe('active');
  });

  it('extracts raw IPv4 candidates when camera permission is granted (Chrome)', () => {
    const s = summarizeSdp(load('chrome-camera-offer.sdp'));
    expect(s.candidates.length).toBeGreaterThan(0);
    expect(s.candidates.every((c) => /^\d+\.\d+\.\d+\.\d+$/.test(c.address))).toBe(true);
  });

  it('extracts mDNS candidates otherwise', () => {
    const s = summarizeSdp(load('chrome-nocamera-offer.sdp'));
    expect(s.candidates[0]?.address).toMatch(/\.local$/);
  });

  it('reads session-level fingerprint and large max-message-size (Firefox)', () => {
    const s = summarizeSdp(load('firefox-camera-answer.sdp'));
    expect(s.maxMessageSize).toBe(1073741823);
    expect(s.candidates.every((c) => c.port !== 9)).toBe(true); // TCP active candidates dropped
  });

  it('drops TCP and srflx, orders IPv4 → mDNS → IPv6', () => {
    const s = summarizeSdp(load('synthetic-ipv6-offer.sdp'));
    expect(s.candidates.map((c) => c.address)).toEqual([
      '172.20.10.2',
      '0d6f53b2-1d2a-4c55-9a5e-2f2b1c3d4e5f.local',
      '2001:db8:85a3::8a2e:370:7334',
      'fe80::1',
    ]);
  });

  it('caps the number of candidates', () => {
    const base = load('chrome-nocamera-offer.sdp');
    const extra = Array.from({ length: 12 }, (_, i) => `a=candidate:${i} 1 udp 1 10.0.0.${i + 1} ${5000 + i} typ host`).join('\r\n');
    const s = summarizeSdp(base.replace('a=ice-ufrag', `${extra}\r\na=ice-ufrag`));
    expect(s.candidates).toHaveLength(MAX_CANDIDATES);
  });

  it('rejects SDP with media or without a data channel', () => {
    const base = load('chrome-nocamera-offer.sdp');
    expect(() => summarizeSdp(base + 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n')).toThrow();
    expect(() => summarizeSdp(base.replace(/m=application.*\r\n/, ''))).toThrow();
    expect(() => summarizeSdp(base.replace(/a=fingerprint:.*\r\n/, ''))).toThrow();
    expect(() => summarizeSdp(base.replace(/a=ice-pwd:.*\r\n/, 'a=ice-pwd:short\r\n'))).toThrow();
  });
});

describe('parseCandidate', () => {
  it('rejects junk addresses and non-host types', () => {
    expect(parseCandidate('1 1 udp 1 evil.example.com 1234 typ host')).toBeNull();
    expect(parseCandidate('1 1 udp 1 1.2.3.4 1234 typ relay')).toBeNull();
    expect(parseCandidate('1 2 udp 1 1.2.3.4 1234 typ host')).toBeNull();
    expect(parseCandidate('1 1 udp 1 1.2.3.4 0 typ host')).toBeNull();
    expect(parseCandidate('1 1 UDP 1 1.2.3.4 1234 typ host')).toEqual({ address: '1.2.3.4', port: 1234 });
  });
});

describe('IPv6 encoding', () => {
  it.each([
    ['::1', '::1'],
    ['2001:db8::1', '2001:db8::1'],
    ['2001:0db8:0000:0000:0000:0000:0002:0001', '2001:db8::2:1'],
    ['fe80::', 'fe80::'],
    ['1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8'],
    ['1:0:3:4:5:6:7:8', '1:0:3:4:5:6:7:8'],
  ])('%s -> %s', (input, canonical) => {
    expect(bytesToIpv6(ipv6ToBytes(input))).toBe(canonical);
  });

  it.each(['1::2::3', '1:2:3:4:5:6:7:8:9', '12345::', 'g::1', '1:2:3:4:5:6:7::8'])('rejects %s', (bad) => {
    expect(() => ipv6ToBytes(bad)).toThrow();
  });
});
