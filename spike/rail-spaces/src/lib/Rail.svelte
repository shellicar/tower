<script lang="ts">
  import type { Row } from '../fixture';
  import type { RailScope } from '../model/layout';
  import { ago } from './ago';
  import type { Live } from './reactive.svelte';

  const {
    live,
    register,
    rowOf,
    tagKeys,
    now,
  }: {
    live: Live;
    register: string[];
    rowOf: (conv: string) => Row | undefined;
    tagKeys: Record<string, string>;
    now: number;
  } = $props();

  const scopes: { value: RailScope; label: string }[] = [
    { value: 'all', label: 'all' },
    { value: 'space', label: 'this space' },
    { value: 'unplaced', label: 'nowhere' },
  ];

  const listed = $derived(live.model.railRows(register));
  const shown = $derived(live.model.shownSpace);
  let refused = $state('');

  function goTo(conv: string) {
    refused = '';
    live.act((m) => {
      if (!m.goTo(conv)) refused = conv;
    });
  }

  function file(conv: string, event: MouseEvent) {
    if (event.shiftKey) return;
    event.preventDefault();
    if (shown === null) return;
    live.act((m) => m.togglePlacement(conv, shown));
  }
</script>

<div class="rail">
  <div class="rail-head">
    <div class="scopes">
      {#each scopes as s (s.value)}
        <button
          class={live.model.railScope === s.value ? 'on' : ''}
          onclick={() => live.act((m) => m.setScope(s.value))}>{s.label}</button
        >
      {/each}
      <span class="hint">{listed.length} of {register.length}</span>
    </div>
    <input
      placeholder="conversation id"
      value={live.model.searchText}
      oninput={(e) => live.act((m) => m.setSearch(e.currentTarget.value))}
    />
    <span class="hint">
      click goes there · right click files into {shown === null
        ? 'nothing (no space in front)'
        : live.model.nameOf(shown)}
    </span>
    {#if refused !== ''}
      <span class="hint" style="color: var(--unplaced)">{refused} lives nowhere, so there is nowhere to go</span>
    {/if}
  </div>
  <div class="rail-rows">
    {#each listed as conv (conv)}
      {@const row = rowOf(conv)}
      {@const where = live.model.spaceOf(conv)}
      <div
        class="row {where !== null && where === shown ? 'here' : ''}"
        onclick={() => goTo(conv)}
        oncontextmenu={(e) => file(conv, e)}
        role="button"
        tabindex="-1"
      >
        <div class="row-top">
          <span class="row-title">{row?.title ?? '(untitled)'}</span>
          <span class="where {where === null ? 'nowhere' : ''}"
            >{where === null ? 'nowhere' : live.model.nameOf(where)}</span
          >
        </div>
        <div class="row-bottom">
          <span class="id">{conv}</span>
          {#if row !== undefined}<span>{ago(row.lastEvent, now)}</span>{/if}
          {#if row?.stale}<span style="color: var(--warn)">stale</span>{/if}
          {#if where !== null && !live.model.placementOf(conv)?.drawn}<span>away</span>{/if}
        </div>
        {#if row?.tags !== undefined}
          <div class="row-bottom">
            {#each Object.entries(row.tags) as [key, value] (key)}
              <span class="tag" style="background: {tagKeys[key] ?? '#928374'}">{key}:{value}</span>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>
