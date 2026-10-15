// Pairing payload carried by the two QR codes (offer: host → joiner, answer: joiner → host).
//
//   u8  magic/version (0xC1)
//   u8  role           0 = offer, 1 = answer
//   8B  sessionId      chosen by the host; the answer echoes it
//   65B publicKey      uncompressed P-256 ECDH public key (ephemeral, per session)
//   str mid, str ufrag, str pwd
//   32B DTLS sha-256 fingerprint
//   u8  setup          0 actpass, 1 active, 2 passive
//   u16 sctpPort, u32 maxMessageSize
//   u8  candidate count, then per candidate: u8 kind (4 ipv4 / 6 ipv6 / 1 mdns uuid) + addr + u16 port
//
// The raw bytes (not the base45 text) feed the key-exchange transcript.

import { base45Decode, base45Encode } from './base45';
import { ByteReader, ByteWriter, fromHex, toHex } from './bytes';
import {
  bytesToIpv4,
  bytesToIpv6,
  ipv4ToBytes,
  ipv6ToBytes,
  isIpv4,
  isMdns,
  MAX_CANDIDATES,
  type DtlsSetup,
  type HostCandidate,
  type SdpSummary,
} from './sdp';

export const PAYLOAD_MAGIC = 0xc1;
export const SESSION_ID_LEN = 8;
export const PUBLIC_KEY_LEN = 65;

export type PairingRole = 'offer' | 'answer';

export interface PairingPayload {
  role: PairingRole;
  sessionId: Uint8Array<ArrayBuffer>;
  publicKey: Uint8Array<ArrayBuffer>;
  sdp: SdpSummary;
}

export class PayloadError extends Error {}

const SETUPS: DtlsSetup[] = ['actpass', 'active', 'passive'];
const KIND_MDNS = 1;
const KIND_IPV4 = 4;
const KIND_IPV6 = 6;

export function encodePayload(p: PairingPayload): Uint8Array<ArrayBuffer> {
  if (p.sessionId.length !== SESSION_ID_LEN) throw new PayloadError('bad session id length');
  if (p.publicKey.length !== PUBLIC_KEY_LEN || p.publicKey[0] !== 0x04) throw new PayloadError('bad public key');
  if (p.sdp.fingerprint.length !== 32) throw new PayloadError('bad fingerprint length');

  const w = new ByteWriter()
    .u8(PAYLOAD_MAGIC)
    .u8(p.role === 'offer' ? 0 : 1)
    .bytes(p.sessionId)
    .bytes(p.publicKey)
    .str8(p.sdp.mid)
    .str8(p.sdp.ufrag)
    .str8(p.sdp.pwd)
    .bytes(p.sdp.fingerprint)
    .u8(SETUPS.indexOf(p.sdp.setup))
    .u16(p.sdp.sctpPort)
    .u32(p.sdp.maxMessageSize);

  const cands = p.sdp.candidates.slice(0, MAX_CANDIDATES);
  w.u8(cands.length);
  for (const c of cands) {
    if (isIpv4(c.address)) w.u8(KIND_IPV4).bytes(ipv4ToBytes(c.address));
    else if (isMdns(c.address)) w.u8(KIND_MDNS).bytes(fromHex(c.address.slice(0, 36).replaceAll('-', '')));
    else w.u8(KIND_IPV6).bytes(ipv6ToBytes(c.address));
    w.u16(c.port);
  }
  return w.finish();
}

export function decodePayload(bytes: Uint8Array<ArrayBuffer>): PairingPayload {
  try {
    const r = new ByteReader(bytes);
    if (r.u8() !== PAYLOAD_MAGIC) throw new PayloadError('not a ramtalk code');
    const roleByte = r.u8();
    if (roleByte > 1) throw new PayloadError('bad role');
    const sessionId = r.bytes(SESSION_ID_LEN);
    const publicKey = r.bytes(PUBLIC_KEY_LEN);
    if (publicKey[0] !== 0x04) throw new PayloadError('bad public key');
    const mid = r.str8();
    const ufrag = r.str8();
    const pwd = r.str8();
    const fingerprint = r.bytes(32);
    const setup = SETUPS[r.u8()];
    if (!setup) throw new PayloadError('bad setup');
    const sctpPort = r.u16();
    const maxMessageSize = r.u32();
    const n = r.u8();
    if (n > MAX_CANDIDATES) throw new PayloadError('too many candidates');
    const candidates: HostCandidate[] = [];
    for (let i = 0; i < n; i++) {
      const kind = r.u8();
      let address: string;
      if (kind === KIND_IPV4) address = bytesToIpv4(r.bytes(4));
      else if (kind === KIND_IPV6) address = bytesToIpv6(r.bytes(16));
      else if (kind === KIND_MDNS) address = formatUuid(toHex(r.bytes(16))) + '.local';
      else throw new PayloadError('bad candidate kind');
      const port = r.u16();
      if (port === 0) throw new PayloadError('bad candidate port');
      candidates.push({ address, port });
    }
    if (r.remaining !== 0) throw new PayloadError('trailing bytes');
    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(mid)) throw new PayloadError('bad mid');
    if (!/^[A-Za-z0-9+/]{4,256}$/.test(ufrag) || !/^[A-Za-z0-9+/]{22,256}$/.test(pwd)) {
      throw new PayloadError('bad ICE credentials');
    }
    return {
      role: roleByte === 0 ? 'offer' : 'answer',
      sessionId,
      publicKey,
      sdp: { mid, ufrag, pwd, fingerprint, setup, sctpPort, maxMessageSize, candidates },
    };
  } catch (e) {
    if (e instanceof PayloadError) throw e;
    throw new PayloadError(`malformed code: ${(e as Error).message}`);
  }
}

function formatUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function payloadToQrText(bytes: Uint8Array<ArrayBuffer>): string {
  return base45Encode(bytes);
}

export function qrTextToPayloadBytes(text: string): Uint8Array<ArrayBuffer> {
  try {
    return base45Decode(text.trim());
  } catch {
    throw new PayloadError('not a ramtalk code');
  }
}
