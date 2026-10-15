// Application-layer end-to-end encryption, independent of WebRTC's DTLS.
//
// Each side makes a fresh P-256 ECDH key pair per chat; the public keys travel inside the two
// QR codes, which are exchanged in person, so the keys are authenticated by that visual channel.
// HKDF over the ECDH secret, salted with a hash of both QR payloads (which also binds both DTLS
// fingerprints), gives one AES-256-GCM key per direction, an HMAC key-confirmation key, and the
// bytes for the short authentication string.

import { ByteWriter, concatBytes } from '../signaling/bytes';

export type SessionRole = 'host' | 'joiner';

const PROTOCOL = 'ramtalk/v1';
const enc = new TextEncoder();

export class CryptoError extends Error {}

export interface EphemeralKeys {
  privateKey: CryptoKey;
  publicRaw: Uint8Array<ArrayBuffer>;
}

export interface KeySchedule {
  role: SessionRole;
  sendKey: CryptoKey;
  recvKey: CryptoKey;
  confirmKey: CryptoKey;
  transcriptHash: Uint8Array<ArrayBuffer>;
  sas: Uint8Array<ArrayBuffer>;
}

export async function generateEphemeralKeys(): Promise<EphemeralKeys> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, publicRaw };
}

export function transcript(offerBytes: Uint8Array<ArrayBuffer>, answerBytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  return new ByteWriter()
    .str8(PROTOCOL)
    .u16(offerBytes.length)
    .bytes(offerBytes)
    .u16(answerBytes.length)
    .bytes(answerBytes)
    .finish();
}

export async function deriveKeySchedule(
  role: SessionRole,
  privateKey: CryptoKey,
  peerPublicRaw: Uint8Array<ArrayBuffer>,
  offerBytes: Uint8Array<ArrayBuffer>,
  answerBytes: Uint8Array<ArrayBuffer>,
): Promise<KeySchedule> {
  let peerPublic: CryptoKey;
  try {
    peerPublic = await crypto.subtle.importKey('raw', peerPublicRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  } catch {
    throw new CryptoError('peer public key is invalid');
  }
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerPublic }, privateKey, 256);
  const transcriptHash = new Uint8Array(await crypto.subtle.digest('SHA-256', transcript(offerBytes, answerBytes)));
  const ikm = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey', 'deriveBits']);

  const hkdf = (label: string): HkdfParams => ({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: transcriptHash,
    info: enc.encode(`${PROTOCOL} ${label}`),
  });
  const aes = (label: string): Promise<CryptoKey> =>
    crypto.subtle.deriveKey(hkdf(label), ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

  const [h2j, j2h, confirmKey, sasBits] = await Promise.all([
    aes('host->joiner'),
    aes('joiner->host'),
    crypto.subtle.deriveKey(hkdf('confirm'), ikm, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']),
    crypto.subtle.deriveBits(hkdf('sas'), ikm, 64),
  ]);

  return {
    role,
    sendKey: role === 'host' ? h2j : j2h,
    recvKey: role === 'host' ? j2h : h2j,
    confirmKey,
    transcriptHash,
    sas: new Uint8Array(sasBits),
  };
}

function confirmInput(role: SessionRole, transcriptHash: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  return concatBytes(enc.encode(`${PROTOCOL} confirm ${role}`), transcriptHash);
}

/** Tag proving this side derived the same keys; sent in the first (hello) frame. */
export async function confirmationTag(ks: KeySchedule): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', ks.confirmKey, confirmInput(ks.role, ks.transcriptHash)));
}

export async function verifyPeerConfirmation(ks: KeySchedule, tag: Uint8Array<ArrayBuffer>): Promise<boolean> {
  const peerRole: SessionRole = ks.role === 'host' ? 'joiner' : 'host';
  return crypto.subtle.verify('HMAC', ks.confirmKey, tag, confirmInput(peerRole, ks.transcriptHash));
}

const SEQ_LEN = 8;
const TAG_LEN = 16;
/** Bytes added to every plaintext by `SealedChannel.seal`. */
export const SEAL_OVERHEAD = SEQ_LEN + TAG_LEN;
const MAX_SEQ = 2n ** 48n;

/**
 * AES-256-GCM with a 64-bit message counter as the nonce (never reused under one key, since the
 * keys are per-session and per-direction). The receiver requires counters to arrive strictly in
 * order, which the ordered, reliable data channel guarantees; anything else is a replay, drop or
 * forgery, and permanently breaks the channel.
 */
export class SealedChannel {
  private sendSeq = 0n;
  private recvSeq = 0n;
  private broken = false;

  constructor(
    private sendKey: CryptoKey | null,
    private recvKey: CryptoKey | null,
  ) {}

  /** Assigns the sequence number synchronously, so packets must be sent in call order. */
  async seal(plain: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    if (this.broken || !this.sendKey) throw new CryptoError('channel closed');
    if (this.sendSeq >= MAX_SEQ) throw new CryptoError('sequence exhausted');
    const seq = this.sendSeq++;
    const header = seqBytes(seq);
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonceFor(seq), additionalData: header },
      this.sendKey,
      plain,
    );
    return concatBytes(header, new Uint8Array(ct));
  }

  async open(packet: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    if (this.broken || !this.recvKey) throw new CryptoError('channel closed');
    if (packet.length < SEAL_OVERHEAD) return this.fail('packet too short');
    const header = packet.subarray(0, SEQ_LEN);
    const seq = new DataView(header.buffer, header.byteOffset, SEQ_LEN).getBigUint64(0);
    if (seq !== this.recvSeq) return this.fail('unexpected sequence number');
    this.recvSeq++;
    try {
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonceFor(seq), additionalData: header },
        this.recvKey,
        packet.subarray(SEQ_LEN),
      );
      return new Uint8Array(pt);
    } catch {
      return this.fail('authentication failed');
    }
  }

  /** Drops key references; the channel is unusable afterwards. */
  destroy(): void {
    this.broken = true;
    this.sendKey = null;
    this.recvKey = null;
  }

  private fail(reason: string): never {
    this.destroy();
    throw new CryptoError(reason);
  }
}

function seqBytes(seq: bigint): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(SEQ_LEN);
  new DataView(b.buffer).setBigUint64(0, seq);
  return b;
}

function nonceFor(seq: bigint): Uint8Array<ArrayBuffer> {
  const n = new Uint8Array(12);
  new DataView(n.buffer).setBigUint64(4, seq);
  return n;
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}
