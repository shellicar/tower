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
  <div class="text">{block.text}</div>
{:else if block.type === 'thinking'}
  <details>
    <summary>thinking</summary>
    <div class="text dim">{block.thinking}</div>
  </details>
{:else if block.type === 'tool_use'}
  <button class="fold" onclick={() => (expanded = !expanded)}>
    ⚒ {block.name}
    {#if !expanded}<span class="dim">{short(block.input)}</span>{/if}
  </button>
  {#if expanded}
    <pre>{JSON.stringify(block.input, null, 2)}</pre>
  {/if}
{:else if block.type === 'tool_result'}
  {#if isRef(block.content)}
    <RefView ref={block.content} label="↩ result" />
  {:else}
    <button class="fold" onclick={() => (expanded = !expanded)}>
      ↩ result{block.is_error ? ' (error)' : ''}
      {#if !expanded}<span class="dim">{short(block.content)}</span>{/if}
    </button>
    {#if expanded}
      <pre>{typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content, null, 2)}</pre>
    {/if}
  {/if}
{:else if block.type === 'image'}
  {#if isRef(block.source)}
    <RefView ref={block.source} label="🖼 image" image />
  {:else}
    <span class="dim">🖼 image (inline)</span>
  {/if}
{:else if block.type === 'document'}
  {#if isRef(block.source)}
    <RefView ref={block.source} label="📄 document" />
  {:else}
    <span class="dim">📄 document (inline)</span>
  {/if}
{:else}
  <!-- Unknown block types: shown as a fold, never fatal (tolerance). -->
  <details>
    <summary class="dim">{block.type}</summary>
    <pre>{JSON.stringify(block, null, 2)}</pre>
  </details>
{/if}

<style>
  .text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .dim {
    color: #777;
  }
  .fold {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    color: #999;
    font: inherit;
    cursor: pointer;
    padding: 2px 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fold:hover {
    color: #ccc;
  }
  pre {
    background: #181818;
    padding: 8px;
    overflow-x: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin: 4px 0;
  }
  details summary {
    cursor: pointer;
    color: #999;
  }
</style>
