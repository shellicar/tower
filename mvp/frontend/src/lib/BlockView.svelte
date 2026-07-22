<script lang="ts">
  import MarkdownRenderer from './MarkdownRenderer.svelte';
  import RefView from './RefView.svelte';
  import { isRef, type ContentBlock } from './types';

  let { block, markdown = false }: { block: ContentBlock; markdown?: boolean } = $props();

  // Per-message collapsing is the primary render lever: tool traffic and
  // thinking fold to summary lines; text stands open.
  let expanded = $state(false);

  function short(value: unknown, max = 120): string {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    return s === undefined ? '' : s.length > max ? s.slice(0, max) + '…' : s;
  }

  // An attachment reference block: bytes lived in the transit store and are
  // the servicer's once fetched. The chip states the fact (type, size); a
  // click previews via GET /attachment/{id} WHILE the object lives — past
  // the transit TTL the fetch honestly 404s and the chip stays a fact.
  const objectSource = $derived(
    (block.source as { type?: string; id?: string; mediaType?: string; size?: number } | undefined)
      ?.type === 'object'
      ? (block.source as { id?: string; mediaType?: string; size?: number })
      : null,
  );
  let previewFailed = $state(false);

  function sizeLabel(n?: number): string {
    if (!n) return '';
    if (n < 1024) return `· ${n} B`;
    if (n < 1024 * 1024) return `· ${Math.round(n / 1024)} KB`;
    return `· ${(n / (1024 * 1024)).toFixed(1)} MB`;
  }
</script>

{#if block.type === 'text'}
  {#if markdown}
    <MarkdownRenderer text={String(block.text)} />
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
  {:else if objectSource}
    <details>
      <summary class="cursor-pointer text-neutral-500"
        >📎 {objectSource.mediaType ?? 'image'} {sizeLabel(objectSource.size)} (attachment)</summary
      >
      {#if previewFailed}
        <span class="text-neutral-500">preview expired — the transit object is gone</span>
      {:else}
        <img
          class="my-1 max-h-96 max-w-full"
          src={`/attachment/${objectSource.id}`}
          alt={objectSource.mediaType ?? 'attachment'}
          onerror={() => (previewFailed = true)}
        />
      {/if}
    </details>
  {:else}
    <span class="text-neutral-500">🖼 image (inline)</span>
  {/if}
{:else if block.type === 'document'}
  {#if isRef(block.source)}
    <RefView ref={block.source} label="📄 document" />
  {:else if objectSource}
    <a
      class="text-neutral-500 hover:text-neutral-300"
      href={`/attachment/${objectSource.id}`}
      target="_blank"
      rel="noreferrer"
      >📎 {objectSource.mediaType ?? 'document'} {sizeLabel(objectSource.size)} (attachment)</a
    >
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
