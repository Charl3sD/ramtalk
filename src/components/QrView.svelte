<script lang="ts">
  import QRCode from 'qrcode';

  let { text }: { text: string } = $props();
  let canvas: HTMLCanvasElement | undefined = $state();
  let error = $state('');

  $effect(() => {
    if (!canvas || !text) return;
    const size = Math.min(window.innerWidth - 40, 420);
    QRCode.toCanvas(canvas, [{ data: text, mode: 'alphanumeric' }], {
      errorCorrectionLevel: 'M',
      margin: 3,
      width: size * Math.min(window.devicePixelRatio || 1, 3),
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then(() => {
        canvas!.style.width = canvas!.style.height = `${size}px`;
        error = '';
      })
      .catch((e: Error) => (error = e.message));
  });
</script>

<div class="qr">
  {#if error}
    <p class="err">Couldn’t draw the code: {error}</p>
  {:else}
    <canvas bind:this={canvas} aria-label="Pairing code"></canvas>
  {/if}
</div>

<style>
  .qr {
    display: flex;
    justify-content: center;
  }
  canvas {
    border-radius: 12px;
    background: #fff;
    image-rendering: pixelated;
  }
  .err { color: var(--danger); }
</style>
