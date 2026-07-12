<script lang="ts">
  import MessageView from './MessageView.svelte';
  import { tower, type OpenConversation } from './tower.svelte';

  let { oc }: { oc: OpenConversation } = $props();

  let draft = $state('');
  let scroller: HTMLDivElement | undefined = $state();
  let editor: HTMLTextAreaElement | undefined = $state();

  // The anchor is user intent, never a measurement: it changes on exactly
  // two gestures — scrolling away (unanchor) and returning to the bottom by
  // scroll or button (anchor). Content height, editor growth, and sends
  // never touch it. A panel opens anchored.
  let anchored = $state(true);
  // Set while *we* move the scroll, so the scroll event it fires isn't
  // mistaken for the reader scrolling away.
  let pinning = false;

  function pin() {
    if (!scroller) return;
    pinning = true;
    scroller.scrollTop = scroller.scrollHeight;
    requestAnimationFrame(() => (pinning = false));
  }

  function onscroll() {
    if (pinning || !scroller) return;
    // A genuine gesture: at the bottom (small tolerance for fractional
    // pixels) means anchored; anywhere above means the reader left.
    anchored = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 2;
  }

  // Auto-grow the editor to its content (the max-h class caps it; beyond
  // that it scrolls) so the line being typed is never below the fold.
  function autosize() {
    if (!editor) return;
    editor.style.height = 'auto';
    editor.style.height = `${editor.scrollHeight}px`;
    if (anchored) pin(); // editor growth steals viewport; keep the pin
  }

  // While anchored, re-pin on any geometry change — catch-up, new message,
  // streaming chunk. While unanchored, never move.
  $effect(() => {
    void oc.messages.length;
    void oc.streaming;
    void oc.loaded;
    if (anchored) pin();
  });

  function submit() {
    const text = draft.trim();
    if (!text) return;
    tower.say(oc.conv, text);
    draft = '';
    // Deliberately no re-anchor: a reader scrolled up for a reason stays
    // exactly where they are.
    requestAnimationFrame(autosize); // shrink back after the bind clears
  }

  // Enter is a newline; Cmd+Enter (mac) / Ctrl+Enter submits.
  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  }
</script>

<section class="flex h-screen min-w-[480px] flex-1 flex-col border-r border-neutral-700">
  <header class="flex items-center justify-between border-b border-neutral-700 px-3 py-2">
    <span class="truncate text-sky-300">{oc.conv}</span>
    <button
      class="cursor-pointer text-base text-neutral-400 hover:text-neutral-200"
      onclick={() => tower.closeConversation(oc.conv)}>×</button
    >
  </header>

  <div class="relative min-h-0 flex-1">
    <div class="h-full overflow-y-auto px-3 py-2" bind:this={scroller} {onscroll}>
      {#if !oc.loaded}
        <p class="text-neutral-500">loading…</p>
      {/if}
      {#each oc.messages as message (message.id)}
        <MessageView {message} />
      {/each}
      {#if oc.streaming}
        <div class="my-2 whitespace-pre-wrap border-l-2 border-indigo-800 pl-2 text-indigo-200">
          {oc.streaming}
        </div>
      {/if}
    </div>
    {#if !anchored}
      <button
        class="absolute bottom-2 left-1/2 -translate-x-1/2 cursor-pointer rounded border border-neutral-600 bg-neutral-900/90 px-3 py-1 text-neutral-300 hover:text-neutral-100"
        onclick={() => {
          anchored = true;
          pin();
        }}
      >
        ↓ latest
      </button>
    {/if}
  </div>

  <div class="border-t border-neutral-700 px-3 py-2">
    {#if oc.lastSay}
      <p class="mb-1.5 text-orange-300">{oc.lastSay}</p>
    {/if}
    <textarea
      class="max-h-48 min-h-16 w-full resize-none border border-neutral-700 bg-neutral-900 px-2 py-1.5"
      bind:value={draft}
      bind:this={editor}
      oninput={autosize}
      {onkeydown}
      placeholder="say… (⌘↩ to send)"
    ></textarea>
  </div>
</section>
