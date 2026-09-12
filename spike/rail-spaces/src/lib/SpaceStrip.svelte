<script lang="ts">
  import type { Space } from '../model/layout';
  import type { Live } from './reactive.svelte';

  const { live, staleCount }: { live: Live; staleCount: (convs: string[]) => number } = $props();

  const top = $derived(live.model.children(null));
  const shown = $derived(live.model.shownSpace);

  // Which top-level space you are inside, whether you are standing in it or in
  // one of its children. It decides what the second row holds.
  const branch = $derived.by(() => {
    if (shown === null) return null;
    const space = live.model.spaces.find((s) => s.id === shown);
    if (space === undefined) return null;
    return space.parent ?? space.id;
  });
  const inside = $derived(branch === null ? [] : live.model.children(branch));

  function create(parent: string | null) {
    const name = prompt(parent === null ? 'a new space' : `a space inside “${live.model.nameOf(parent)}”`);
    if (name === null || name.trim() === '') return;
    live.act((m) => m.createSpace(crypto.randomUUID(), name.trim(), parent));
  }

  function remove(space: Space) {
    const held = live.model.placedIn(space.id).length;
    const nested = live.model.children(space.id).length;
    const loses = [
      held > 0 ? `${held} conversation(s) end up living nowhere` : '',
      nested > 0 ? `${nested} space(s) inside it go too` : '',
    ].filter((s) => s !== '');
    if (!confirm(`Delete “${space.name}”?${loses.length > 0 ? ` ${loses.join(', ')}.` : ''}`)) return;
    live.act((m) => m.deleteSpace(space.id));
  }
</script>

{#snippet chip(space: Space)}
  {@const here = shown === space.id}
  {@const placed = live.model.placedIn(space.id)}
  {@const away = live.model.minimisedIn(space.id).length}
  <span
    class="flex items-baseline gap-1.5 rounded-t border border-b-0 px-2.5 py-0.5 text-xs {here
      ? 'border-neutral-600 bg-neutral-900 text-neutral-100'
      : branch === space.id
        ? 'border-neutral-700 text-neutral-300'
        : 'border-neutral-800 text-neutral-500'}"
  >
    <button class="cursor-pointer" title="stand in {space.name}" onclick={() => live.act((m) => m.showSpace(space.id))}
      >{space.name}</button
    >
    {#if staleCount(placed) > 0}<span class="text-sky-300" title="unread in this space">● {staleCount(placed)}</span>{/if}
    {#if placed.length > 0}
      <span class="text-neutral-600" title="{placed.length} placed here, {away} of them away"
        >{placed.length}{away > 0 ? ` (${away} away)` : ''}</span
      >
    {/if}
    {#if here}
      <button class="cursor-pointer text-neutral-600 hover:text-red-400" title="delete this space" onclick={() => remove(space)}
        >×</button
      >
    {/if}
  </span>
{/snippet}

<div class="border-b border-neutral-700">
  <div class="flex flex-wrap items-baseline gap-1 px-2 pt-1">
    {#each top as space (space.id)}
      {@render chip(space)}
    {/each}
    <button
      class="cursor-pointer px-1.5 text-neutral-500 hover:text-neutral-200"
      title="a new space at the top level"
      onclick={() => create(null)}>+</button
    >
  </div>
  {#if branch !== null}
    <div class="flex flex-wrap items-baseline gap-1 border-t border-neutral-800 bg-neutral-950 px-2 pt-1 pb-0.5 pl-6">
      <span class="text-xs text-neutral-600">inside {live.model.nameOf(branch)}</span>
      {#each inside as space (space.id)}
        {@render chip(space)}
      {/each}
      <button
        class="cursor-pointer px-1.5 text-neutral-500 hover:text-neutral-200"
        title="a new space inside {live.model.nameOf(branch)}"
        onclick={() => create(branch)}>+</button
      >
    </div>
  {/if}
</div>
