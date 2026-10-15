<script lang="ts">
  import { app, controller } from '../lib/chat/controller.svelte';
  import QrView from '../components/QrView.svelte';
  import QrScanner from '../components/QrScanner.svelte';

  const isHost = $derived(app.screen === 'host');
  const busy = $derived(app.step === 'camera' || app.step === 'preparing' || app.step === 'connecting' || app.step === 'verifying');

  const busyLabel = $derived(
    app.step === 'camera'
      ? 'Opening the camera…'
      : app.step === 'preparing'
        ? 'Preparing a secure code…'
        : app.step === 'connecting'
          ? 'Connecting…'
          : 'Securing the chat…',
  );
</script>

<main class="pairing">
  <header>
    <button class="btn ghost small" onclick={() => controller.cancelPairing()}>Cancel</button>
    <h1>{isHost ? 'Start a conversation' : 'Join a conversation'}</h1>
  </header>

  <section class="body">
    {#if busy}
      <div class="busy">
        <div class="spinner"></div>
        <p>{busyLabel}</p>
        {#if app.step === 'connecting'}
          <p class="hint">Keep both phones on the same Wi-Fi or hotspot.</p>
        {/if}
      </div>
    {:else if app.step === 'show'}
      <p class="step">{isHost ? 'Step 1 of 2' : 'Step 2 of 2'}</p>
      <h2>{isHost ? 'Let them scan this code' : 'Now let them scan this code'}</h2>
      <QrView text={app.qrText} />
      {#if isHost}
        <button class="btn primary" onclick={() => controller.hostReadyToScan()}>They’ve scanned it, scan their reply</button>
      {:else}
        <div class="waiting"><div class="spinner"></div><span>Waiting for them to scan…</span></div>
      {/if}
    {:else if app.step === 'scan' && app.stream}
      <p class="step">{isHost ? 'Step 2 of 2' : 'Step 1 of 2'}</p>
      <h2>{isHost ? 'Scan the reply on their screen' : 'Scan the code on their screen'}</h2>
      <QrScanner stream={app.stream} onresult={(t) => controller.onScan(t)} />
      {#if isHost}
        <button class="btn ghost" onclick={() => controller.hostShowCode()}>Show my code again</button>
      {/if}
    {/if}

    {#if app.pairingError}
      <p class="err" role="alert">{app.pairingError}</p>
    {/if}

    {#if app.sas.length && app.step !== 'scan'}
      <div class="sas">
        <span>Security check: both screens should show</span>
        <strong aria-label="Security emoji">{app.sas.join(' ')}</strong>
      </div>
    {/if}
  </section>
</main>

<style>
  .pairing {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 520px;
    margin: 0 auto;
    padding: 12px 20px calc(24px + env(safe-area-inset-bottom));
  }
  header {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 8px;
  }
  header h1 {
    margin: 0;
    font-size: 17px;
    text-align: center;
  }
  header::after { content: ''; width: 72px; }
  .body {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 16px;
    text-align: center;
    padding-top: 12px;
  }
  .step { margin: 0; color: var(--accent); font-weight: 600; font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; }
  h2 { margin: 0; font-size: 21px; }
  .busy { display: flex; flex-direction: column; align-items: center; gap: 12px; color: var(--muted); }
  .busy p { margin: 0; }
  .hint { font-size: 14px; }
  .waiting { display: flex; align-items: center; justify-content: center; gap: 12px; color: var(--muted); }
  .waiting .spinner { width: 20px; height: 20px; border-width: 2px; }
  .err { color: var(--danger); margin: 0; }
  .sas {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px;
    border-radius: var(--radius);
    background: var(--surface);
    border: 1px solid var(--border);
    font-size: 14px;
    color: var(--muted);
  }
  .sas strong { font-size: 28px; letter-spacing: 0.1em; color: var(--text); }
</style>
