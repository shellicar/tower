<script lang="ts">
  // Read-only. Ways to present which controls belong to the space and which
  // travel with the reader. Nothing is renamed and nothing moves between rows:
  // the words are the ones the rail uses today, so the only difference between
  // these is how ownership is shown. `filter` appears in both blocks, because
  // there are filters in both. Drawn at the rail's real width.

  const keys = ['org', 'platform', 'pr', 'project', 'repo', 'role', 'worktree'];
  const colours: Record<string, string> = {
    org: '#8ec07c',
    platform: '#7fc7ff',
    pr: '#b8bb26',
    project: '#fabd2f',
    repo: '#83a598',
    role: '#fe8019',
    worktree: '#d3869b',
  };

  const off = 'cursor-default rounded border border-neutral-700 px-1.5 text-neutral-400';
  const on = 'cursor-default rounded border border-sky-600 px-1.5 text-sky-300';
  const live = 'cursor-default rounded border border-green-600 px-1.5 text-green-300';
  const label = 'text-neutral-500';
  const box = 'w-36 min-w-0 border border-neutral-700 bg-neutral-900 px-1 text-neutral-600';
  const select = 'border border-neutral-700 bg-neutral-900 px-1 text-neutral-300';
  const row = 'flex flex-wrap items-center gap-1';
  const owned = 'border-l-2 border-l-sky-700 pl-1';
</script>

{#snippet scopeChips()}
  <span class={on}>all</span><span class={off}>this space</span><span class={off}>unplaced</span>
{/snippet}

{#snippet globalFilterChips()}
  <span class={box}>conversation id</span><span class={live}>live</span><span class={off}>unread</span>
{/snippet}

{#snippet spaceFilterChips()}
  {#each keys as k (k)}<span class={k === 'org' ? on : off}>{k}{k === 'org' ? ' (2)' : ''}</span>{/each}
{/snippet}

{#snippet groupChips()}
  <span class={select}>repo</span><span class={off}>hide untagged</span>
{/snippet}

{#snippet showChips()}
  {#each ['repo', 'role'] as k (k)}<span
      class="cursor-default rounded border border-current px-1.5"
      style="color: {colours[k]}">{k}</span
    >{/each}
  {#each ['org', 'pr'] as k (k)}<span class="cursor-default rounded border border-neutral-700 px-1.5 text-neutral-500"
      >{k}</span
    >{/each}
{/snippet}

{#snippet rowsBelow()}
  {#each [['Land tag-conversations PR with the fix', 'tower'], ['Land dev.sh signal handling fix', '']] as [title, space] (title)}
    <div class="flex justify-between gap-2 border-b border-neutral-800 px-3 py-2">
      <span class="truncate text-neutral-200">{title}</span>
      <span class="flex shrink-0 items-baseline gap-2 text-neutral-400">
        {#if space}<span class="rounded bg-sky-900 px-1.5 text-sky-100">{space}</span>{/if}
        <span class="text-neutral-500">14d</span>
      </span>
    </div>
  {/each}
{/snippet}

{#snippet variant(title: string, note: string, body: import('svelte').Snippet)}
  <section class="flex w-[320px] shrink-0 flex-col border-r border-neutral-700">
    <header class="border-b border-neutral-700 px-3 py-2">
      <h2 class="text-sm font-bold text-sky-300">{title}</h2>
      <p class="mt-0.5 text-xs text-neutral-500">{note}</p>
    </header>
    <div class="overflow-y-auto text-xs">
      {@render body()}
      {@render rowsBelow()}
    </div>
  </section>
{/snippet}

<div class="flex h-screen overflow-x-auto">
  {#snippet today()}
    <div class="border-b border-neutral-800 px-3 py-2">
      <div class={row}><span class={label}>scope</span>{@render scopeChips()}<span class={label}>638/638</span></div>
      <div class="mt-1.5 {row}">
        <span class={label}>group</span>{@render groupChips()}<span class="ml-2 {label}">show</span>{@render showChips()}
      </div>
      <div class="mt-1.5 {row}">
        <span class={label}>filter</span>{@render globalFilterChips()}{@render spaceFilterChips()}
      </div>
      <p class="mt-1.5 text-neutral-500">these belong to tower <span class={off}>clear</span></p>
    </div>
  {/snippet}
  {@render variant(
    '1 · today',
    'The split is real but invisible. Group is the space’s and sits beside show, which is yours; the tag chips are the space’s and sit beside unread, which is yours.',
    today,
  )}

  {#snippet marked()}
    <div class="border-b border-neutral-800 px-3 py-2">
      <div class={row}><span class={label}>scope</span>{@render scopeChips()}<span class={label}>638/638</span></div>
      <div class="mt-1.5 {row}">
        <span class={label}>group</span><span class="{row} {owned}">{@render groupChips()}</span>
        <span class="ml-2 {label}">show</span>{@render showChips()}
      </div>
      <div class="mt-1.5 {row}">
        <span class={label}>filter</span>{@render globalFilterChips()}<span class="{row} {owned}"
          >{@render spaceFilterChips()}</span
        >
      </div>
      <p class="mt-1.5 text-neutral-600">▌ belongs to tower <span class={off}>clear</span></p>
    </div>
  {/snippet}
  {@render variant(
    '2 · marked where they are',
    'Nothing moves. A blue edge runs beside the controls the space owns, explained once at the bottom.',
    marked,
  )}

  {#snippet column()}
    <div class="border-b border-neutral-800 px-3 py-2">
      <div class="grid grid-cols-[auto_1fr] items-baseline gap-x-2 gap-y-1.5">
        <span class={label}>scope</span><span class={row}>{@render scopeChips()}</span>
        <span class={label}>filter</span><span class={row}>{@render globalFilterChips()}</span>
        <span class={label}>show</span><span class={row}>{@render showChips()}</span>
        <span class="text-sky-200/70">tower</span><span></span>
        <span class={label}>group</span><span class={row}>{@render groupChips()}</span>
        <span class={label}>filter</span><span class={row}>{@render spaceFilterChips()}</span>
      </div>
    </div>
  {/snippet}
  {@render variant(
    '3 · one column, split by a name',
    'Words line up down the left so they stay readable when chips wrap. The space’s name is a row of its own, and everything below it is the space’s. Filter appears twice, which is the point.',
    column,
  )}

  {#snippet blocks()}
    <div class="border-b border-neutral-800 px-3 py-2">
      <div class="grid grid-cols-[auto_1fr] items-baseline gap-x-2 gap-y-1.5">
        <span class={label}>scope</span><span class={row}>{@render scopeChips()}</span>
        <span class={label}>filter</span><span class={row}>{@render globalFilterChips()}</span>
        <span class={label}>show</span><span class={row}>{@render showChips()}</span>
      </div>
    </div>
    <div class="border-b border-neutral-800 bg-neutral-950 px-3 py-2">
      <div class="mb-1.5 flex items-baseline justify-between">
        <span class="text-neutral-300">tower</span><span class={off}>clear</span>
      </div>
      <div class="grid grid-cols-[auto_1fr] items-baseline gap-x-2 gap-y-1.5">
        <span class={label}>group</span><span class={row}>{@render groupChips()}</span>
        <span class={label}>filter</span><span class={row}>{@render spaceFilterChips()}</span>
      </div>
    </div>
  {/snippet}
  {@render variant(
    '4 · two blocks',
    'Same as 3, but the space’s controls get their own ground and their own clear, so the boundary is a surface rather than a name.',
    blocks,
  )}

  {#snippet folded()}
    <div class="border-b border-neutral-800 px-3 py-2">
      <div class="grid grid-cols-[auto_1fr] items-baseline gap-x-2 gap-y-1.5">
        <span class={label}>scope</span><span class={row}>{@render scopeChips()}</span>
        <span class={label}>filter</span><span class={row}>{@render globalFilterChips()}</span>
        <span class={label}>show</span><span class={row}>{@render showChips()}</span>
      </div>
    </div>
    <div class="flex items-baseline justify-between border-b border-neutral-800 bg-neutral-950 px-3 py-1.5">
      <span class="text-neutral-400">▸ tower: grouped by repo, filtered by org</span>
      <span class={off}>clear</span>
    </div>
  {/snippet}
  {@render variant(
    '5 · the space’s folded away',
    'One line says what the space has set, and opens. Much the shortest header, at the cost of a click before you can change either.',
    folded,
  )}
</div>
