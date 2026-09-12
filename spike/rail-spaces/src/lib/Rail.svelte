<script lang="ts">
  import type { Row } from '../fixture';
  import type { RailScope } from '../model/layout';
  import { age, heat } from './core/time';
  import type { Reactive } from './reactive.svelte';

  const {
    model,
    rows,
    tagKeys,
    now,
    verdicts,
    onArrive,
  }: {
    model: Reactive;
    rows: Row[];
    tagKeys: Record<string, string>;
    now: number;
    verdicts: Map<string, 'alive' | 'stranded'>;
    onArrive: (conv: string) => void;
  } = $props();

  const scopes: { value: RailScope; label: string; title: string }[] = [
    { value: 'all', label: 'all', title: 'every conversation' },
    { value: 'space', label: 'this space', title: 'only what is placed in the space shown' },
    { value: 'unplaced', label: 'unplaced', title: 'only conversations with no placement' },
  ];

  const keys = $derived(Object.keys(tagKeys).sort());
  const byId = $derived(new Map(rows.map((r) => [r.conv, r])));
  const register = $derived(rows.map((r) => r.conv));

  // The view machine: filter → group → sort, all from tags. Ported from
  // mvp/frontend-svelte RowList.svelte, which is where it lives in tower too:
  // the model takes the list this leaves behind.
  //
  // What a control is about decides what it belongs to. Filtering and grouping
  // are about a subject, and a space is a subject, so they are held per space.
  // Attention and row shape are about how you are looking rather than what at,
  // so they travel with you.
  type SpaceView = { filters: Record<string, string[]>; groupKey: string; hideUntagged: boolean };
  const blank = (): SpaceView => ({ filters: {}, groupKey: '', hideUntagged: false });

  // Never written to: a space that has never been filtered reads through this
  // rather than being created by the act of looking at it.
  const unfiltered: SpaceView = blank();

  let views = $state<Record<string, SpaceView>>({});
  // Showing no space is still somewhere to hold a view for.
  const key = $derived(model.layout.shownSpace ?? '');
  const view = $derived(views[key] ?? unfiltered);

  function edit(change: (view: SpaceView) => void): void {
    if (views[key] === undefined) views[key] = blank();
    change(views[key] as SpaceView);
  }

  let expandedKey = $state('');
  let unreadOnly = $state(false);
  let liveOnly = $state(false);
  let alwaysShow = $state<string[]>(['repo', 'role']);

  const tagOf = (r: Row, k: string) => r.tags?.[k] ?? '(untagged)';

  // OR within a key, AND across keys.
  const matches = (r: Row) =>
    Object.entries(view.filters).every(([k, vs]) => vs.length === 0 || vs.includes(tagOf(r, k)));
  const stateMatches = (r: Row) =>
    (!unreadOnly || r.stale === true) && (!liveOnly || verdicts.get(r.conv) === 'alive');

  const searching = $derived(model.layout.searchText !== '');
  const listed = $derived(
    model.layout.railRows(
      register,
      rows.filter((r) => matches(r) && stateMatches(r)).map((r) => r.conv),
    ),
  );

  const sections = $derived.by(() => {
    // Grouping suspends with the chips: a search result must not be sectioned
    // away from whoever named it.
    if (searching || !view.groupKey) return [{ label: null as string | null, convs: listed, max: 0 }];
    const m = new Map<string, string[]>();
    for (const conv of listed) {
      const row = byId.get(conv);
      const v = row?.tags?.[view.groupKey];
      if (v === undefined && view.hideUntagged) continue;
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
        Object.entries(view.filters).every(
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
    edit((v) => {
      const held = v.filters[expandedKey] ?? [];
      v.filters[expandedKey] = held.includes(value)
        ? held.filter((x) => x !== value)
        : [...held, value];
    });
  }

  const selectedCount = (k: string) => view.filters[k]?.length ?? 0;
  const filtered = $derived(Object.values(view.filters).some((vs) => vs.length > 0));

  // A click on an unplaced conversation has nothing to do, and says so on the
  // row itself: a line of text here would push the whole rail down, which is a
  // lot of movement to report that nothing happened.
  let refused = $state('');
  let clearRefusal: ReturnType<typeof setTimeout> | undefined;

  function goTo(conv: string) {
    model.act((m) => {
      if (m.goTo(conv)) {
        refused = '';
        onArrive(conv);
        return;
      }
      refused = conv;
      clearTimeout(clearRefusal);
      clearRefusal = setTimeout(() => (refused = ''), 900);
    });
  }

  function file(conv: string) {
    const shown = model.layout.shownSpace;
    if (shown === null) return;
    model.act((m) => m.place(conv, shown));
  }

  function fileByGesture(conv: string, event: MouseEvent) {
    if (event.shiftKey) return;
    event.preventDefault();
    file(conv);
  }
</script>

<!-- Yours: the way you are looking, whatever space is in front. -->
<div class="shrink-0 border-b border-neutral-800 px-3 py-2 text-xs">
  <div class="grid grid-cols-[auto_1fr] items-baseline gap-x-2 gap-y-1.5">
    <span class="text-neutral-500">scope</span>
    <span class="flex flex-wrap items-center gap-1">
      {#each scopes as s (s.value)}
        <button
          class="cursor-pointer rounded border px-1.5 disabled:cursor-default disabled:opacity-40 {model.layout
            .railScope === s.value
            ? 'border-sky-600 text-sky-300'
            : 'border-neutral-700 text-neutral-400'}"
          title={s.title}
          disabled={searching}
          onclick={() => model.act((m) => m.setScope(s.value))}>{s.label}</button
        >
      {/each}
      <span class="text-neutral-500">{listed.length}/{register.length}</span>
    </span>

    <span class="text-neutral-500">filter</span>
    <span class="flex flex-wrap items-center gap-1">
      <input
        class="w-36 min-w-0 border border-neutral-700 bg-neutral-900 px-1 text-neutral-300 placeholder:text-neutral-600"
        placeholder="conversation id"
        title="find a conversation by its id; suspends everything else"
        value={model.layout.searchText}
        oninput={(e) => model.act((m) => m.setSearch(e.currentTarget.value))}
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
    </span>

    <span class="text-neutral-500">show</span>
    <span class="flex flex-wrap items-center gap-1">
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
    </span>
  </div>
</div>

<!-- The space's own: they stay with it when you walk away. -->
<div class="shrink-0 border-b border-neutral-800 bg-neutral-950 px-3 py-2 text-xs">
  <div class="mb-1.5 flex items-baseline justify-between gap-2">
    <span class="truncate text-neutral-300"
      >{model.layout.shownSpace === null
        ? 'no space'
        : (model.layout.nameOf(model.layout.shownSpace) ?? '')}</span
    >
    {#if filtered || view.groupKey !== ''}
      <button
        class="shrink-0 cursor-pointer rounded border border-neutral-700 px-1.5 text-neutral-400 hover:text-neutral-200"
        onclick={() => (views[key] = blank())}>clear</button
      >
    {/if}
  </div>
  <div class="grid grid-cols-[auto_1fr] items-baseline gap-x-2 gap-y-1.5">
    <span class="text-neutral-500">group</span>
    <span class="flex flex-wrap items-center gap-1">
      <select
        class="border border-neutral-700 bg-neutral-900 px-1 text-neutral-300 disabled:cursor-default disabled:opacity-40"
        value={view.groupKey}
        onchange={(e) => {
          const chosen = e.currentTarget.value;
          edit((v) => {
            v.groupKey = chosen;
          });
        }}
        disabled={searching}
      >
        <option value="">none</option>
        {#each keys as k (k)}<option value={k}>{k}</option>{/each}
      </select>
      {#if view.groupKey}
        <button
          class="cursor-pointer rounded border px-1.5 disabled:cursor-default disabled:opacity-40 {view.hideUntagged
            ? 'border-sky-600 text-sky-300'
            : 'border-neutral-700 text-neutral-500'}"
          disabled={searching}
          onclick={() =>
            edit((v) => {
              v.hideUntagged = !v.hideUntagged;
            })}>hide untagged</button
        >
      {/if}
    </span>

    <span class="text-neutral-500">filter</span>
    <span class="flex flex-wrap items-center gap-1">
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
    </span>
  </div>
  {#if expandedKey}
    <div class="mt-1.5 flex flex-wrap gap-1">
      {#each facetValues as [value, count] (value)}
        <button
          class="cursor-pointer rounded-full border px-2 disabled:cursor-default disabled:opacity-40 {view.filters[
            expandedKey
          ]?.includes(value)
            ? 'border-current'
            : 'border-neutral-700 text-neutral-400'}"
          disabled={searching}
          style={view.filters[expandedKey]?.includes(value) ? `color: ${tagKeys[expandedKey]}` : ''}
          onclick={() => toggleFilter(value)}>{value} ({count})</button
        >
      {/each}
    </div>
  {/if}
</div>

<div class="shrink-0 border-b border-neutral-800 px-3 py-1.5 text-xs">
  <p class="text-neutral-600">
    click shows the space a conversation is placed in · right click places it in {model.layout.shownSpace ===
    null
      ? 'nothing: no space shown'
      : (model.layout.nameOf(model.layout.shownSpace) ?? '')}
  </p>
</div>

<!-- Only the rows scroll: the controls above stay where they were put. -->
<ul class="min-h-0 flex-1 overflow-y-auto">
  {#each sections as section (section.label ?? '')}
    {#if section.label !== null}
      <li class="flex justify-between gap-2 border-b border-neutral-800 bg-neutral-900 px-3 py-1 text-xs">
        <span class="truncate" style="color: {tagKeys[view.groupKey] ?? '#999'}">{section.label}</span>
        <span class="shrink-0 text-neutral-500"
          >{section.convs.length} · <span class={heat(now, section.max)}>{age(now, section.max)}</span></span
        >
      </li>
    {/if}
    {#each section.convs as conv (conv)}
      {@const row = byId.get(conv)}
      {@const where = model.layout.spaceOf(conv)}
      {@const placement = model.layout.placementOf(conv)}
      <li>
        <button
          title={conv}
          class="flex w-full cursor-pointer flex-wrap justify-between gap-x-2 border-b border-neutral-800 px-3 py-2 text-left transition-colors duration-500 hover:bg-neutral-900 {refused ===
          conv
            ? 'bg-amber-950'
            : ''}"
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
                class="rounded px-1.5 {where === model.layout.shownSpace
                  ? 'bg-sky-900 text-sky-100'
                  : 'border border-neutral-700 text-neutral-400'} {placement?.drawn === false ? 'opacity-40' : ''}"
                title="placed in {model.layout.nameOf(where)}{placement?.drawn === false ? ', minimised' : ''}"
                >{model.layout.nameOf(where)}</span
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
