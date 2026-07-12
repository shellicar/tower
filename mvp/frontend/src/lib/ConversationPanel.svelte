<script lang="ts">
  import MessageView from './MessageView.svelte';
  import { tower, type OpenConversation } from './tower.svelte';

  let { oc }: { oc: OpenConversation } = $props();

  let draft = $state('');
  let scroller: HTMLDivElement | undefined = $state();
  let jumped = $state(false);

  // The latest message is the point of opening: jump to the bottom once the
  // catch-up renders. After that, follow the tail only while the reader is
  // at it — never yank them up from a scroll-back.
  $effect(() => {
    void oc.messages.length;
    void oc.streaming;
    if (!scroller) return;
    if (!jumped) {
      if (oc.loaded) {
        scroller.scrollTop = scroller.scrollHeight;
        jumped = true;
      }
      return;
    }
    const nearBottom =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    if (nearBottom) scroller.scrollTop = scroller.scrollHeight;
  });

  function submit() {
    const text = draft.trim();
    if (!text) return;
    tower.say(oc.conv, text);
    draft = '';
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

  <div class="flex-1 overflow-y-auto px-3 py-2" bind:this={scroller}>
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

  <div class="border-t border-neutral-700 px-3 py-2">
    {#if oc.lastSay}
      <p class="mb-1.5 text-orange-300">{oc.lastSay}</p>
    {/if}
    <textarea
      class="max-h-48 min-h-16 w-full resize-y border border-neutral-700 bg-neutral-900 px-2 py-1.5"
      bind:value={draft}
      {onkeydown}
      placeholder="say… (⌘↩ to send)"
    ></textarea>
  </div>
</section>
