<script lang="ts">
  import { controller } from '../lib/chat/controller.svelte';
  import EmojiPanel from './EmojiPanel.svelte';

  let text = $state('');
  let error = $state('');
  let showEmoji = $state(false);
  let textarea: HTMLTextAreaElement | undefined = $state();
  let fileInput: HTMLInputElement | undefined = $state();
  let cameraInput: HTMLInputElement | undefined = $state();

  // On touch devices Enter inserts a newline and the send button sends; with a keyboard,
  // Enter sends and Shift+Enter inserts a newline.
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

  $effect(() => {
    void text;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  });

  async function send() {
    if (!text.trim()) return;
    const value = text;
    text = '';
    error = (await controller.sendText(value)) ?? '';
    if (error) text = value;
    textarea?.focus();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !coarse && !e.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  function onInput() {
    error = '';
    controller.notifyTyping();
  }

  /** Wraps the selection in markdown markers, or inserts them around the caret. */
  function wrap(before: string, after = before) {
    if (!textarea) return;
    const { selectionStart: s, selectionEnd: e } = textarea;
    const selected = text.slice(s, e);
    text = text.slice(0, s) + before + selected + after + text.slice(e);
    requestAnimationFrame(() => {
      textarea!.focus();
      textarea!.setSelectionRange(s + before.length, e + before.length);
    });
  }

  function prefixLines(prefix: string) {
    if (!textarea) return;
    const { selectionStart: s, selectionEnd: e } = textarea;
    const lineStart = text.lastIndexOf('\n', s - 1) + 1;
    const block = text.slice(lineStart, e);
    const replaced = block.split('\n').map((l) => prefix + l).join('\n');
    text = text.slice(0, lineStart) + replaced + text.slice(e);
    requestAnimationFrame(() => {
      textarea!.focus();
      const end = lineStart + replaced.length;
      textarea!.setSelectionRange(end, end);
    });
  }

  function insert(str: string) {
    const s = textarea?.selectionStart ?? text.length;
    const e = textarea?.selectionEnd ?? text.length;
    text = text.slice(0, s) + str + text.slice(e);
    requestAnimationFrame(() => {
      if (coarse) return; // don't pop the keyboard over the emoji panel on phones
      textarea?.focus();
      textarea?.setSelectionRange(s + str.length, s + str.length);
    });
  }

  function onFiles(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files?.length) controller.sendFiles(Array.from(input.files));
    input.value = '';
  }

  function onPaste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length) {
      e.preventDefault();
      controller.sendFiles(files);
    }
  }
</script>

<footer class="composer">
  {#if showEmoji}
    <EmojiPanel onpick={insert} onclose={() => (showEmoji = false)} />
  {/if}
  {#if error}<p class="err" role="alert">{error}</p>{/if}

  <div class="toolbar" role="toolbar" aria-label="Formatting">
    <button onclick={() => wrap('**')} title="Bold" aria-label="Bold"><b>B</b></button>
    <button onclick={() => wrap('_')} title="Italic" aria-label="Italic"><i>I</i></button>
    <button onclick={() => wrap('~~')} title="Strikethrough" aria-label="Strikethrough"><s>S</s></button>
    <button onclick={() => wrap('`')} title="Code" aria-label="Code"><code>{'</>'}</code></button>
    <button onclick={() => prefixLines('- ')} title="List" aria-label="Bulleted list">•≡</button>
    <button onclick={() => prefixLines('> ')} title="Quote" aria-label="Quote">❝</button>
    <span class="spacer"></span>
    <button onclick={() => (showEmoji = !showEmoji)} title="Emoji" aria-label="Emoji" aria-pressed={showEmoji}>😊</button>
    <button onclick={() => cameraInput?.click()} title="Take a photo" aria-label="Take a photo">📷</button>
    <button onclick={() => fileInput?.click()} title="Attach files" aria-label="Attach files">📎</button>
  </div>

  <div class="input-row">
    <textarea
      bind:this={textarea}
      bind:value={text}
      onkeydown={onKeydown}
      oninput={onInput}
      onpaste={onPaste}
      rows="1"
      placeholder="Message (markdown supported)"
      aria-label="Message"
      enterkeyhint={coarse ? 'enter' : 'send'}
    ></textarea>
    <button class="send" onclick={send} disabled={!text.trim()} aria-label="Send">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12.6 2-12.6 2z" /></svg>
    </button>
  </div>

  <input bind:this={fileInput} type="file" multiple hidden onchange={onFiles} />
  <input bind:this={cameraInput} type="file" accept="image/*" capture="environment" hidden onchange={onFiles} />
</footer>

<style>
  .composer {
    position: relative;
    border-top: 1px solid var(--border);
    background: var(--surface);
    padding: 6px 10px calc(10px + env(safe-area-inset-bottom));
  }
  .err { margin: 4px 6px; color: var(--danger); font-size: 13px; }
  .toolbar { display: flex; align-items: center; gap: 2px; padding-bottom: 6px; }
  .toolbar button {
    min-width: 38px;
    height: 34px;
    border: 0;
    border-radius: 8px;
    background: none;
    color: var(--muted);
    font-size: 15px;
  }
  .toolbar button:hover, .toolbar button[aria-pressed='true'] { background: var(--surface-2); color: var(--text); }
  .toolbar code { font-family: var(--mono); font-size: 12px; }
  .spacer { flex: 1; }
  .input-row { display: flex; align-items: flex-end; gap: 8px; }
  textarea {
    flex: 1;
    resize: none;
    font: inherit;
    font-size: 16px;
    line-height: 1.35;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 10px 14px;
    max-height: 180px;
  }
  textarea:focus { outline: 2px solid var(--accent); outline-offset: 0; }
  .send {
    flex: none;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: 0;
    background: var(--accent);
    color: var(--accent-ink);
    display: grid;
    place-items: center;
  }
</style>
