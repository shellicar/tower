<script lang="ts">
  import BlockView from './BlockView.svelte';
  import { senderLabel } from './core/sender';
  import { rowOf } from './core/extras';
  import type { ConversationMessage } from './types';

  // `replaced`: a compaction took this message out of what the model is sent.
  let { message, replaced = false }: { message: ConversationMessage; replaced?: boolean } =
    $props();

  const who = $derived(senderLabel(message));
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
  const row = $derived(rowOf(message, who));
</script>

{#snippet marks()}
  {#if replaced}
    <span class="text-neutral-500">· no longer sent to the model</span>
  {/if}
{/snippet}

<div class:opacity-40={replaced}>
  {#if row.variant === 'model-only'}
    <article class="my-2 border-l-2 border-dashed border-neutral-700 py-1.5 pl-2 opacity-70">
      <header class="mb-1 flex gap-2 text-neutral-500">
        <span>model only · {row.label}</span>
        <span>{time}</span>
        {@render marks()}
      </header>
      {#each row.blocks as block, i (i)}
        <div class="max-h-24 overflow-hidden text-neutral-500">
          <BlockView {block} />
        </div>
      {/each}
    </article>
  {:else if row.variant === 'line'}
    <div class="my-1 pl-2 text-neutral-500">
      {row.text}
      {@render marks()}
    </div>
  {:else if row.variant === 'notice'}
    <div class="my-1 pl-2">
      <span class={row.failed ? 'text-red-500' : 'text-green-500'}>●</span>
      <span class="text-neutral-300">{row.text}</span>
      <span class="text-neutral-500">{time}</span>
      {@render marks()}
    </div>
  {:else if row.variant === 'folded'}
    <details
      class="my-2 border-l-2 py-1.5 pl-2 {row.tone === 'compaction'
        ? 'border-amber-800'
        : 'border-indigo-800'}"
    >
      <summary
        class="cursor-pointer {row.tone === 'compaction' ? 'text-amber-300' : 'text-neutral-400'}"
      >
        {row.label}
        {#if row.detail}<span class="text-neutral-500">{row.detail}</span>{/if}
        <span class="text-neutral-500">{time}</span>
        {@render marks()}
      </summary>
      {#each row.blocks as block, i (i)}
        <BlockView {block} />
      {/each}
    </details>
  {:else if row.variant === 'error'}
    <article class="my-2 border-l-2 border-red-700 py-1.5 pl-2">
      <header class="mb-1 flex gap-2 text-red-400">
        <span>API error</span>
        {#if row.detail}<span class="text-neutral-500">{row.detail}</span>{/if}
        <span class="text-neutral-500">{time}</span>
      </header>
      {#each row.blocks as block, i (i)}
        <div class="text-red-300"><BlockView {block} /></div>
      {/each}
    </article>
  {:else}
    <article class="my-2 border-l-2 py-1.5 pl-2 {edge}">
      <header class="mb-1 flex gap-2 text-neutral-400">
        <span class="text-neutral-300">{who}</span>
        <span>{time}</span>
        {@render marks()}
      </header>
      {#each row.blocks as block, i (i)}
        <BlockView {block} markdown={message.role === 'assistant'} />
      {/each}
    </article>
  {/if}
</div>
