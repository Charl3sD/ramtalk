<script lang="ts">
  import type { ChatItem } from '../lib/chat/controller.svelte';
  import { renderMarkdown } from '../lib/markdown';
  import FileCard from './FileCard.svelte';

  let { item }: { item: ChatItem } = $props();

  const html = $derived(item.kind === 'text' ? renderMarkdown(item.md) : '');
  const time = $derived(new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  // A message that is nothing but 1–3 emoji is shown large.
  const jumbo = $derived(
    item.kind === 'text' && /^(?:\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*\s*){1,3}$/u.test(item.md.trim()),
  );
</script>

{#if item.kind === 'system'}
  <p class="system">{item.text}</p>
{:else}
  <div class="row" class:mine={item.from === 'me'}>
    {#if item.kind === 'text'}
      <div class="bubble" class:jumbo>
        <div class="md">{@html html}</div>
        <time>{time}</time>
      </div>
    {:else}
      <FileCard {item} />
    {/if}
  </div>
{/if}

<style>
  .system {
    align-self: center;
    max-width: 90%;
    margin: 4px 0 10px;
    padding: 6px 12px;
    font-size: 13px;
    text-align: center;
    color: var(--muted);
    background: var(--surface);
    border-radius: 12px;
  }
  .row { display: flex; }
  .row.mine { justify-content: flex-end; }
  .bubble {
    max-width: min(80%, 560px);
    padding: 8px 12px 6px;
    border-radius: 18px 18px 18px 6px;
    background: var(--theirs);
    border: 1px solid var(--border);
    overflow-wrap: anywhere;
  }
  .mine .bubble {
    border-radius: 18px 18px 6px 18px;
    background: var(--mine);
    border-color: transparent;
    color: var(--mine-text);
  }
  .bubble.jumbo { background: none; border-color: transparent; }
  .bubble.jumbo .md { font-size: 44px; line-height: 1.15; }
  time { display: block; text-align: right; font-size: 11px; opacity: 0.6; margin-top: 2px; }

  .md :global(p) { margin: 0 0 6px; }
  .md :global(p:last-child) { margin-bottom: 0; }
  .md :global(a) { color: inherit; text-decoration: underline; }
  .md :global(code) { font-family: var(--mono); font-size: 0.9em; background: var(--code-bg); padding: 1px 5px; border-radius: 5px; }
  .md :global(pre) { margin: 6px 0; padding: 10px; background: var(--code-bg); border-radius: 10px; overflow-x: auto; }
  .md :global(pre code) { background: none; padding: 0; }
  .md :global(blockquote) { margin: 6px 0; padding-left: 10px; border-left: 3px solid currentColor; opacity: 0.85; }
  .md :global(ul), .md :global(ol) { margin: 4px 0; padding-left: 22px; }
  .md :global(h1), .md :global(h2), .md :global(h3) { margin: 6px 0 4px; font-size: 1.1em; }
  .md :global(table) { border-collapse: collapse; margin: 6px 0; font-size: 0.9em; }
  .md :global(th), .md :global(td) { border: 1px solid var(--border); padding: 4px 8px; }
  .md :global(hr) { border: 0; border-top: 1px solid currentColor; opacity: 0.3; }
</style>
