// Orchestrates one chat: QR pairing, key agreement, the encrypted frame stream, messages and file
// transfers. All chat state lives in memory in `app`; `end()` wipes every trace of it.

import { decodePayload, encodePayload, payloadToQrText, qrTextToPayloadBytes, PayloadError } from '../signaling/codec';
import { expandSdp, summarizeSdp } from '../signaling/sdp';
import { bytesEqual } from '../signaling/bytes';
import {
  confirmationTag,
  deriveKeySchedule,
  generateEphemeralKeys,
  randomBytes,
  SealedChannel,
  verifyPeerConfirmation,
  type EphemeralKeys,
  type KeySchedule,
} from '../crypto/session';
import { sasEmoji } from '../crypto/sas';
import { decodeFrame, encodeFrame, MAX_TEXT_BYTES, newId, type Frame } from '../protocol/frames';
import {
  chunkSizeFor,
  FileLimitError,
  INLINE_IMAGE_TYPES,
  IncomingFiles,
  MAX_FILE_BYTES,
  sanitizeFilename,
  sanitizeMime,
} from '../protocol/files';
import { Peer } from '../transport/peer';
import { openCamera, stopStream, WakeLock } from '../media/device';

export type Screen = 'home' | 'host' | 'join' | 'chat';
export type PairingStep = 'camera' | 'preparing' | 'show' | 'scan' | 'connecting' | 'verifying';

export interface TextItem {
  kind: 'text';
  id: string;
  from: 'me' | 'peer';
  ts: number;
  md: string;
}

export type FileStatus = 'queued' | 'sending' | 'receiving' | 'done' | 'cancelled' | 'failed';

export interface FileItem {
  kind: 'file';
  id: string;
  from: 'me' | 'peer';
  ts: number;
  name: string;
  mime: string;
  size: number;
  transferred: number;
  status: FileStatus;
  error?: string;
  /** Object URL for inline image previews (allowlisted image types only). */
  previewUrl?: string;
}

export interface SystemItem {
  kind: 'system';
  id: string;
  ts: number;
  text: string;
}

export type ChatItem = TextItem | FileItem | SystemItem;

const NAME_KEY = 'ramtalk.name';
const TYPING_SEND_INTERVAL_MS = 3000;
const TYPING_SHOW_MS = 4500;
const PROGRESS_UPDATE_MS = 100;

function loadName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export const app = $state({
  screen: 'home' as Screen,
  step: 'camera' as PairingStep,
  /** Base45 text of this device's pairing QR code. */
  qrText: '',
  pairingError: '',
  /** Camera stream held open during pairing (also what the scanner reads from). */
  stream: null as MediaStream | null,
  myName: loadName(),
  peerName: '',
  sas: [] as string[],
  items: [] as ChatItem[],
  peerTyping: false,
  /** Shown on the home screen after a chat ends. */
  notice: '',
});

class ChatController {
  private role: 'host' | 'joiner' | null = null;
  private peer: Peer | null = null;
  private keys: EphemeralKeys | null = null;
  private sessionId: Uint8Array<ArrayBuffer> | null = null;
  private offerBytes: Uint8Array<ArrayBuffer> | null = null;
  private ks: KeySchedule | null = null;
  private channel: SealedChannel | null = null;
  private peerMaxMessageSize = 65536;
  private helloVerified = false;
  private scanned = false;
  private ending = false;
  /** Set while the local user is ending the chat, so the peer's reaction isn't reported as theirs. */
  private endingByUser = false;

  private sendChain: Promise<unknown> = Promise.resolve();
  private recvChain: Promise<unknown> = Promise.resolve();
  private fileQueue: Promise<unknown> = Promise.resolve();
  private readonly incoming = new IncomingFiles();
  private readonly outgoing = new Map<string, { cancelled: boolean }>();
  private readonly receivedBlobs = new Map<string, Blob>();
  private readonly objectUrls = new Set<string>();
  private readonly wakeLock = new WakeLock();
  private readonly lastProgress = new Map<string, number>();
  private lastTypingSent = 0;
  private typingTimer: ReturnType<typeof setTimeout> | undefined;

  setName(name: string): void {
    app.myName = name.slice(0, 40);
    try {
      localStorage.setItem(NAME_KEY, app.myName);
    } catch {
      /* storage unavailable: name just won't be remembered */
    }
  }

  // ---------- pairing ----------

  async startHost(): Promise<void> {
    this.beginPairing('host');
    try {
      app.stream = await openCamera();
      app.step = 'preparing';
      const keys = await generateEphemeralKeys();
      this.keys = keys;
      this.sessionId = randomBytes(8);
      this.peer = this.newPeer();
      const sdp = summarizeSdp(await this.peer.createOffer());
      if (this.role !== 'host') return;
      this.offerBytes = encodePayload({ role: 'offer', sessionId: this.sessionId, publicKey: keys.publicRaw, sdp });
      app.qrText = payloadToQrText(this.offerBytes);
      app.step = 'show';
    } catch (e) {
      this.pairingFailed(e);
    }
  }

  async startJoin(): Promise<void> {
    this.beginPairing('joiner');
    try {
      const [stream, keys] = await Promise.all([openCamera(), generateEphemeralKeys()]);
      if (this.role !== 'joiner') return stopStream(stream);
      app.stream = stream;
      this.keys = keys;
      app.step = 'scan';
    } catch (e) {
      this.pairingFailed(e);
    }
  }

  /** Host: switch from showing the offer to scanning the reply. */
  hostReadyToScan(): void {
    if (this.role === 'host' && app.step === 'show') app.step = 'scan';
  }

  hostShowCode(): void {
    if (this.role === 'host' && app.step === 'scan') app.step = 'show';
  }

  /** Called by the scanner with decoded QR text. Returns false if the code was rejected. */
  async onScan(text: string): Promise<boolean> {
    if (this.scanned || app.step !== 'scan') return false;
    let bytes: Uint8Array<ArrayBuffer>;
    let payload: ReturnType<typeof decodePayload>;
    try {
      bytes = qrTextToPayloadBytes(text);
      payload = decodePayload(bytes);
    } catch (e) {
      app.pairingError = e instanceof PayloadError ? 'That isn’t a ramtalk code.' : String(e);
      return false;
    }

    if (this.role === 'host') {
      if (payload.role !== 'answer' || !this.sessionId || !bytesEqual(payload.sessionId, this.sessionId)) {
        app.pairingError = 'That code doesn’t belong to this chat. Scan the reply shown on their screen.';
        return false;
      }
      this.scanned = true;
      app.pairingError = '';
      app.step = 'connecting';
      try {
        this.ks = await deriveKeySchedule('host', this.keys!.privateKey, payload.publicKey, this.offerBytes!, bytes);
        this.channel = new SealedChannel(this.ks.sendKey, this.ks.recvKey);
        this.peerMaxMessageSize = payload.sdp.maxMessageSize;
        app.sas = sasEmoji(this.ks.sas);
        await this.peer!.acceptAnswer(expandSdp(payload.sdp));
      } catch (e) {
        this.pairingFailed(e);
      }
      return true;
    }

    if (this.role === 'joiner') {
      if (payload.role !== 'offer') {
        app.pairingError = 'That’s a reply code. Scan the code on the screen of the person who started the chat.';
        return false;
      }
      this.scanned = true;
      app.pairingError = '';
      app.step = 'preparing';
      try {
        this.peer = this.newPeer();
        const answer = summarizeSdp(await this.peer.acceptOffer(expandSdp(payload.sdp)));
        if (this.role !== 'joiner') return true;
        const answerBytes = encodePayload({
          role: 'answer',
          sessionId: payload.sessionId,
          publicKey: this.keys!.publicRaw,
          sdp: answer,
        });
        this.ks = await deriveKeySchedule('joiner', this.keys!.privateKey, payload.publicKey, bytes, answerBytes);
        this.channel = new SealedChannel(this.ks.sendKey, this.ks.recvKey);
        this.peerMaxMessageSize = payload.sdp.maxMessageSize;
        app.sas = sasEmoji(this.ks.sas);
        app.qrText = payloadToQrText(answerBytes);
        app.step = 'show';
      } catch (e) {
        this.pairingFailed(e);
      }
      return true;
    }
    return false;
  }

  cancelPairing(): void {
    this.end('');
  }

  private beginPairing(role: 'host' | 'joiner'): void {
    this.end('');
    this.ending = false;
    this.role = role;
    app.notice = '';
    app.pairingError = '';
    app.step = 'camera';
    app.screen = role === 'host' ? 'host' : 'join';
  }

  private pairingFailed(e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('pairing failed', e);
    this.end(msg || 'Pairing failed.');
  }

  private newPeer(): Peer {
    const peer = new Peer({
      onOpen: () => void this.onOpen(peer),
      onMessage: (data) => {
        this.recvChain = this.recvChain.then(() => this.onPacket(peer, data)).catch((e) => {
          console.error('protocol error', e);
          this.end('The connection was not secure or sent invalid data, so the chat was closed.');
        });
      },
      onClose: (reason) => {
        if (this.peer === peer) this.end(this.endingByUser ? 'You ended the chat.' : reason);
      },
    });
    return peer;
  }

  private async onOpen(peer: Peer): Promise<void> {
    if (peer !== this.peer || !this.ks) return;
    stopStream(app.stream);
    app.stream = null;
    app.qrText = '';
    app.step = 'verifying';
    await this.send({ t: 'hello', name: app.myName.trim(), confirm: await confirmationTag(this.ks) });
  }

  // ---------- receiving ----------

  private async onPacket(peer: Peer, data: Uint8Array<ArrayBuffer>): Promise<void> {
    if (peer !== this.peer || !this.channel) return;
    const frame = decodeFrame(await this.channel.open(data));
    if (peer !== this.peer || !frame) return;

    if (!this.helloVerified) {
      if (frame.t !== 'hello' || !this.ks || !(await verifyPeerConfirmation(this.ks, frame.confirm))) {
        throw new Error('key confirmation failed');
      }
      this.helloVerified = true;
      app.peerName = frame.name || 'Guest';
      app.screen = 'chat';
      this.system(`Connected to ${app.peerName}. Messages are end-to-end encrypted and vanish when the chat ends.`);
      void this.wakeLock.enable();
      return;
    }

    switch (frame.t) {
      case 'hello':
        throw new Error('unexpected hello');
      case 'text':
        app.peerTyping = false;
        app.items.push({ kind: 'text', id: frame.id, from: 'peer', ts: Date.now(), md: frame.md });
        return;
      case 'typing':
        app.peerTyping = true;
        clearTimeout(this.typingTimer);
        this.typingTimer = setTimeout(() => (app.peerTyping = false), TYPING_SHOW_MS);
        return;
      case 'file-meta':
        return this.onFileMeta(frame);
      case 'file-chunk':
        return this.onFileChunk(frame);
      case 'file-end':
        return this.onFileEnd(frame.id);
      case 'file-cancel':
        return this.onFileCancel(frame.id);
      case 'bye':
        this.end(`${app.peerName} ended the chat.`);
        return;
    }
  }

  private onFileMeta(f: Extract<Frame, { t: 'file-meta' }>): void {
    app.peerTyping = false;
    try {
      const { name, mime } = this.incoming.start(f.id, f.name, f.mime, f.size);
      app.items.push({
        kind: 'file', id: f.id, from: 'peer', ts: Date.now(), name, mime,
        size: f.size, transferred: 0, status: 'receiving',
      });
      if (f.size === 0) this.onFileEnd(f.id);
    } catch (e) {
      if (!(e instanceof FileLimitError)) throw e;
      app.items.push({
        kind: 'file', id: f.id, from: 'peer', ts: Date.now(), name: sanitizeFilename(f.name),
        mime: sanitizeMime(f.mime), size: f.size, transferred: 0, status: 'failed', error: e.message,
      });
      void this.send({ t: 'file-cancel', id: f.id });
    }
  }

  private onFileChunk(f: Extract<Frame, { t: 'file-chunk' }>): void {
    let received: number | null;
    try {
      received = this.incoming.chunk(f.id, f.idx, f.data);
    } catch (e) {
      if (!(e instanceof FileLimitError)) throw e;
      this.incoming.cancel(f.id);
      this.updateFile(f.id, { status: 'failed', error: e.message });
      void this.send({ t: 'file-cancel', id: f.id });
      return;
    }
    if (received !== null) this.progress(f.id, received);
  }

  private onFileEnd(id: string): void {
    let result: ReturnType<IncomingFiles['finish']>;
    try {
      result = this.incoming.finish(id);
    } catch (e) {
      if (!(e instanceof FileLimitError)) throw e;
      this.updateFile(id, { status: 'failed', error: e.message });
      return;
    }
    if (!result) return;
    this.receivedBlobs.set(id, result.blob);
    const previewUrl = INLINE_IMAGE_TYPES.has(result.mime) ? this.objectUrl(result.blob) : undefined;
    this.updateFile(id, { status: 'done', transferred: result.blob.size, previewUrl });
  }

  private onFileCancel(id: string): void {
    const out = this.outgoing.get(id);
    if (out) {
      out.cancelled = true;
      this.updateFile(id, { status: 'cancelled', error: 'Cancelled by the other person.' });
      return;
    }
    if (this.incoming.has(id)) {
      this.incoming.cancel(id);
      this.updateFile(id, { status: 'cancelled', error: 'Cancelled by the sender.' });
    }
  }

  // ---------- sending ----------

  /** Queues a frame; sealing happens inside the chain so sequence numbers match send order. */
  private send(frame: Frame): Promise<void> {
    const run = this.sendChain.then(async () => {
      const peer = this.peer;
      const channel = this.channel;
      if (!peer || !channel) throw new Error('not connected');
      await peer.send(await channel.seal(encodeFrame(frame)));
    });
    this.sendChain = run.catch(() => {});
    return run;
  }

  async sendText(raw: string): Promise<string | null> {
    const md = raw.replace(/\s+$/, '');
    if (!md.trim() || !this.helloVerified) return null;
    if (new TextEncoder().encode(md).length > MAX_TEXT_BYTES) return 'Message is too long (64 KB max).';
    const item: TextItem = { kind: 'text', id: newId(), from: 'me', ts: Date.now(), md };
    app.items.push(item);
    this.lastTypingSent = 0;
    try {
      await this.send({ t: 'text', id: item.id, ts: item.ts, md });
    } catch {
      return 'Could not send the message.';
    }
    return null;
  }

  notifyTyping(): void {
    const now = Date.now();
    if (!this.helloVerified || now - this.lastTypingSent < TYPING_SEND_INTERVAL_MS) return;
    this.lastTypingSent = now;
    void this.send({ t: 'typing' }).catch(() => {});
  }

  sendFiles(files: Iterable<File>): void {
    if (!this.helloVerified) return;
    for (const file of files) {
      const id = newId();
      const mime = sanitizeMime(file.type || 'application/octet-stream');
      const item: FileItem = {
        kind: 'file', id, from: 'me', ts: Date.now(), name: sanitizeFilename(file.name),
        mime, size: file.size, transferred: 0, status: 'queued',
        previewUrl: INLINE_IMAGE_TYPES.has(mime) ? this.objectUrl(file) : undefined,
      };
      app.items.push(item);
      if (file.size > MAX_FILE_BYTES) {
        this.updateFile(id, { status: 'failed', error: `Files over ${MAX_FILE_BYTES / 1024 / 1024} MB can’t be sent.` });
        continue;
      }
      const state = { cancelled: false };
      this.outgoing.set(id, state);
      this.fileQueue = this.fileQueue.then(() => this.transferFile(id, item.name, mime, file, state)).catch(() => {});
    }
  }

  private async transferFile(id: string, name: string, mime: string, file: File, state: { cancelled: boolean }): Promise<void> {
    if (state.cancelled || !this.peer) return;
    this.updateFile(id, { status: 'sending' });
    const chunkSize = chunkSizeFor(this.peerMaxMessageSize);
    try {
      await this.send({ t: 'file-meta', id, name, mime, size: file.size });
      let idx = 0;
      for (let off = 0; off < file.size; off += chunkSize) {
        if (state.cancelled) return;
        const data = new Uint8Array(await file.slice(off, off + chunkSize).arrayBuffer());
        await this.send({ t: 'file-chunk', id, idx: idx++, data });
        this.progress(id, Math.min(off + chunkSize, file.size));
      }
      if (state.cancelled) return;
      await this.send({ t: 'file-end', id });
      this.updateFile(id, { status: 'done', transferred: file.size });
    } catch (e) {
      if (state.cancelled || !this.peer) return;
      this.updateFile(id, { status: 'failed', error: 'Could not read or send this file.' });
      console.error('file send failed', e);
      void this.send({ t: 'file-cancel', id }).catch(() => {});
    } finally {
      this.outgoing.delete(id);
    }
  }

  cancelFile(id: string): void {
    const out = this.outgoing.get(id);
    if (out && !out.cancelled) {
      out.cancelled = true;
      this.updateFile(id, { status: 'cancelled' });
      void this.send({ t: 'file-cancel', id }).catch(() => {});
      return;
    }
    if (this.incoming.has(id)) {
      this.incoming.cancel(id);
      this.updateFile(id, { status: 'cancelled' });
      void this.send({ t: 'file-cancel', id }).catch(() => {});
    }
  }

  /** Saves a received file. iOS standalone PWAs ignore <a download>, so use the share sheet there. */
  async saveFile(id: string): Promise<void> {
    const blob = this.receivedBlobs.get(id);
    const item = app.items.find((i): i is FileItem => i.kind === 'file' && i.id === id);
    if (!blob || !item) return;
    const file = new File([blob], item.name, { type: blob.type });
    if (isIos() && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (e) {
        if ((e as DOMException).name === 'AbortError') return;
      }
    }
    const url = this.objectUrl(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.name;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
  }

  // ---------- ending & wiping ----------

  /** Ends the chat (optionally telling the peer) and wipes all chat state from memory. */
  async endByUser(): Promise<void> {
    this.endingByUser = true;
    if (this.peer?.isOpen && this.helloVerified) {
      try {
        await Promise.race([this.send({ t: 'bye' }), new Promise((r) => setTimeout(r, 1000))]);
        await this.peer?.flush(1000);
      } catch {
        /* closing anyway */
      }
    }
    this.end('You ended the chat.');
  }

  end(notice: string): void {
    if (this.ending) return;
    this.ending = true;
    const wasActive = this.role !== null;

    const peer = this.peer;
    this.peer = null;
    peer?.close();
    this.channel?.destroy();
    this.channel = null;
    this.ks = null;
    this.keys = null;
    this.sessionId = null;
    this.offerBytes = null;
    this.role = null;
    this.helloVerified = false;
    this.scanned = false;
    this.endingByUser = false;
    this.peerMaxMessageSize = 65536;

    for (const o of this.outgoing.values()) o.cancelled = true;
    this.outgoing.clear();
    this.incoming.clear();
    this.receivedBlobs.clear();
    this.lastProgress.clear();
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls.clear();
    this.sendChain = Promise.resolve();
    this.recvChain = Promise.resolve();
    this.fileQueue = Promise.resolve();
    clearTimeout(this.typingTimer);
    this.wakeLock.disable();

    stopStream(app.stream);
    app.stream = null;
    app.qrText = '';
    app.pairingError = '';
    app.peerName = '';
    app.sas = [];
    app.items = [];
    app.peerTyping = false;
    app.step = 'camera';
    app.screen = 'home';
    if (wasActive && notice) app.notice = notice;

    this.ending = false;
  }

  // ---------- helpers ----------

  private objectUrl(blob: Blob): string {
    const url = URL.createObjectURL(blob);
    this.objectUrls.add(url);
    return url;
  }

  private system(text: string): void {
    app.items.push({ kind: 'system', id: newId(), ts: Date.now(), text });
  }

  private updateFile(id: string, patch: Partial<FileItem>): void {
    const item = app.items.find((i): i is FileItem => i.kind === 'file' && i.id === id);
    if (item) Object.assign(item, patch);
  }

  private progress(id: string, transferred: number): void {
    const now = performance.now();
    if (now - (this.lastProgress.get(id) ?? 0) < PROGRESS_UPDATE_MS) return;
    this.lastProgress.set(id, now);
    this.updateFile(id, { transferred });
  }

  get inChat(): boolean {
    return this.helloVerified;
  }
}

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export const controller = new ChatController();
