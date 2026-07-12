<script lang="ts">
  import type { Ref } from './types';

  // A `$ref` node: the protocol supplies facts (id, size, hint); how it
  // materialises is entirely this client's policy. Policy here: nothing
  // fetches until asked — "load · 513 KB" — and images become object URLs.
  // The route /ref/{id} is this client's own knowledge, never carried in data.
  let { ref, label, image = false }: { ref: Ref; label: string; image?: boolean } = $props();

  let loaded = $state<string | null>(null); // text content or object URL
  let failed = $state(false);

  function size(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function load() {
    try {
      const res = await fetch(`/ref/${ref.$ref}`);
      if (!res.ok) throw new Error();
      if (image) {
        // The stored value is the source object's JSON ({type, media_type, data}).
        const source = await res.json();
        loaded = `data:${source.media_type};base64,${source.data}`;
      } else {
        loaded = await res.text();
      }
    } catch {
      failed = true;
    }
  }
</script>

{#if loaded}
  {#if image}
    <img src={loaded} alt={ref.hint} />
  {:else}
    <pre>{loaded}</pre>
  {/if}
{:else if failed}
  <span class="dim">{label} · {size(ref.size)} · fetch failed</span>
{:else}
  <button class="fold" onclick={load}>
    {label} · {ref.hint} · load {size(ref.size)}
  </button>
{/if}

<style>
  .fold {
    display: block;
    background: none;
    border: 1px dashed #444;
    color: #999;
    font: inherit;
    cursor: pointer;
    padding: 4px 8px;
    margin: 4px 0;
  }
  .fold:hover {
    color: #ccc;
    border-color: #666;
  }
  .dim {
    color: #777;
  }
  pre {
    background: #181818;
    padding: 8px;
    overflow-x: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin: 4px 0;
    max-height: 400px;
    overflow-y: auto;
  }
  img {
    max-width: 100%;
    margin: 4px 0;
  }
</style>
