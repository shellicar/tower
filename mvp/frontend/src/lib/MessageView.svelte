<script lang="ts">
  import BlockView from './BlockView.svelte';
  import type { ConversationMessage } from './types';

  let { message }: { message: ConversationMessage } = $props();

  const who = $derived(
    message.from?.userId ?? message.from?.kind ?? message.role,
  );
  const time = $derived(
    new Date(message.ts).toLocaleTimeString(undefined, { hour12: false }),
  );
</script>

<article class={message.role}>
  <header>
    <span class="who">{who}</span>
    <span class="time">{time}</span>
  </header>
  {#each message.content as block, i (i)}
    <BlockView {block} />
  {/each}
</article>

<style>
  article {
    margin: 8px 0;
    padding: 6px 8px;
    border-left: 2px solid #444;
  }
  article.assistant {
    border-left-color: #575;
  }
  article.user {
    border-left-color: #557;
  }
  header {
    display: flex;
    gap: 8px;
    color: #888;
    margin-bottom: 4px;
  }
  .who {
    color: #aaa;
  }
</style>
