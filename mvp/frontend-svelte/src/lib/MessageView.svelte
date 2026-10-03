<script lang="ts">
  import BlockView from './BlockView.svelte';
  import { senderLabel } from './core/sender';
  import { firstLine, type MessageRow } from './core/visibleRows';

  let { row }: { row: MessageRow } = $props();

  const message = $derived(row.message);
  const who = $derived(senderLabel(message));
  const time = $derived(
    new Date(row.time).toLocaleTimeString(undefined, { hour12: false }),
  );
  const edge = $derived(
    message.role === 'assistant'
      ? 'border-green-800'
      : message.role === 'user'
        ? 'border-indigo-800'
        : 'border-neutral-600',
  );

  // An agent's hand-back is a report: one line until the reader opens it.
  let expanded = $state(false);
  const summary = $derived(firstLine(row.content));
</script>

<article class="my-2 border-l-2 py-1.5 pl-2 {edge}" class:opacity-40={row.dimmed}>
  <header class="mb-1 flex gap-2 text-neutral-400">
    <span class="text-neutral-300">{who}</span>
    <span>{time}</span>
  </header>
  {#if row.scopeNote}
    <p class="mb-1 text-amber-300">Earlier messages are no longer sent to the model</p>
  {/if}
  {#if row.collapsed && !expanded}
    <button
      class="block w-full cursor-pointer truncate text-left text-neutral-300 hover:text-neutral-100"
      onclick={() => (expanded = true)}>▸ {summary || '(no text)'}</button
    >
  {:else}
    {#if row.collapsed}
      <button
        class="mb-1 cursor-pointer text-neutral-400 hover:text-neutral-200"
        onclick={() => (expanded = false)}>▾ collapse</button
      >
    {/if}
    {#each row.content as block, i (i)}
      <BlockView {block} markdown={message.role === 'assistant'} />
    {/each}
  {/if}
</article>
