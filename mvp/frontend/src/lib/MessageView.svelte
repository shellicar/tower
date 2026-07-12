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
  const edge = $derived(
    message.role === 'assistant'
      ? 'border-green-800'
      : message.role === 'user'
        ? 'border-indigo-800'
        : 'border-neutral-600',
  );
</script>

<article class="my-2 border-l-2 py-1.5 pl-2 {edge}">
  <header class="mb-1 flex gap-2 text-neutral-400">
    <span class="text-neutral-300">{who}</span>
    <span>{time}</span>
  </header>
  {#each message.content as block, i (i)}
    <BlockView {block} />
  {/each}
</article>
