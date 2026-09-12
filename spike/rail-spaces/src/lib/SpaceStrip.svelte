<script lang="ts">
  import type { Space } from '../model/layout';
  import type { Live } from './reactive.svelte';

  const { live, staleCount }: { live: Live; staleCount: (convs: string[]) => number } = $props();

  function create(parent: string | null, name: string | null) {
    if (name === null || name.trim() === '') return;
    live.act((m) => m.createSpace(crypto.randomUUID(), name.trim(), parent));
  }

  function remove(space: Space) {
    const held = live.model.placedIn(space.id).length;
    if (!confirm(`Delete space “${space.name}”? ${held} conversation(s) in it end up living nowhere.`)) return;
    live.act((m) => m.deleteSpace(space.id));
  }
</script>

{#snippet chip(space: Space, depth: number)}
  {@const shown = live.model.shownSpace === space.id}
  {@const placed = live.model.placedIn(space.id)}
  <span
    class="flex items-baseline gap-1.5 rounded-t border border-b-0 px-2.5 py-0.5 text-xs {shown
      ? 'border-neutral-600 bg-neutral-900 text-neutral-100'
      : 'border-neutral-800 text-neutral-500'}"
  >
    {#if depth > 0}<span class="text-neutral-700">{'▸'.repeat(depth)}</span>{/if}
    <button
      class="cursor-pointer"
      onclick={() =>
        shown ? create(space.id, prompt(`a space inside “${space.name}”`)) : live.act((m) => m.showSpace(space.id))}
      title={shown ? 'add a space inside this one' : 'stand in this space'}>{space.name}</button
    >
    {#if staleCount(placed) > 0}
      <span class="text-sky-300" title="unread in this space">● {staleCount(placed)}</span>
    {/if}
    <span class="text-neutral-600" title="drawn / placed"
      >{live.model.drawnIn(space.id).length}/{placed.length}</span
    >
    {#if shown}
      <button class="cursor-pointer text-neutral-600 hover:text-red-400" onclick={() => remove(space)}>×</button>
    {/if}
  </span>
  {#each live.model.children(space.id) as child (child.id)}
    {@render chip(child, depth + 1)}
  {/each}
{/snippet}

<div class="flex flex-wrap items-baseline gap-1 border-b border-neutral-700 px-2 pt-1">
  {#each live.model.children(null) as top (top.id)}
    {@render chip(top, 0)}
  {/each}
  <button
    class="cursor-pointer px-1.5 text-neutral-500 hover:text-neutral-200"
    title="a new space at the top level"
    onclick={() => create(null, prompt('space name'))}>+</button
  >
  <button
    class="cursor-pointer px-1.5 text-xs {live.model.shownSpace === null
      ? 'text-neutral-300'
      : 'text-neutral-600 hover:text-neutral-300'}"
    title="stand in no space at all"
    onclick={() => live.act((m) => m.showSpace(null))}>nowhere</button
  >
</div>
