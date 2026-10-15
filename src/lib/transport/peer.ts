// One RTCPeerConnection with one pre-negotiated data channel, no ICE servers. Signaling happens
// out of band (QR codes), so ICE gathering is waited out in full (no trickle) and there is no
// path for an ICE restart: once the link is lost past a short grace period, the chat is over.

const ICE_GATHER_TIMEOUT_MS = 3000;
const DISCONNECT_GRACE_MS = 10_000;
/** Host: from scanning the reply until the channel opens (both sides are ready by then). */
const CONNECT_TIMEOUT_MS = 20_000;
/** Joiner: a person still has to scan the reply code, so only a generous safety net. */
const JOINER_WAIT_TIMEOUT_MS = 5 * 60_000;
const BUFFER_HIGH = 1024 * 1024;
const BUFFER_LOW = 256 * 1024;

export interface PeerEvents {
  onOpen(): void;
  onMessage(data: Uint8Array<ArrayBuffer>): void;
  onClose(reason: string): void;
}

export class PeerClosedError extends Error {}

export class Peer {
  private readonly pc: RTCPeerConnection;
  private readonly dc: RTCDataChannel;
  private closed = false;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private drainWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

  constructor(private readonly events: PeerEvents) {
    this.pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
    // Negotiated with a fixed id on both sides: the m=application line exists in the offer, and
    // neither side depends on the in-band DCEP open handshake.
    this.dc = this.pc.createDataChannel('ramtalk', { negotiated: true, id: 0, ordered: true });
    this.dc.binaryType = 'arraybuffer';
    this.dc.bufferedAmountLowThreshold = BUFFER_LOW;

    this.dc.onopen = () => {
      clearTimeout(this.connectTimer);
      this.events.onOpen();
    };
    this.dc.onmessage = (ev: MessageEvent) => {
      if (ev.data instanceof ArrayBuffer) this.events.onMessage(new Uint8Array(ev.data));
    };
    this.dc.onclose = () => this.close('The other person left or the connection closed.');
    this.dc.onerror = () => this.close('The connection failed.');
    this.dc.onbufferedamountlow = () => this.flushDrainWaiters();

    const onState = (): void => {
      const s = this.pc.connectionState ?? this.pc.iceConnectionState;
      if (import.meta.env.DEV) console.debug('[peer]', 'connection', this.pc.connectionState, 'ice', this.pc.iceConnectionState);
      if (s === 'connected' || this.pc.iceConnectionState === 'completed') {
        clearTimeout(this.graceTimer);
        this.graceTimer = undefined;
      } else if (s === 'disconnected') {
        this.graceTimer ??= setTimeout(
          () => this.close('Lost the connection to the other device.'),
          DISCONNECT_GRACE_MS,
        );
      } else if (s === 'failed') {
        this.close('Could not reach the other device. Are both on the same Wi-Fi or hotspot?');
      } else if (s === 'closed') {
        this.close('The connection closed.');
      }
    };
    this.pc.onconnectionstatechange = onState;
    this.pc.oniceconnectionstatechange = onState;
  }

  /** Host: creates the offer and returns the local SDP once candidate gathering is done. */
  async createOffer(): Promise<string> {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    return this.gatheredLocalSdp();
  }

  /** Joiner: applies the host's offer and returns the answer SDP once gathering is done. */
  async acceptOffer(offerSdp: string): Promise<string> {
    await this.pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const answer = await this.pc.createAnswer();
    // Make the joiner the DTLS server. Anyone who saw the host's QR code can send ICE checks to
    // the host; if joiners were DTLS clients, a stray second joiner's ClientHello could reach the
    // host's DTLS server first and stall the real handshake. As a passive server, a joiner only
    // ever answers the host, and the host (client) only talks over the pair it selected.
    // This is SDP munging; if a browser refuses it, fall back to the unmodified answer.
    const passive = answer.sdp?.replace(/^a=setup:active(\r?)$/m, 'a=setup:passive$1');
    try {
      await this.pc.setLocalDescription({ type: 'answer', sdp: passive });
    } catch (e) {
      if (import.meta.env.DEV) console.warn('[peer] setup:passive rejected, using default DTLS role', e);
      await this.pc.setLocalDescription(answer);
    }
    this.armConnectTimeout(JOINER_WAIT_TIMEOUT_MS, 'Pairing timed out: the reply code was not scanned.');
    return this.gatheredLocalSdp();
  }

  /** Host: applies the joiner's answer. Only one answer can ever be applied. */
  async acceptAnswer(answerSdp: string): Promise<void> {
    if (this.pc.signalingState !== 'have-local-offer') throw new Error('Already paired.');
    await this.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    this.armConnectTimeout();
  }

  get isOpen(): boolean {
    return !this.closed && this.dc.readyState === 'open';
  }

  /** Sends one message, waiting first if too much data is already queued. */
  async send(data: Uint8Array<ArrayBuffer>): Promise<void> {
    if (this.closed) throw new PeerClosedError('connection closed');
    if (this.dc.bufferedAmount > BUFFER_HIGH) {
      await new Promise<void>((resolve, reject) => this.drainWaiters.push({ resolve, reject }));
    }
    if (this.closed || this.dc.readyState !== 'open') throw new PeerClosedError('connection closed');
    this.dc.send(data as Uint8Array<ArrayBuffer>);
  }

  /** Resolves once everything queued so far has been handed to the network (or on close). */
  async flush(timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed && this.dc.bufferedAmount > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  close(reason = 'Chat ended.'): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.graceTimer);
    clearTimeout(this.connectTimer);
    for (const w of this.drainWaiters) w.reject(new PeerClosedError('connection closed'));
    this.drainWaiters = [];
    this.dc.onopen = this.dc.onmessage = this.dc.onclose = this.dc.onerror = null;
    this.pc.onconnectionstatechange = this.pc.oniceconnectionstatechange = null;
    try {
      this.dc.close();
    } catch {
      /* already closed */
    }
    this.pc.close();
    this.events.onClose(reason);
  }

  private armConnectTimeout(
    ms = CONNECT_TIMEOUT_MS,
    reason = 'Could not connect. Make sure both devices are on the same Wi-Fi or hotspot.',
  ): void {
    clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (this.dc.readyState !== 'open') this.close(reason);
    }, ms);
  }

  private flushDrainWaiters(): void {
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const w of waiters) w.resolve();
  }

  private async gatheredLocalSdp(): Promise<string> {
    if (this.pc.iceGatheringState !== 'complete') {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          this.pc.removeEventListener('icegatheringstatechange', onChange);
          this.pc.removeEventListener('icecandidate', onCandidate);
          resolve();
        };
        const onChange = (): void => {
          if (this.pc.iceGatheringState === 'complete') done();
        };
        const onCandidate = (ev: RTCPeerConnectionIceEvent): void => {
          if (!ev.candidate) done();
        };
        const timer = setTimeout(done, ICE_GATHER_TIMEOUT_MS);
        this.pc.addEventListener('icegatheringstatechange', onChange);
        this.pc.addEventListener('icecandidate', onCandidate);
      });
    }
    const sdp = this.pc.localDescription?.sdp;
    if (!sdp) throw new Error('No local description');
    return sdp;
  }
}
