<script lang="ts">
  import QrScanner from 'qr-scanner';

  let {
    stream,
    onresult,
  }: {
    stream: MediaStream;
    /** Return false to keep scanning (e.g. the code was for something else). */
    onresult: (text: string) => Promise<boolean> | boolean;
  } = $props();

  let video: HTMLVideoElement | undefined = $state();

  $effect(() => {
    if (!video) return;
    const v = video;
    v.srcObject = stream;
    void v.play().catch(() => {});

    let stopped = false;
    let lastRejected = '';
    const canvas = document.createElement('canvas');
    // Created up front so the scanner's repeated getImageData reads use a CPU-backed canvas.
    canvas.getContext('2d', { willReadFrequently: true });
    const engine = QrScanner.createQrEngine();

    const loop = async (): Promise<void> => {
      while (!stopped) {
        await new Promise((r) => setTimeout(r, 120));
        if (stopped || v.readyState < 2 || !v.videoWidth) continue;
        const side = Math.min(v.videoWidth, v.videoHeight);
        try {
          const res = await QrScanner.scanImage(v, {
            qrEngine: engine,
            canvas,
            scanRegion: {
              x: (v.videoWidth - side) / 2,
              y: (v.videoHeight - side) / 2,
              width: side,
              height: side,
              downScaledWidth: Math.min(side, 800),
              downScaledHeight: Math.min(side, 800),
            },
            returnDetailedScanResult: true,
          });
          if (stopped || !res.data || res.data === lastRejected) continue;
          const accepted = await onresult(res.data);
          if (accepted) return;
          lastRejected = res.data;
        } catch {
          // No code in this frame.
        }
      }
    };
    void loop();

    return () => {
      stopped = true;
      v.srcObject = null;
      void engine.then((e) => {
        if (e instanceof Worker) e.terminate();
      });
    };
  });
</script>

<div class="scanner">
  <!-- svelte-ignore a11y_media_has_caption -->
  <video bind:this={video} playsinline muted autoplay></video>
  <div class="frame" aria-hidden="true"></div>
</div>

<style>
  .scanner {
    position: relative;
    width: min(100%, 420px);
    aspect-ratio: 1;
    margin: 0 auto;
    border-radius: 20px;
    overflow: hidden;
    background: #000;
  }
  video {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .frame {
    position: absolute;
    inset: 12%;
    border: 3px solid rgba(255, 255, 255, 0.85);
    border-radius: 16px;
    box-shadow: 0 0 0 100vmax rgba(0, 0, 0, 0.25);
  }
</style>
