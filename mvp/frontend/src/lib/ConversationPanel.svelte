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

  function submit(e: SubmitEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    tower.say(oc.conv, text);
    draft = '';
  }
</script>

<section>
  <header>
    <span class="conv">{oc.conv}</span>
    <button onclick={() => tower.closeConversation(oc.conv)}>×</button>
  </header>

  <div class="messages" bind:this={scroller}>
    {#if !oc.loaded}
      <p class="note">loading…</p>
    {/if}
    {#each oc.messages as message (message.id)}
      <MessageView {message} />
    {/each}
    {#if oc.streaming}
      <div class="streaming">{oc.streaming}</div>
    {/if}
  </div>

  <form onsubmit={submit}>
    {#if oc.lastSay}
      <p class="say-note">{oc.lastSay}</p>
    {/if}
    <input bind:value={draft} placeholder="say…" />
  </form>
</section>

<style>
  section {
    display: flex;
    flex-direction: column;
    min-width: 480px;
    flex: 1;
    border-right: 1px solid #333;
    height: 100vh;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    border-bottom: 1px solid #333;
  }
  .conv {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #9cf;
  }
  header button {
    background: none;
    border: none;
    color: #888;
    font-size: 16px;
    cursor: pointer;
  }
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 8px 12px;
  }
  .note {
    color: #666;
  }
  .streaming {
    white-space: pre-wrap;
    color: #aac;
    border-left: 2px solid #557;
    padding-left: 8px;
    margin: 8px 0;
  }
  form {
    border-top: 1px solid #333;
    padding: 8px 12px;
  }
  .say-note {
    margin: 0 0 6px;
    color: #c96;
  }
  input {
    width: 100%;
    box-sizing: border-box;
    background: #1a1a1a;
    border: 1px solid #333;
    color: inherit;
    font: inherit;
    padding: 6px 8px;
  }
</style>
