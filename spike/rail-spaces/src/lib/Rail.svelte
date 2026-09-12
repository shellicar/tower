<script lang="ts">
  import type { Row } from '../fixture';
  import type { RailScope } from '../model/layout';
  import { age, heat } from './core/time';
  import type { Live } from './reactive.svelte';

  const {
    live,
    rows,
    tagKeys,
    now,
    verdicts,
    onArrive,
  }: {
    live: Live;
    rows: Row[];
    tagKeys: Record<string, string>;
    now: number;
    verdicts: Map<string, 'alive' | 'stranded'>;
    onArrive: (conv: string) => void;
  } = $props();

  const scopes: { value: RailScope; label: string; title: string }[] = [
    { value: 'all', label: 'all', title: 'every conversation' },
    { value: 'space', label: 'this space', title: 'only what lives in the space in front' },
    { value: 'unplaced', label: 'unplaced', title: 'only conversations that are in no space' },
  ];

  const keys = $derived(Object.keys(tagKeys).sort());
  const byId = $derived(new Map(rows.map((r) => [r.conv, r])));
  const register = $derived(rows.map((r) => r.conv));

  // The view machine: filter → group → sort, all from tags. Ported from
  // mvp/frontend-svelte RowList.svelte, which is where it lives in tower too:
  // the model takes the list this leaves behind.
  let expandedKey = $state('');
  let filters = $state<Record<string, string[]>>({});
  let groupKey = $state('');
  let hideUntagged = $state(false);
  let unreadOnly = $state(false);
  let liveOnly = $state(false);
  let alwaysShow = $state<string[]>(['repo', 'role']);

  const tagOf = (r: Row, k: string) => r.tags?.[k] ?? '(untagged)';

  // OR within a key, AND across keys.
  const matches = (r: Row) =>
    Object.entries(filters).every(([k, vs]) => vs.length === 0 || vs.includes(tagOf(r, k)));
  const stateMatches = (r: Row) =>
    (!unreadOnly || r.stale === true) && (!liveOnly || verdicts.get(r.conv) === 'alive');

  const searching = $derived(live.model.searchText !== '');
  const listed = $derived(
    live.model.railRows(
      register,
      rows.filter((r) => matches(r) && stateMatches(r)).map((r) => r.conv),
    ),
  );

  const sections = $derived.by(() => {
    // Grouping suspends with the chips: a search result must not be sectioned
    // away from whoever named it.
    if (searching || !groupKey) return [{ label: null as string | null, convs: listed, max: 0 }];
    const m = new Map<string, string[]>();
    for (const conv of listed) {
      const row = byId.get(conv);
      const v = row?.tags?.[groupKey];
      if (v === undefined && hideUntagged) continue;
      const label = v ?? '(untagged)';
      if (!m.has(label)) m.set(label, []);
      (m.get(label) as string[]).push(conv);
    }
    return [...m.entries()]
      .map(([label, convs]) => ({
        label,
        convs,
        max: Math.max(...convs.map((c) => byId.get(c)?.lastEvent ?? 0)),
      }))
      .sort((a, b) => {
        const ua = a.label === '(untagged)' ? 1 : 0;
        const ub = b.label === '(untagged)' ? 1 : 0;
        return ua - ub || b.max - a.max;
      });
  });

  /** Value counts for the expanded key, honouring the OTHER keys' filters. */
  const facetValues = $derived.by(() => {
    if (!expandedKey) return [];
    const others = rows.filter(
      (r) =>
        stateMatches(r) &&
        Object.entries(filters).every(
          ([k, vs]) => k === expandedKey || vs.length === 0 || vs.includes(tagOf(r, k)),
        ),
    );
    const counts = new Map<string, number>();
    for (const r of others) {
      const v = r.tags?.[expandedKey];
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  });

  function toggleFilter(value: string) {
    const vs = filters[expandedKey] ?? [];
    filters[expandedKey] = vs.includes(value) ? vs.filter((v) => v !== value) : [...vs, value];
  }

  const selectedCount = (k: string) => filters[k]?.length ?? 0;

  let refused = $state('');

  function goTo(conv: string) {
    refused = '';
    live.act((m) => {
      if (m.goTo(conv)) onArrive(conv);
      else refused = conv;
    });
  }

  function file(conv: string) {
    const shown = live.model.shownSpace;
    if (shown === null) return;
    live.act((m) => m.place(conv, shown));
  }

  function fileByGesture(conv: string, event: MouseEvent) {
    if (event.shiftKey) return;
    event.preventDefault();
    file(conv);
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
  <div class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
    <span class="text-neutral-500">group</span>
    <select
      class="border border-neutral-700 bg-neutral-900 px-1 text-neutral-300 disabled:cursor-default disabled:opacity-40"
      bind:value={groupKey}
      disabled={searching}
    >
      <option value="">none</option>
      {#each keys as k (k)}<option value={k}>{k}</option>{/each}
    </select>
    {#if groupKey}
      <button
        class="cursor-pointer rounded border px-1.5 disabled:cursor-default disabled:opacity-40 {hideUntagged
          ? 'border-sky-600 text-sky-300'
          : 'border-neutral-700 text-neutral-500'}"
        disabled={searching}
        onclick={() => (hideUntagged = !hideUntagged)}>hide untagged</button
      >
    {/if}
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
  <div class="mt-1.5 flex flex-wrap items-center gap-1">
    <span class="text-neutral-500">filter</span>
    <input
      class="w-36 min-w-0 border border-neutral-700 bg-neutral-900 px-1 text-neutral-300 placeholder:text-neutral-600"
      placeholder="conversation id"
      title="find a conversation by its id; suspends everything else"
      value={live.model.searchText}
      oninput={(e) => live.act((m) => m.setSearch(e.currentTarget.value))}
    />
    <button
      class="cursor-pointer rounded border px-1.5 disabled:cursor-default disabled:opacity-40 {liveOnly
        ? 'border-green-600 text-green-300'
        : 'border-neutral-700 text-neutral-400'}"
      title="only conversations a live agent is serving, as at the snapshot"
      disabled={searching}
      onclick={() => (liveOnly = !liveOnly)}>live</button
    >
    <button
      class="cursor-pointer rounded border px-1.5 disabled:cursor-default disabled:opacity-40 {unreadOnly
        ? 'border-sky-600 text-sky-300'
        : 'border-neutral-700 text-neutral-400'}"
      title="only conversations nobody's looked at since they last got new content"
      disabled={searching}
      onclick={() => (unreadOnly = !unreadOnly)}>unread</button
    >
    {#each keys as k (k)}
      <button
        class="cursor-pointer rounded border px-1.5 disabled:cursor-default disabled:opacity-40 {expandedKey ===
          k || selectedCount(k)
          ? 'border-sky-600 text-sky-300'
          : 'border-neutral-700 text-neutral-400'}"
        disabled={searching}
        onclick={() => (expandedKey = expandedKey === k ? '' : k)}
      >
        {k}{selectedCount(k) ? ` (${selectedCount(k)})` : ''}
      </button>
    {/each}
  </div>
  {#if expandedKey}
    <div class="mt-1.5 flex flex-wrap gap-1">
      {#each facetValues as [value, count] (value)}
        <button
          class="cursor-pointer rounded-full border px-2 disabled:cursor-default disabled:opacity-40 {filters[
            expandedKey
          ]?.includes(value)
            ? 'border-current'
            : 'border-neutral-700 text-neutral-400'}"
          disabled={searching}
          style={filters[expandedKey]?.includes(value) ? `color: ${tagKeys[expandedKey]}` : ''}
          onclick={() => toggleFilter(value)}>{value} ({count})</button
        >
      {/each}
    </div>
  {/if}
  <p class="mt-1.5 text-neutral-600">
    click goes where it lives and shows it · right click puts it in {live.model.shownSpace === null
      ? 'nothing: no space in front'
      : (live.model.nameOf(live.model.shownSpace) ?? '')}
  </p>
  {#if refused !== ''}
    <p class="mt-1 text-amber-500">{refused} lives nowhere, so there is nowhere to go</p>
  {/if}
</div>

<ul>
  {#each sections as section (section.label ?? '')}
    {#if section.label !== null}
      <li class="flex justify-between gap-2 border-b border-neutral-800 bg-neutral-900 px-3 py-1 text-xs">
        <span class="truncate" style="color: {tagKeys[groupKey] ?? '#999'}">{section.label}</span>
        <span class="shrink-0 text-neutral-500"
          >{section.convs.length} · <span class={heat(now, section.max)}>{age(now, section.max)}</span></span
        >
      </li>
    {/if}
    {#each section.convs as conv (conv)}
      {@const row = byId.get(conv)}
      {@const where = live.model.spaceOf(conv)}
      {@const placement = live.model.placementOf(conv)}
      <li>
        <button
          title={conv}
          class="flex w-full cursor-pointer flex-wrap justify-between gap-x-2 border-b border-neutral-800 px-3 py-2 text-left hover:bg-neutral-900"
          onclick={() => goTo(conv)}
          oncontextmenu={(e) => fileByGesture(conv, e)}
        >
          <span class="flex min-w-0 items-center gap-1.5">
            {#if row?.stale}<span
                class="shrink-0 text-sky-400"
                title="nobody's looked at this since it last got new content">●</span
              >{/if}
            {#if verdicts.get(conv) === 'alive'}
              <span class="h-2 w-2 shrink-0 rounded-full bg-green-400" title="a live agent is serving this"></span>
            {:else if verdicts.get(conv) === 'stranded'}
              <span
                class="h-2 w-2 shrink-0 rounded-full bg-red-400"
                title="an agent holds this but has stopped pulsing"
              ></span>
            {/if}
            <span class="truncate" class:text-neutral-200={row?.title}>{row?.title ?? conv}</span>
          </span>
          <span class="flex shrink-0 items-baseline gap-2 text-neutral-400">
            {#if where !== null}
              <span
                class="rounded px-1.5 {where === live.model.shownSpace
                  ? 'bg-sky-900 text-sky-100'
                  : 'border border-neutral-700 text-neutral-400'} {placement?.drawn === false ? 'opacity-40' : ''}"
                title="{where === live.model.shownSpace
                  ? 'in the space you are standing in'
                  : `lives in ${live.model.nameOf(where)}`}{placement?.drawn === false ? ', off the screen' : ''}"
                >{live.model.nameOf(where)}</span
              >
            {/if}
            <span>{row?.lastKind}</span>
            <span class="min-w-[3ch] text-right {heat(now, row?.lastEvent ?? 0)}">{age(now, row?.lastEvent ?? 0)}</span>
          </span>
          {#if alwaysShow.some((k) => row?.tags?.[k])}
            <span class="flex w-full flex-wrap gap-1 pt-0.5 text-xs">
              {#each alwaysShow as k (k)}
                {#if row?.tags?.[k]}
                  <span
                    class="rounded-full border border-current px-1.5 opacity-80"
                    style="color: {tagKeys[k] ?? '#888'}">{row.tags[k]}</span
                  >
                {/if}
              {/each}
            </span>
          {/if}
        </button>
      </li>
    {/each}
  {:else}
    <li class="p-3 text-neutral-500">No conversations match.</li>
  {/each}
</ul>
