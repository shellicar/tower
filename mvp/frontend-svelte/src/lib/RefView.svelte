<script lang="ts">
  import type { Ref } from './types';

  // A `$ref` node: the protocol supplies facts (id, size, hint); how it
  // materialises is entirely this client's policy. Policy here: nothing
  // fetches until asked — "load · 513 KB" — and images become data URLs.
  // The route /ref/{id} is this client's own knowledge, never carried in data.
  let { ref, label, image = false }: { ref: Ref; label: string; image?: boolean } = $props();

  let loaded = $state<string | null>(null); // text content or data URL
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
    <img class="my-1 max-w-full" src={loaded} alt={ref.hint} />
  {:else}
    <pre class="wrap-anywhere my-1 max-h-[400px] overflow-x-auto overflow-y-auto bg-neutral-900 p-2 whitespace-pre-wrap">{loaded}</pre>
  {/if}
{:else if failed}
  <span class="text-neutral-500">{label} · {size(ref.size)} · fetch failed</span>
{:else}
  <button
    class="my-1 block cursor-pointer border border-dashed border-neutral-600 px-2 py-1 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
    onclick={load}
  >
    {label} · {ref.hint} · load {size(ref.size)}
  </button>
{/if}
