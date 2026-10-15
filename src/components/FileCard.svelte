<script lang="ts">
  import { controller, type FileItem } from '../lib/chat/controller.svelte';

  let { item }: { item: FileItem } = $props();

  const pct = $derived(item.size ? Math.round((item.transferred / item.size) * 100) : 100);
  const active = $derived(item.status === 'queued' || item.status === 'sending' || item.status === 'receiving');
  const canSave = $derived(item.from === 'peer' && item.status === 'done');
  const showImage = $derived(!!item.previewUrl && (item.status === 'done' || item.from === 'me'));

  function fmt(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  }

  const statusText = $derived(
    item.status === 'queued'
      ? 'Waiting…'
      : item.status === 'sending'
        ? `Sending ${pct}%`
        : item.status === 'receiving'
          ? `Receiving ${pct}%`
          : item.status === 'done'
            ? item.from === 'me' ? 'Sent' : 'Received'
            : item.status === 'cancelled'
              ? item.error ?? 'Cancelled'
              : item.error ?? 'Failed',
  );
</script>

<div class="card" class:mine={item.from === 'me'} class:bad={item.status === 'failed' || item.status === 'cancelled'}>
  {#if showImage}
    <img src={item.previewUrl} alt={item.name} loading="lazy" />
  {/if}
  <div class="meta">
    <span class="icon" aria-hidden="true">{item.mime.startsWith('image/') ? '🖼️' : '📄'}</span>
    <div class="text">
      <span class="name" title={item.name}>{item.name}</span>
      <span class="sub">{fmt(item.size)} · {statusText}</span>
    </div>
  </div>
  {#if active}
    <div class="bar" role="progressbar" aria-valuenow={pct} aria-valuemin="0" aria-valuemax="100">
      <div style:width="{pct}%"></div>
    </div>
  {/if}
  {#if active || canSave}
    <div class="buttons">
      {#if active}
        <button class="btn small ghost" onclick={() => controller.cancelFile(item.id)}>Cancel</button>
      {/if}
      {#if canSave}
        <button class="btn small primary" onclick={() => controller.saveFile(item.id)}>Save</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .card {
    width: min(80%, 340px);
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
    border-radius: 18px 18px 18px 6px;
    background: var(--theirs);
    border: 1px solid var(--border);
  }
  .card.mine { border-radius: 18px 18px 6px 18px; background: var(--mine); border-color: transparent; color: var(--mine-text); }
  .card.bad { opacity: 0.75; }
  img {
    display: block;
    width: 100%;
    max-height: 360px;
    object-fit: cover;
    border-radius: 12px;
    background: var(--code-bg);
  }
  .meta { display: flex; align-items: center; gap: 10px; padding: 0 4px; }
  .icon { font-size: 22px; }
  .text { display: flex; flex-direction: column; min-width: 0; }
  .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sub { font-size: 12px; opacity: 0.75; }
  .bar { height: 4px; border-radius: 2px; background: var(--code-bg); overflow: hidden; margin: 0 4px; }
  .bar div { height: 100%; background: var(--accent); transition: width 0.15s linear; }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; }
</style>
