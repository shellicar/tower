<script lang="ts">
  import type { Space } from '../model/layout';
  import type { Live } from './reactive.svelte';

  const { live }: { live: Live } = $props();

  let newName = $state('');

  function create(parent: string | null, name: string) {
    if (name.trim() === '') return;
    live.act((m) => m.createSpace(crypto.randomUUID(), name.trim(), parent));
  }

  function addChild(space: Space) {
    const name = prompt(`a space inside ${space.name}`);
    if (name !== null) create(space.id, name);
  }

  function remove(space: Space) {
    const held = live.model.placedIn(space.id).length;
    if (!confirm(`delete ${space.name}? ${held} conversation(s) in it become unplaced.`)) return;
    live.act((m) => m.deleteSpace(space.id));
  }
</script>

{#snippet chip(space: Space, depth: number)}
  <div
    class="space {live.model.shownSpace === space.id ? 'shown' : ''}"
    onclick={() => live.act((m) => m.showSpace(space.id))}
    role="button"
    tabindex="-1"
  >
    {#if depth > 0}<span class="nest">{'▸'.repeat(depth)}</span>{/if}
    <span>{space.name}</span>
    <span class="count"
      >{live.model.drawnIn(space.id).length}/{live.model.placedIn(space.id).length}</span
    >
    <button
      onclick={(e) => {
        e.stopPropagation();
        addChild(space);
      }}>+</button
    >
    <button
      onclick={(e) => {
        e.stopPropagation();
        remove(space);
      }}>×</button
    >
  </div>
  {#each live.model.children(space.id) as child (child.id)}
    {@render chip(child, depth + 1)}
  {/each}
{/snippet}

<div class="strip">
  {#each live.model.children(null) as top (top.id)}
    {@render chip(top, 0)}
  {/each}
  <input
    placeholder="new space"
    bind:value={newName}
    onkeydown={(e) => {
      if (e.key === 'Enter') {
        create(null, newName);
        newName = '';
      }
    }}
  />
  <button
    onclick={() => {
      live.act((m) => m.showSpace(null));
    }}>stand nowhere</button
  >
</div>
