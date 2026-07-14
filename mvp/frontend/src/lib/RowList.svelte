<script lang="ts">
  import { tower } from './tower.svelte';
  import type { RowState } from './types';

  // Staleness reads as "how long ago", refreshed each half-minute.
  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  function age(ts: number): string {
    const s = Math.max(0, Math.floor((now - ts) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  }

  const heat = (ts: number) =>
    now - ts < 3_600_000 ? 'text-green-400' : now - ts < 21_600_000 ? 'text-yellow-500' : 'text-neutral-500';

  /** The liveness verdict, derived here against this client's clock — facts
   *  come from the store, the judgement is the renderer's (agent-spec: a
   *  fold, never declared). Stranded = silence past ~3 of the instance's own
   *  declared interval; no declared interval yet = no verdict to pass. */
  const verdict = (conv: string): 'alive' | 'stranded' | null => {
    const l = tower.liveness(conv);
    if (!l) return null; // no live attachment: released or never served
    if (l.intervalS && now - l.lastPulse > 3 * l.intervalS * 1000) return 'stranded';
    return 'alive';
  };

  // ---- the view machine: filter → group → sort, all from tags ----
  const keys = $derived(Object.keys(tower.tagKeys).sort());

  /** Which key's values are expanded in the facet bar; '' = none. */
  let expandedKey = $state('');

  const tagOf = (r: RowState, k: string) => r.tags?.[k] ?? '(untagged)';

  // OR within a key, AND across keys — tags are flat.
  const matches = (r: RowState) =>
    Object.entries(tower.view.filters).every(
      ([k, vs]) => vs.length === 0 || vs.includes(tagOf(r, k)),
    );
  const visible = $derived(tower.ordered.filter(matches));

  /** Sections by the group key, ordered by rollup staleness; '' = one flat
   *  group. Untagged is hideable, and never outranks real groups — the most
   *  recent stray would otherwise sit on top forever, defeating grouping. */
  const sections = $derived.by(() => {
    const k = tower.view.groupKey;
    if (!k) return [{ label: null as string | null, rows: visible, max: 0 }];
    const m = new Map<string, RowState[]>();
    for (const r of visible) {
      const v = r.tags?.[k];
      if (v === undefined && tower.view.hideUntagged) continue;
      const label = v ?? '(untagged)';
      if (!m.has(label)) m.set(label, []);
      m.get(label)!.push(r);
    }
    return [...m.entries()]
      .map(([label, rows]) => ({ label, rows, max: Math.max(...rows.map((r) => r.lastEvent)) }))
      .sort((a, b) => {
        // Untagged sinks below every real group, whatever its recency.
        const ua = a.label === '(untagged)' ? 1 : 0;
        const ub = b.label === '(untagged)' ? 1 : 0;
        return ua - ub || b.max - a.max;
      });
  });

  /** Value counts for the expanded key, honouring the OTHER keys' filters so
   *  multi-select doesn't strangle itself. */
  const facetValues = $derived.by(() => {
    if (!expandedKey) return [];
    const others = tower.ordered.filter((r) =>
      Object.entries(tower.view.filters).every(
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
    const vs = tower.view.filters[expandedKey] ?? [];
    tower.view.filters[expandedKey] = vs.includes(value)
      ? vs.filter((v) => v !== value)
      : [...vs, value];
    tower.saveView();
  }

  function toggleAlwaysShow(key: string) {
    tower.view.alwaysShow = tower.view.alwaysShow.includes(key)
      ? tower.view.alwaysShow.filter((k) => k !== key)
      : [...tower.view.alwaysShow, key];
    tower.saveView();
  }

  const selectedCount = (k: string) => tower.view.filters[k]?.length ?? 0;
</script>

<!-- The view controls: group by, then the facet bar (keys first — click a
     key, pick values; the value chip is bare, colour carries the key). -->
<div class="border-b border-neutral-800 px-3 py-2 text-xs">
  <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
    <span class="text-neutral-500">group</span>
    <select
      class="border border-neutral-700 bg-neutral-900 px-1 text-neutral-300"
      bind:value={tower.view.groupKey}
      onchange={() => tower.saveView()}
    >
      <option value="">none</option>
      {#each keys as k (k)}<option value={k}>{k}</option>{/each}
    </select>
    {#if tower.view.groupKey}
      <button
        class="cursor-pointer rounded border px-1.5 {tower.view.hideUntagged
          ? 'border-sky-600 text-sky-300'
          : 'border-neutral-700 text-neutral-500'}"
        onclick={() => {
          tower.view.hideUntagged = !tower.view.hideUntagged;
          tower.saveView();
        }}>hide untagged</button
      >
    {/if}
    <span class="ml-2 text-neutral-500">show</span>
    {#each keys as k (k)}
      <button
        class="cursor-pointer rounded border px-1.5 {tower.view.alwaysShow.includes(k)
          ? 'border-current'
          : 'border-neutral-700 text-neutral-500'}"
        style={tower.view.alwaysShow.includes(k) ? `color: ${tower.tagKeys[k]}` : ''}
        onclick={() => toggleAlwaysShow(k)}>{k}</button
      >
    {/each}
  </div>
  <div class="mt-1.5 flex flex-wrap items-center gap-1">
    <span class="text-neutral-500">filter</span>
    {#each keys as k (k)}
      <button
        class="cursor-pointer rounded border px-1.5 {expandedKey === k || selectedCount(k)
          ? 'border-sky-600 text-sky-300'
          : 'border-neutral-700 text-neutral-400'}"
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
          class="cursor-pointer rounded-full border px-2 {tower.view.filters[
            expandedKey
          ]?.includes(value)
            ? 'border-current'
            : 'border-neutral-700 text-neutral-400'}"
          style={tower.view.filters[expandedKey]?.includes(value)
            ? `color: ${tower.tagKeys[expandedKey]}`
            : ''}
          onclick={() => toggleFilter(value)}>{value} ({count})</button
        >
      {/each}
    </div>
  {/if}
</div>

<ul>
  <!-- Potential conversations: attached, no messages yet — served, silent.
       Transient by design: they vanish with the attachment; the first
       committed message births an ordinary row below. No staleness — they
       have no conversation activity to claim. -->
  {#each tower.attachedOnly as a (a.conv)}
    <li>
      <button
        class="flex w-full cursor-pointer flex-wrap justify-between gap-x-2 border-b border-neutral-800 px-3 py-2 text-left hover:bg-neutral-900 {tower.tab.convs.includes(
          a.conv,
        )
          ? 'bg-slate-800'
          : ''}"
        onclick={() =>
          tower.tab.convs.includes(a.conv)
            ? tower.closeConversation(a.conv)
            : tower.openConversation(a.conv)}
      >
        <span class="flex min-w-0 flex-1 items-center gap-1.5">
          <span
            class="h-2 w-2 shrink-0 rounded-full {verdict(a.conv) === 'stranded'
              ? 'bg-red-400'
              : 'bg-green-400'}"
          ></span>
          <span class="truncate">{a.conv}</span>
        </span>
        <span class="shrink-0 text-neutral-500">served, silent</span>
        {#if a.cwd}
          <span class="w-full truncate pt-0.5 text-xs text-neutral-500">{a.cwd}</span>
        {/if}
      </button>
    </li>
  {/each}
  {#each sections as section (section.label ?? '')}
    {#if section.label !== null}
      <li
        class="flex justify-between gap-2 border-b border-neutral-800 bg-neutral-900 px-3 py-1 text-xs"
      >
        <span class="truncate" style="color: {tower.tagKeys[tower.view.groupKey] ?? '#999'}"
          >{section.label}</span
        >
        <span class="shrink-0 text-neutral-500"
          >{section.rows.length} · <span class={heat(section.max)}>{age(section.max)}</span></span
        >
      </li>
    {/if}
    {#each section.rows as row (row.conv)}
      <li>
        <button
          class="flex w-full cursor-pointer flex-wrap justify-between gap-x-2 border-b border-neutral-800 px-3 py-2 text-left hover:bg-neutral-900 {tower.tab.convs.includes(
            row.conv,
          )
            ? 'bg-slate-800'
            : ''}"
          onclick={() =>
            tower.tab.convs.includes(row.conv)
              ? tower.closeConversation(row.conv)
              : tower.openConversation(row.conv)}
        >
          <span class="flex min-w-0 items-center gap-1.5">
            {#if tower.pendingByConv.has(row.conv)}<span class="shrink-0 text-amber-300">⚠</span
              >{/if}
            {#if verdict(row.conv) === 'alive'}
              <span class="h-2 w-2 shrink-0 rounded-full bg-green-400"></span>
            {:else if verdict(row.conv) === 'stranded'}
              <span class="h-2 w-2 shrink-0 rounded-full bg-red-400"></span>
            {/if}
            <span class="truncate" class:text-neutral-200={row.title}>{row.title ?? row.conv}</span>
          </span>
          <span class="flex shrink-0 gap-2 text-neutral-400">
            <span>{row.lastKind}</span>
            <span class="min-w-[3ch] text-right {heat(row.lastEvent)}">{age(row.lastEvent)}</span>
          </span>
          {#if tower.view.alwaysShow.some((k) => row.tags?.[k])}
            <span class="flex w-full flex-wrap gap-1 pt-0.5 text-xs">
              {#each tower.view.alwaysShow as k (k)}
                {#if row.tags?.[k]}
                  <!-- The value only; the colour says which key it is. -->
                  <span
                    class="rounded-full border border-current px-1.5 opacity-80"
                    style="color: {tower.tagKeys[k] ?? '#888'}">{row.tags[k]}</span
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
