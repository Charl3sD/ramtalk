import { describe, expect, it } from 'vitest';
import {
  confirmationTag,
  CryptoError,
  deriveKeySchedule,
  generateEphemeralKeys,
  SealedChannel,
  verifyPeerConfirmation,
} from '../../src/lib/crypto/session';
import { sasEmoji, SAS_LENGTH } from '../../src/lib/crypto/sas';

const offer = new TextEncoder().encode('offer-bytes');
const answer = new TextEncoder().encode('answer-bytes');
const msg = (s: string) => new TextEncoder().encode(s);

async function pair(offerBytes = offer, answerBytes = answer, joinerOffer = offerBytes) {
  const h = await generateEphemeralKeys();
  const j = await generateEphemeralKeys();
  const host = await deriveKeySchedule('host', h.privateKey, j.publicRaw, offerBytes, answerBytes);
  const joiner = await deriveKeySchedule('joiner', j.privateKey, h.publicRaw, joinerOffer, answerBytes);
  return { host, joiner };
}

describe('key schedule', () => {
  it('derives matching keys, confirmation and SAS on both sides', async () => {
    const { host, joiner } = await pair();
    expect(host.transcriptHash).toEqual(joiner.transcriptHash);
    expect(sasEmoji(host.sas)).toEqual(sasEmoji(joiner.sas));
    expect(sasEmoji(host.sas)).toHaveLength(SAS_LENGTH);
    expect(await verifyPeerConfirmation(joiner, await confirmationTag(host))).toBe(true);
    expect(await verifyPeerConfirmation(host, await confirmationTag(joiner))).toBe(true);
    // A side can't be fooled by its own tag reflected back.
    expect(await verifyPeerConfirmation(host, await confirmationTag(host))).toBe(false);

    const a = new SealedChannel(host.sendKey, host.recvKey);
    const b = new SealedChannel(joiner.sendKey, joiner.recvKey);
    expect(await b.open(await a.seal(msg('hi joiner')))).toEqual(msg('hi joiner'));
    expect(await a.open(await b.seal(msg('hi host')))).toEqual(msg('hi host'));
  });

  it('fails confirmation when the transcripts differ (e.g. a swapped QR code)', async () => {
    const { host, joiner } = await pair(offer, answer, new TextEncoder().encode('other-offer'));
    expect(await verifyPeerConfirmation(joiner, await confirmationTag(host))).toBe(false);
    expect(sasEmoji(host.sas)).not.toEqual(sasEmoji(joiner.sas));
    const a = new SealedChannel(host.sendKey, host.recvKey);
    const b = new SealedChannel(joiner.sendKey, joiner.recvKey);
    await expect(b.open(await a.seal(msg('x')))).rejects.toThrow(CryptoError);
  });

  it('rejects an invalid peer public key', async () => {
    const h = await generateEphemeralKeys();
    const bad = new Uint8Array(65);
    bad[0] = 4;
    await expect(deriveKeySchedule('host', h.privateKey, bad, offer, answer)).rejects.toThrow(CryptoError);
  });

  it('uses distinct keys per direction', async () => {
    const { host } = await pair();
    const loop = new SealedChannel(host.sendKey, host.sendKey);
    const wrongDir = new SealedChannel(host.sendKey, host.recvKey);
    const pkt = await loop.seal(msg('x'));
    await expect(wrongDir.open(pkt)).rejects.toThrow(CryptoError);
  });
});

describe('SealedChannel', () => {
  async function channels() {
    const { host, joiner } = await pair();
    return { a: new SealedChannel(host.sendKey, host.recvKey), b: new SealedChannel(joiner.sendKey, joiner.recvKey) };
  }

  it('rejects tampered ciphertext and breaks the channel', async () => {
    const { a, b } = await channels();
    const pkt = await a.seal(msg('secret'));
    pkt[pkt.length - 1]! ^= 1;
    await expect(b.open(pkt)).rejects.toThrow(/authentication failed/);
    await expect(b.open(await a.seal(msg('next')))).rejects.toThrow(/closed/);
  });

  it('rejects a tampered sequence header', async () => {
    const { a, b } = await channels();
    await b.open(await a.seal(msg('0')));
    const pkt = await a.seal(msg('1'));
    pkt[7] = 0; // claim seq 0 again
    await expect(b.open(pkt)).rejects.toThrow(/sequence/);
  });

  it('rejects replays', async () => {
    const { a, b } = await channels();
    const pkt = await a.seal(msg('once'));
    await b.open(pkt);
    await expect(b.open(pkt)).rejects.toThrow(/sequence/);
  });

  it('rejects skipped (dropped/reordered) packets', async () => {
    const { a, b } = await channels();
    await a.seal(msg('dropped'));
    await expect(b.open(await a.seal(msg('second')))).rejects.toThrow(/sequence/);
  });

  it('rejects short packets', async () => {
    const { b } = await channels();
    await expect(b.open(new Uint8Array(10))).rejects.toThrow(CryptoError);
  });

  it('destroy() makes the channel unusable', async () => {
    const { a } = await channels();
    a.destroy();
    await expect(a.seal(msg('x'))).rejects.toThrow(/closed/);
  });

  it('ciphertext differs for identical plaintexts', async () => {
    const { a } = await channels();
    const p1 = await a.seal(msg('same'));
    const p2 = await a.seal(msg('same'));
    expect(p1.subarray(8)).not.toEqual(p2.subarray(8));
  });
});
