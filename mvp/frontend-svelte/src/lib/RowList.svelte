<script lang="ts">
  import { rail, view } from './app';
  import { facetValues, tagOf } from './core/facets';
  import { age, heat } from './core/time';
  import type { RowState } from './types';

  // Staleness reads as "how long ago", refreshed each half-minute. The verdict
  // (alive/stranded) is the rail concern's, against its own clock; age/heat are
  // display, so this component keeps its own render ticker.
  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  // ---- the view machine: filter → group → sort, all from tags ----
  const keys = $derived(Object.keys(rail.tagKeys).sort());

  /** Which key's values are expanded in the facet bar; '' = none. */
  let expandedKey = $state('');

  // OR within a key, AND across keys — tags are flat.
  const matches = (r: RowState) =>
    Object.entries(view.view.filters).every(
      ([k, vs]) => vs.length === 0 || vs.includes(tagOf(r, k)),
    );
  // The two state filters read the same facts the dots do, so the list can
  // never disagree with what's rendered on it.
  const stateMatches = (conv: string) =>
    (!view.view.liveOnly || rail.verdict(conv) === 'alive') &&
    (!view.view.unreadOnly || rail.staleConvs.has(conv));
  const visible = $derived(rail.ordered.filter((r) => matches(r) && stateMatches(r.conv)));
  // Potential conversations have no row, so they can never be stale: `unread`
  // empties the section rather than filtering it.
  const potential = $derived(
    view.view.unreadOnly
      ? []
      : rail.attachedOnly.filter((a) => !view.view.liveOnly || a.verdict === 'alive'),
  );
  // Computed once per render, then a plain Set.has() per row below — not a
  // fresh rail.pendingByConv per row, which would rebuild the whole Set
  // (walking every ask) once for EACH row instead of once for the list.
  const pendingByConv = $derived(rail.pendingByConv);

  /** Sections by the group key, ordered by rollup staleness; '' = one flat
   *  group. Untagged is hideable, and never outranks real groups. */
  const sections = $derived.by(() => {
    const k = view.view.groupKey;
    if (!k) return [{ label: null as string | null, rows: visible, max: 0 }];
    const m = new Map<string, RowState[]>();
    for (const r of visible) {
      const v = r.tags?.[k];
      if (v === undefined && view.view.hideUntagged) continue;
      const label = v ?? '(untagged)';
      if (!m.has(label)) m.set(label, []);
      m.get(label)!.push(r);
    }
    return [...m.entries()]
      .map(([label, rows]) => ({ label, rows, max: Math.max(...rows.map((r) => r.lastEvent)) }))
      .sort((a, b) => {
        const ua = a.label === '(untagged)' ? 1 : 0;
        const ub = b.label === '(untagged)' ? 1 : 0;
        return ua - ub || b.max - a.max;
      });
  });

  const values = $derived(
    expandedKey ? facetValues(rail.ordered, expandedKey, view.view.filters, stateMatches) : [],
  );

  function toggleFilter(value: string | null) {
    const vs = view.view.filters[expandedKey] ?? [];
    view.view.filters[expandedKey] = vs.includes(value)
      ? vs.filter((v) => v !== value)
      : [...vs, value];
    view.saveView();
  }

  function toggleAlwaysShow(key: string) {
    view.view.alwaysShow = view.view.alwaysShow.includes(key)
      ? view.view.alwaysShow.filter((k) => k !== key)
      : [...view.view.alwaysShow, key];
    view.saveView();
  }

  const selectedCount = (k: string) => view.view.filters[k]?.length ?? 0;
</script>

<!-- The view controls: group by, then the facet bar (keys first — click a
     key, pick values; the value chip is bare, colour carries the key). -->
<div class="border-b border-neutral-800 px-3 py-2 text-xs">
  <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
    <span class="text-neutral-500">group</span>
    <select
      class="border border-neutral-700 bg-neutral-900 px-1 text-neutral-300"
      bind:value={view.view.groupKey}
      onchange={() => view.saveView()}
    >
      <option value="">none</option>
      {#each keys as k (k)}<option value={k}>{k}</option>{/each}
    </select>
    {#if view.view.groupKey}
      <button
        class="cursor-pointer rounded border px-1.5 {view.view.hideUntagged
          ? 'border-sky-600 text-sky-300'
          : 'border-neutral-700 text-neutral-500'}"
        onclick={() => {
          view.view.hideUntagged = !view.view.hideUntagged;
          view.saveView();
        }}>hide untagged</button
      >
    {/if}
    <span class="ml-2 text-neutral-500">show</span>
    {#each keys as k (k)}
      <button
        class="cursor-pointer rounded border px-1.5 {view.view.alwaysShow.includes(k)
          ? 'border-current'
          : 'border-neutral-700 text-neutral-500'}"
        style={view.view.alwaysShow.includes(k) ? `color: ${rail.tagKeys[k]}` : ''}
        onclick={() => toggleAlwaysShow(k)}>{k}</button
      >
    {/each}
  </div>
  <div class="mt-1.5 flex flex-wrap items-center gap-1">
    <span class="text-neutral-500">filter</span>
    <button
      class="cursor-pointer rounded border px-1.5 {view.view.liveOnly
        ? 'border-green-600 text-green-300'
        : 'border-neutral-700 text-neutral-400'}"
      title="only conversations a live agent is serving"
      onclick={() => {
        view.view.liveOnly = !view.view.liveOnly;
        view.saveView();
      }}>live</button
    >
    <button
      class="cursor-pointer rounded border px-1.5 {view.view.unreadOnly
        ? 'border-sky-600 text-sky-300'
        : 'border-neutral-700 text-neutral-400'}"
      title="only conversations nobody's looked at since they last got new content"
      onclick={() => {
        view.view.unreadOnly = !view.view.unreadOnly;
        view.saveView();
      }}>unread</button
    >
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
      {#each values as { value, count } (value)}
        <button
          class="cursor-pointer rounded-full border px-2 {view.view.filters[
            expandedKey
          ]?.includes(value)
            ? 'border-current'
            : 'border-neutral-700 text-neutral-400'}"
          style={view.view.filters[expandedKey]?.includes(value)
            ? `color: ${rail.tagKeys[expandedKey]}`
            : ''}
          onclick={() => toggleFilter(value)}>{value ?? '(untagged)'} ({count})</button
        >
      {/each}
    </div>
  {/if}
</div>

<ul>
  <!-- Potential conversations: attached, no messages yet — served, silent.
       Transient by design: they vanish with the attachment; the first
       committed message births an ordinary row below. -->
  {#each potential as a (a.conv)}
    <li>
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
      <!-- A `role="button"` div, not a `<button>`: it wraps a real Dismiss
           button for a stranded attachment, and buttons can't nest. -->
      <div
        role="button"
        tabindex="0"
        class="flex w-full cursor-pointer flex-wrap justify-between gap-x-2 border-b border-neutral-800 px-3 py-2 text-left hover:bg-neutral-900 {view.tab.convs.includes(
          a.conv,
        )
          ? 'bg-slate-800'
          : ''}"
        onclick={() =>
          view.tab.convs.includes(a.conv)
            ? view.closeConversation(a.conv)
            : view.openConversation(a.conv)}
      >
        <span class="flex min-w-0 flex-1 items-center gap-1.5">
          <span
            class="h-2 w-2 shrink-0 rounded-full {a.verdict === 'stranded'
              ? 'bg-red-400'
              : 'bg-green-400'}"
          ></span>
          <span class="truncate">{a.conv}</span>
        </span>
        <span class="shrink-0 text-neutral-500">
          served, silent
          {#if a.verdict === 'stranded'}
            <button
              class="cursor-pointer rounded border border-neutral-700 px-1.5 text-neutral-300 hover:bg-neutral-800"
              onclick={(e) => {
                e.stopPropagation();
                rail.dismissAttachment(a.conv);
              }}>Dismiss</button
            >
          {/if}
        </span>
        {#if a.cwd}
          <span class="w-full truncate pt-0.5 text-xs text-neutral-500">{a.cwd}</span>
        {/if}
      </div>
    </li>
  {/each}
  {#each sections as section (section.label ?? '')}
    {#if section.label !== null}
      <li
        class="flex justify-between gap-2 border-b border-neutral-800 bg-neutral-900 px-3 py-1 text-xs"
      >
        <span class="truncate" style="color: {rail.tagKeys[view.view.groupKey] ?? '#999'}"
          >{section.label}</span
        >
        <span class="shrink-0 text-neutral-500"
          >{section.rows.length} · <span class={heat(now, section.max)}>{age(now, section.max)}</span
          ></span
        >
      </li>
    {/if}
    {#each section.rows as row (row.conv)}
      {@const verdict = rail.verdict(row.conv)}
      <li>
        <button
          class="flex w-full cursor-pointer flex-wrap justify-between gap-x-2 border-b border-neutral-800 px-3 py-2 text-left hover:bg-neutral-900 {view.tab.convs.includes(
            row.conv,
          )
            ? 'bg-slate-800'
            : ''}"
          onclick={() =>
            view.tab.convs.includes(row.conv)
              ? view.closeConversation(row.conv)
              : view.openConversation(row.conv)}
        >
          <span class="flex min-w-0 items-center gap-1.5">
            {#if pendingByConv.has(row.conv)}<span class="shrink-0 text-amber-300">⚠</span
              >{/if}
            {#if rail.staleConvs.has(row.conv)}<span
                class="shrink-0 text-sky-400"
                title="nobody's looked at this since it last got new content">●</span
              >{/if}
            {#if verdict === 'alive'}
              <span class="h-2 w-2 shrink-0 rounded-full bg-green-400"></span>
            {:else if verdict === 'stranded'}
              <span class="h-2 w-2 shrink-0 rounded-full bg-red-400"></span>
            {/if}
            <span class="truncate" class:text-neutral-200={row.title}>{row.title ?? row.conv}</span>
          </span>
          <span class="flex shrink-0 gap-2 text-neutral-400">
            <span>{row.lastKind}</span>
            <span class="min-w-[3ch] text-right {heat(now, row.lastEvent)}">{age(now, row.lastEvent)}</span>
          </span>
          {#if view.view.alwaysShow.some((k) => row.tags?.[k])}
            <span class="flex w-full flex-wrap gap-1 pt-0.5 text-xs">
              {#each view.view.alwaysShow as k (k)}
                {#if row.tags?.[k]}
                  <!-- The value only; the colour says which key it is. -->
                  <span
                    class="rounded-full border border-current px-1.5 opacity-80"
                    style="color: {rail.tagKeys[k] ?? '#888'}">{row.tags[k]}</span
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
