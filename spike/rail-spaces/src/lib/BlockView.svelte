<script lang="ts">
  import type { Block } from './content';
  import { renderMarkdown } from './core/markdown';

  const { block, markdown = false }: { block: Block; markdown?: boolean } = $props();

  let expanded = $state(false);

  function short(value: unknown, max = 120): string {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    return s === undefined ? '' : s.length > max ? `${s.slice(0, max)}…` : s;
  }
</script>

{#if block.type === 'text'}
  {#if markdown}
    <div class="markdown-content wrap-anywhere">{@html renderMarkdown(block.text)}</div>
  {:else}
    <div class="wrap-anywhere whitespace-pre-wrap">{block.text}</div>
  {/if}
{:else if block.type === 'thinking'}
  <details>
    <summary class="cursor-pointer text-neutral-400">thinking</summary>
    <div class="wrap-anywhere whitespace-pre-wrap text-neutral-500">{block.thinking}</div>
  </details>
{:else if block.type === 'tool_use'}
  <button
    class="block w-full cursor-pointer truncate py-0.5 text-left text-neutral-400 hover:text-neutral-200"
    onclick={() => (expanded = !expanded)}
  >
    ⚒ {block.name}
    {#if !expanded}<span class="text-neutral-500">{short(block.input)}</span>{/if}
  </button>
  {#if expanded}
    <pre class="wrap-anywhere my-1 overflow-x-auto bg-neutral-900 p-2 whitespace-pre-wrap">{JSON.stringify(
        block.input,
        null,
        2,
      )}</pre>
  {/if}
{:else if block.type === 'tool_result'}
  <button
    class="block w-full cursor-pointer truncate py-0.5 text-left text-neutral-400 hover:text-neutral-200"
    onclick={() => (expanded = !expanded)}
  >
    ↩ result{block.is_error ? ' (error)' : ''}
    {#if !expanded}<span class="text-neutral-500">{short(block.content)}</span>{/if}
  </button>
  {#if expanded}
    <pre class="wrap-anywhere my-1 overflow-x-auto bg-neutral-900 p-2 whitespace-pre-wrap">{block.content}</pre>
  {/if}
{/if}
