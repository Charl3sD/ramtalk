<script lang="ts">
  import { app, controller } from './lib/chat/controller.svelte';
  import Home from './screens/Home.svelte';
  import Pairing from './screens/Pairing.svelte';
  import Chat from './screens/Chat.svelte';

  // Leaving or reloading the page ends the chat and wipes it; ask first while a chat is open.
  function onBeforeUnload(e: BeforeUnloadEvent) {
    if (app.screen === 'chat') e.preventDefault();
  }
  function onPageHide() {
    controller.end('The app was closed, so the chat ended.');
  }
</script>

<svelte:window onbeforeunload={onBeforeUnload} onpagehide={onPageHide} />

{#if app.screen === 'home'}
  <Home />
{:else if app.screen === 'host' || app.screen === 'join'}
  <Pairing />
{:else}
  <Chat />
{/if}
