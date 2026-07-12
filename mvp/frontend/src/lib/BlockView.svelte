<script lang="ts">
  import RefView from './RefView.svelte';
  import { isRef, type ContentBlock } from './types';

  let { block }: { block: ContentBlock } = $props();

  // Per-message collapsing is the primary render lever: tool traffic and
  // thinking fold to summary lines; text stands open.
  let expanded = $state(false);

  function short(value: unknown, max = 120): string {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    return s === undefined ? '' : s.length > max ? s.slice(0, max) + '…' : s;
  }
</script>

{#if block.type === 'text'}
  <div class="wrap-anywhere whitespace-pre-wrap">{block.text}</div>
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
    <pre class="wrap-anywhere my-1 overflow-x-auto bg-neutral-900 p-2 whitespace-pre-wrap">{JSON.stringify(block.input, null, 2)}</pre>
  {/if}
{:else if block.type === 'tool_result'}
  {#if isRef(block.content)}
    <RefView ref={block.content} label="↩ result" />
  {:else}
    <button
      class="block w-full cursor-pointer truncate py-0.5 text-left text-neutral-400 hover:text-neutral-200"
      onclick={() => (expanded = !expanded)}
    >
      ↩ result{block.is_error ? ' (error)' : ''}
      {#if !expanded}<span class="text-neutral-500">{short(block.content)}</span>{/if}
    </button>
    {#if expanded}
      <pre class="wrap-anywhere my-1 overflow-x-auto bg-neutral-900 p-2 whitespace-pre-wrap">{typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content, null, 2)}</pre>
    {/if}
  {/if}
{:else if block.type === 'image'}
  {#if isRef(block.source)}
    <RefView ref={block.source} label="🖼 image" image />
  {:else}
    <span class="text-neutral-500">🖼 image (inline)</span>
  {/if}
{:else if block.type === 'document'}
  {#if isRef(block.source)}
    <RefView ref={block.source} label="📄 document" />
  {:else}
    <span class="text-neutral-500">📄 document (inline)</span>
  {/if}
{:else}
  <!-- Unknown block types: shown as a fold, never fatal (tolerance). -->
  <details>
    <summary class="cursor-pointer text-neutral-500">{block.type}</summary>
    <pre class="wrap-anywhere my-1 overflow-x-auto bg-neutral-900 p-2 whitespace-pre-wrap">{JSON.stringify(block, null, 2)}</pre>
  </details>
{/if}
