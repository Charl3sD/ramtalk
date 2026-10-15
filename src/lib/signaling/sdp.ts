// A full browser SDP is 1–3 KB, too big for a reliably scannable QR code. For a data-channel-only
// session over a local link, the only per-session facts the remote side needs are the ICE
// credentials, the DTLS certificate fingerprint and role, the SCTP parameters and the host
// candidates. `summarizeSdp` extracts those and `expandSdp` rebuilds a canonical SDP from them.

export type DtlsSetup = 'actpass' | 'active' | 'passive';

export interface HostCandidate {
  /** IPv4 dotted quad, IPv6 address, or an mDNS `<uuid>.local` hostname. */
  address: string;
  port: number;
}

export interface SdpSummary {
  mid: string;
  ufrag: string;
  pwd: string;
  /** Raw SHA-256 DTLS certificate fingerprint (32 bytes). */
  fingerprint: Uint8Array<ArrayBuffer>;
  setup: DtlsSetup;
  sctpPort: number;
  /** The largest message this endpoint can receive (RFC 8841; 0 = unlimited). */
  maxMessageSize: number;
  candidates: HostCandidate[];
}

/** Hard cap so the QR stays small; phones often report several IPv6 addresses. */
export const MAX_CANDIDATES = 6;
/** RFC 8841 default when the attribute is absent. */
const DEFAULT_MAX_MESSAGE_SIZE = 65536;

const ICE_UFRAG = /^[A-Za-z0-9+/]{4,256}$/;
const ICE_PWD = /^[A-Za-z0-9+/]{22,256}$/;
const MID = /^[A-Za-z0-9_.-]{1,32}$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const MDNS = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.local$/i;

export class SdpError extends Error {}

export function summarizeSdp(sdp: string): SdpSummary {
  const lines = sdp.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const mLines = lines.filter((l) => l.startsWith('m='));
  if (mLines.length !== 1 || !/^m=application \d+ UDP\/DTLS\/SCTP webrtc-datachannel$/.test(mLines[0]!)) {
    throw new SdpError('expected exactly one data-channel m-line');
  }

  const attr = (name: string): string | undefined => {
    const prefix = `a=${name}:`;
    return lines.find((l) => l.startsWith(prefix))?.slice(prefix.length).trim();
  };

  const ufrag = attr('ice-ufrag');
  const pwd = attr('ice-pwd');
  const mid = attr('mid');
  const setup = attr('setup');
  if (!ufrag || !ICE_UFRAG.test(ufrag)) throw new SdpError('missing or invalid ice-ufrag');
  if (!pwd || !ICE_PWD.test(pwd)) throw new SdpError('missing or invalid ice-pwd');
  if (!mid || !MID.test(mid)) throw new SdpError('missing or invalid mid');
  if (setup !== 'actpass' && setup !== 'active' && setup !== 'passive') throw new SdpError('invalid setup');

  const fpLine = lines
    .filter((l) => l.startsWith('a=fingerprint:'))
    .map((l) => l.slice('a=fingerprint:'.length).trim().split(/\s+/))
    .find(([alg]) => alg?.toLowerCase() === 'sha-256');
  if (!fpLine?.[1]) throw new SdpError('missing sha-256 fingerprint');
  const fingerprint = parseFingerprint(fpLine[1]);

  const sctpPort = Number(attr('sctp-port') ?? 5000);
  if (!Number.isInteger(sctpPort) || sctpPort < 1 || sctpPort > 65535) throw new SdpError('invalid sctp-port');
  const mmsRaw = attr('max-message-size');
  const maxMessageSize = mmsRaw === undefined ? DEFAULT_MAX_MESSAGE_SIZE : Number(mmsRaw);
  if (!Number.isInteger(maxMessageSize) || maxMessageSize < 0 || maxMessageSize > 0xffffffff) {
    throw new SdpError('invalid max-message-size');
  }

  const seen = new Set<string>();
  const candidates: HostCandidate[] = [];
  for (const line of lines) {
    if (!line.startsWith('a=candidate:')) continue;
    const c = parseCandidate(line.slice('a=candidate:'.length));
    if (!c) continue;
    const key = `${c.address.toLowerCase()}|${c.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(c);
  }
  // Raw IPv4 first (most reliable on a hotspot), then mDNS names, then IPv6.
  const rank = (c: HostCandidate): number => (IPV4.test(c.address) ? 0 : MDNS.test(c.address) ? 1 : 2);
  candidates.sort((a, b) => rank(a) - rank(b));

  return {
    mid,
    ufrag,
    pwd,
    fingerprint,
    setup,
    sctpPort,
    maxMessageSize,
    candidates: candidates.slice(0, MAX_CANDIDATES),
  };
}

/** Parses the body of an `a=candidate:` line; returns only UDP host candidates on component 1. */
export function parseCandidate(body: string): HostCandidate | null {
  const t = body.trim().split(/\s+/);
  if (t.length < 8 || t[6] !== 'typ') return null;
  const [, component, transport, , address, portStr, , type] = t;
  if (component !== '1' || transport?.toLowerCase() !== 'udp' || type !== 'host') return null;
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !address) return null;
  if (!IPV4.test(address) && !MDNS.test(address) && !isIpv6(address)) return null;
  return { address, port };
}

export function expandSdp(s: SdpSummary): string {
  const sessId = crypto.getRandomValues(new Uint32Array(2));
  const sessionId = (BigInt(sessId[0]! & 0x3fffffff) << 32n) | BigInt(sessId[1]!);
  const lines = [
    'v=0',
    `o=- ${sessionId} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    `a=group:BUNDLE ${s.mid}`,
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    ...s.candidates.map(
      (c, i) => `a=candidate:${i + 1} 1 udp ${hostPriority(i)} ${c.address} ${c.port} typ host`,
    ),
    'a=end-of-candidates',
    `a=ice-ufrag:${s.ufrag}`,
    `a=ice-pwd:${s.pwd}`,
    `a=fingerprint:sha-256 ${formatFingerprint(s.fingerprint)}`,
    `a=setup:${s.setup}`,
    `a=mid:${s.mid}`,
    `a=sctp-port:${s.sctpPort}`,
    `a=max-message-size:${s.maxMessageSize}`,
  ];
  return lines.join('\r\n') + '\r\n';
}

/** RFC 8445 §5.1.2.1 priority for a host candidate; earlier candidates are preferred. */
function hostPriority(index: number): number {
  return 126 * 2 ** 24 + (65535 - index) * 2 ** 8 + 255;
}

export function parseFingerprint(text: string): Uint8Array<ArrayBuffer> {
  const parts = text.split(':');
  if (parts.length !== 32 || parts.some((p) => !/^[0-9a-f]{2}$/i.test(p))) {
    throw new SdpError('invalid sha-256 fingerprint');
  }
  return Uint8Array.from(parts, (p) => parseInt(p, 16));
}

export function formatFingerprint(fp: Uint8Array<ArrayBuffer>): string {
  return Array.from(fp, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(':');
}

// ---- address helpers (shared with the binary codec) ----

export function isIpv4(a: string): boolean {
  return IPV4.test(a);
}

export function isMdns(a: string): boolean {
  return MDNS.test(a);
}

export function isIpv6(a: string): boolean {
  try {
    ipv6ToBytes(a);
    return true;
  } catch {
    return false;
  }
}

export function ipv4ToBytes(a: string): Uint8Array<ArrayBuffer> {
  if (!IPV4.test(a)) throw new SdpError('invalid IPv4 address');
  return Uint8Array.from(a.split('.'), Number);
}

export function bytesToIpv4(b: Uint8Array<ArrayBuffer>): string {
  return Array.from(b).join('.');
}

export function ipv6ToBytes(a: string): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-f:]+$/i.test(a) || a.length > 39) throw new SdpError('invalid IPv6 address');
  const halves = a.split('::');
  if (halves.length > 2) throw new SdpError('invalid IPv6 address');
  const parse = (s: string): number[] => (s === '' ? [] : s.split(':').map((g) => {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) throw new SdpError('invalid IPv6 group');
    return parseInt(g, 16);
  }));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) throw new SdpError('invalid IPv6 address');
  const groups = [...head, ...new Array<number>(halves.length === 2 ? fill : 0).fill(0), ...tail];
  const out = new Uint8Array(16);
  groups.forEach((g, i) => {
    out[i * 2] = g >> 8;
    out[i * 2 + 1] = g & 0xff;
  });
  return out;
}

export function bytesToIpv6(b: Uint8Array<ArrayBuffer>): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((b[i]! << 8) | b[i + 1]!);
  // Compress the longest run (length >= 2) of zero groups per RFC 5952.
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart < 0) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
}
