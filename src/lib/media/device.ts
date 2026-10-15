// Camera and screen wake lock.
//
// The camera is opened at the start of pairing, before any ICE candidates are gathered, and kept
// open until the data channel connects. Besides being needed to scan QR codes, an active capture
// makes Chrome and Safari reveal real local IP candidates instead of `*.local` mDNS names, which
// often fail to resolve across a phone hotspot.

export class CameraUnavailableError extends Error {}

export async function openCamera(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraUnavailableError('This browser cannot use the camera. Open the app over HTTPS.');
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (e) {
    const name = (e as DOMException).name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new CameraUnavailableError('Camera permission is needed to scan the other person’s code.');
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new CameraUnavailableError('No camera found on this device.');
    }
    throw new CameraUnavailableError(`Could not open the camera (${name || 'unknown error'}).`);
  }
}

export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((t) => t.stop());
}

/** Keeps the screen on while chatting; re-acquired when the page becomes visible again. */
export class WakeLock {
  private sentinel: WakeLockSentinel | null = null;
  private wanted = false;
  private readonly onVisible = (): void => {
    if (this.wanted && document.visibilityState === 'visible') void this.acquire();
  };

  async enable(): Promise<void> {
    this.wanted = true;
    document.addEventListener('visibilitychange', this.onVisible);
    await this.acquire();
  }

  disable(): void {
    this.wanted = false;
    document.removeEventListener('visibilitychange', this.onVisible);
    void this.sentinel?.release().catch(() => {});
    this.sentinel = null;
  }

  private async acquire(): Promise<void> {
    if (!('wakeLock' in navigator) || this.sentinel) return;
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
      this.sentinel.addEventListener('release', () => {
        this.sentinel = null;
      });
    } catch {
      // Not supported, or not allowed right now (e.g. low battery). Not fatal.
    }
  }
}
