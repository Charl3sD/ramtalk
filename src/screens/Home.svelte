<script lang="ts">
  import { app, controller } from '../lib/chat/controller.svelte';

  let name = $state(app.myName);
</script>

<main class="home">
  <header>
    <img src="icon.svg" alt="" width="64" height="64" />
    <h1>ramtalk</h1>
    <p class="tag">Private chat between two phones in the same place. No accounts, no servers, nothing saved.</p>
  </header>

  {#if app.notice}
    <div class="notice" role="status">
      <span>{app.notice}</span>
      <span class="sub">All messages and files from that chat were erased.</span>
      <button class="btn ghost small" onclick={() => (app.notice = '')}>Dismiss</button>
    </div>
  {/if}

  <label class="name">
    <span>Your name (shown to the other person)</span>
    <input
      bind:value={name}
      onchange={() => controller.setName(name)}
      maxlength="40"
      placeholder="Optional"
      autocomplete="nickname"
      enterkeyhint="done"
    />
  </label>

  <div class="actions">
    <button class="btn primary" onclick={() => { controller.setName(name); void controller.startHost(); }}>
      Start a conversation
    </button>
    <button class="btn" onclick={() => { controller.setName(name); void controller.startJoin(); }}>
      Join a conversation
    </button>
  </div>

  <details class="how">
    <summary>How it works</summary>
    <ol>
      <li><strong>Connect both phones to the same network:</strong> the same Wi-Fi, or one phone turns on its hotspot and the other joins it. No internet is needed.</li>
      <li>One person taps <em>Start</em> and shows their code. The other taps <em>Join</em> and scans it.</li>
      <li>The joiner then shows a reply code, and the starter scans it.</li>
      <li>Check that both screens show the same emoji. The chat is end-to-end encrypted with keys that exist only for this conversation.</li>
      <li>Ending the chat, leaving the app or losing the connection erases everything. Save received files before you end the chat.</li>
    </ol>
  </details>
</main>

<style>
  .home {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 24px;
    width: 100%;
    max-width: 480px;
    margin: 0 auto;
    padding: 32px 20px calc(24px + env(safe-area-inset-bottom));
  }
  header { text-align: center; }
  header img { border-radius: 16px; }
  h1 { margin: 8px 0 4px; font-size: 28px; letter-spacing: -0.02em; }
  .tag { margin: 0; color: var(--muted); }
  .notice {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 14px 16px;
    border-radius: var(--radius);
    background: var(--surface);
    border: 1px solid var(--border);
    border-left: 4px solid var(--warn);
  }
  .notice .sub { color: var(--muted); font-size: 14px; }
  .notice button { align-self: flex-end; }
  .name { display: flex; flex-direction: column; gap: 6px; font-size: 14px; color: var(--muted); }
  .name input {
    font: inherit;
    font-size: 16px;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 12px 14px;
  }
  .name input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .actions { display: flex; flex-direction: column; gap: 12px; }
  .how {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px 16px;
    font-size: 15px;
  }
  .how summary { cursor: pointer; font-weight: 600; }
  .how ol { padding-left: 20px; margin: 12px 0 4px; display: flex; flex-direction: column; gap: 8px; color: var(--muted); }
  .how strong, .how em { color: var(--text); }
</style>
