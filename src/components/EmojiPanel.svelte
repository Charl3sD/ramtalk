<script lang="ts">
  // emoji-picker-element is loaded on first use; its emoji data is served from this app
  // (and precached by the service worker) rather than a CDN, so it works offline.
  let { onpick, onclose }: { onpick: (emoji: string) => void; onclose: () => void } = $props();

  let host: HTMLDivElement | undefined = $state();
  let failed = $state(false);

  $effect(() => {
    if (!host) return;
    const container = host;
    let picker: HTMLElement | undefined;
    let cancelled = false;
    const onEmoji = (e: Event) => {
      const unicode = (e as CustomEvent<{ unicode?: string }>).detail.unicode;
      if (unicode) onpick(unicode);
    };
    import('emoji-picker-element')
      .then(() => {
        if (cancelled) return;
        picker = document.createElement('emoji-picker');
        picker.setAttribute('data-source', `${import.meta.env.BASE_URL}emoji/data.json`);
        picker.classList.add(matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
        picker.addEventListener('emoji-click', onEmoji);
        container.append(picker);
      })
      .catch(() => (failed = true));
    return () => {
      cancelled = true;
      picker?.removeEventListener('emoji-click', onEmoji);
      picker?.remove();
    };
  });

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onclose();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="panel" bind:this={host}>
  {#if failed}<p>Emoji picker unavailable. Use your keyboard’s emoji instead.</p>{/if}
</div>

<style>
  .panel {
    position: absolute;
    bottom: 100%;
    right: 8px;
    margin-bottom: 8px;
    border-radius: 14px;
    overflow: hidden;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    z-index: 10;
    max-width: calc(100vw - 16px);
  }
  .panel :global(emoji-picker) {
    --num-columns: 8;
    width: min(360px, calc(100vw - 16px));
    height: 320px;
  }
  p { margin: 0; padding: 16px; background: var(--surface); color: var(--muted); }
</style>
