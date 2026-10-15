<script lang="ts">
  import { tick } from 'svelte';
  import { app, controller } from '../lib/chat/controller.svelte';
  import MessageBubble from '../components/MessageBubble.svelte';
  import Composer from '../components/Composer.svelte';

  let list: HTMLElement | undefined = $state();
  let showSas = $state(false);
  let stickToBottom = true;

  function onScroll() {
    if (!list) return;
    stickToBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  }

  // Keep the newest message in view unless the user has scrolled up to read history.
  $effect(() => {
    void app.items.length;
    void app.peerTyping;
    if (!stickToBottom) return;
    void tick().then(() => list?.scrollTo({ top: list.scrollHeight }));
  });

  function end() {
    if (confirm('End the chat? All messages and files will be erased on both phones.')) {
      void controller.endByUser();
    }
  }
</script>

<main class="chat">
  <header>
    <div class="who">
      <span class="dot" aria-hidden="true"></span>
      <div>
        <strong>{app.peerName}</strong>
        <button class="sas-toggle" onclick={() => (showSas = !showSas)} aria-expanded={showSas}>
          🔒 Encrypted · {showSas ? 'hide' : 'verify'}
        </button>
      </div>
    </div>
    <button class="btn small danger" onclick={end}>End</button>
  </header>

  {#if showSas}
    <div class="sas">
      <span>If {app.peerName}’s screen shows the same emoji, nobody is listening in.</span>
      <strong>{app.sas.join(' ')}</strong>
    </div>
  {/if}

  <section class="messages" bind:this={list} onscroll={onScroll} aria-live="polite">
    {#each app.items as item (item.id)}
      <MessageBubble {item} />
    {/each}
    {#if app.peerTyping}
      <div class="typing" aria-label="{app.peerName} is typing"><span></span><span></span><span></span></div>
    {/if}
  </section>

  <Composer />
</main>

<style>
  .chat {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 760px;
    margin: 0 auto;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .who { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .who strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); flex: none; box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 25%, transparent); }
  .sas-toggle {
    border: 0;
    background: none;
    padding: 0;
    font-size: 12px;
    color: var(--muted);
  }
  .sas {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 10px 16px;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    color: var(--muted);
    text-align: center;
  }
  .sas strong { font-size: 26px; letter-spacing: 0.1em; color: var(--text); }
  .messages {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 16px 12px;
    overscroll-behavior: contain;
  }
  .typing {
    align-self: flex-start;
    display: flex;
    gap: 4px;
    padding: 12px 14px;
    border-radius: 18px;
    background: var(--theirs);
    border: 1px solid var(--border);
  }
  .typing span {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--muted);
    animation: bounce 1.2s infinite ease-in-out;
  }
  .typing span:nth-child(2) { animation-delay: 0.15s; }
  .typing span:nth-child(3) { animation-delay: 0.3s; }
  @keyframes bounce { 0%, 60%, 100% { transform: translateY(0); opacity: 0.5; } 30% { transform: translateY(-4px); opacity: 1; } }
</style>
