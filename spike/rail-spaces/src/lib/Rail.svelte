<script lang="ts">
  import type { Row } from '../fixture';
  import type { RailScope } from '../model/layout';
  import { age, heat } from './core/time';
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

  const scopes: { value: RailScope; label: string; title: string }[] = [
    { value: 'all', label: 'all', title: 'every conversation' },
    { value: 'space', label: 'this space', title: 'only what lives in the space in front' },
    { value: 'unplaced', label: 'nowhere', title: 'only conversations that live nowhere' },
  ];

  const keys = $derived(Object.keys(tagKeys).sort());
  let alwaysShow = $state<string[]>(['repo', 'role']);

  const listed = $derived(live.model.railRows(register));
  const shown = $derived(live.model.shownSpace);
  const searching = $derived(live.model.searchText !== '');

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

<div class="border-b border-neutral-800 px-3 py-2 text-xs">
  <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
    <span class="text-neutral-500">scope</span>
    {#each scopes as s (s.value)}
      <button
        class="cursor-pointer rounded border px-1.5 disabled:cursor-default disabled:opacity-40 {live.model
          .railScope === s.value
          ? 'border-sky-600 text-sky-300'
          : 'border-neutral-700 text-neutral-400'}"
        title={s.title}
        disabled={searching}
        onclick={() => live.act((m) => m.setScope(s.value))}>{s.label}</button
      >
    {/each}
    <span class="text-neutral-500">{listed.length}/{register.length}</span>
  </div>
  <div class="mt-1.5 flex flex-wrap items-center gap-1">
    <span class="text-neutral-500">filter</span>
    <input
      class="w-36 min-w-0 border border-neutral-700 bg-neutral-900 px-1 text-neutral-300 placeholder:text-neutral-600"
      placeholder="conversation id"
      title="find a conversation by its id; suspends the scope beside it"
      value={live.model.searchText}
      oninput={(e) => live.act((m) => m.setSearch(e.currentTarget.value))}
    />
    <span class="ml-2 text-neutral-500">show</span>
    {#each keys as k (k)}
      <button
        class="cursor-pointer rounded border px-1.5 {alwaysShow.includes(k)
          ? 'border-current'
          : 'border-neutral-700 text-neutral-500'}"
        style={alwaysShow.includes(k) ? `color: ${tagKeys[k]}` : ''}
        onclick={() =>
          (alwaysShow = alwaysShow.includes(k) ? alwaysShow.filter((x) => x !== k) : [...alwaysShow, k])}
        >{k}</button
      >
    {/each}
  </div>
  <p class="mt-1.5 text-neutral-600">
    click goes where it lives · right click files it into {shown === null
      ? 'nothing: no space in front'
      : (live.model.nameOf(shown) ?? '')}
  </p>
  {#if refused !== ''}
    <p class="mt-1 text-amber-500">{refused} lives nowhere, so there is nowhere to go</p>
  {/if}
</div>

<ul>
  {#each listed as conv (conv)}
    {@const row = rowOf(conv)}
    {@const where = live.model.spaceOf(conv)}
    {@const placement = live.model.placementOf(conv)}
    <li>
      <button
        title={conv}
        class="flex w-full cursor-pointer flex-wrap justify-between gap-x-2 border-b border-neutral-800 px-3 py-2 text-left hover:bg-neutral-900 {where !==
          null && where === shown
          ? 'bg-slate-800'
          : ''} {where === null ? 'border-l-2 border-l-amber-700' : ''}"
        onclick={() => goTo(conv)}
        oncontextmenu={(e) => file(conv, e)}
      >
        <span class="flex min-w-0 items-center gap-1.5">
          {#if row?.stale}<span
              class="shrink-0 text-sky-400"
              title="nobody's looked at this since it last got new content">●</span
            >{/if}
          <span class="truncate" class:text-neutral-200={row?.title}>{row?.title ?? conv}</span>
        </span>
        <span class="flex shrink-0 items-baseline gap-2 text-neutral-400">
          {#if where === null}
            <span class="text-amber-600">nowhere</span>
          {:else}
            <span class="text-sky-200/70">{live.model.nameOf(where)}</span>
            {#if placement?.drawn === false}<span class="text-neutral-600" title="in this space, off the screen"
                >away</span
              >{/if}
          {/if}
          <span>{row?.lastKind}</span>
          <span class="min-w-[3ch] text-right {heat(now, row?.lastEvent ?? 0)}">{age(now, row?.lastEvent ?? 0)}</span>
        </span>
        {#if alwaysShow.some((k) => row?.tags?.[k])}
          <span class="flex w-full flex-wrap gap-1 pt-0.5 text-xs">
            {#each alwaysShow as k (k)}
              {#if row?.tags?.[k]}
                <span class="rounded-full border border-current px-1.5 opacity-80" style="color: {tagKeys[k] ?? '#888'}"
                  >{row.tags[k]}</span
                >
              {/if}
            {/each}
          </span>
        {/if}
      </button>
    </li>
  {:else}
    <li class="p-3 text-neutral-500">No conversations match.</li>
  {/each}
</ul>
