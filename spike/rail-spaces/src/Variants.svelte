<script lang="ts">
  // Read-only. Six ways to present which controls belong to the space and
  // which travel with the reader, drawn at the rail's real width so the
  // wrapping is honest. Nothing here is wired to the model.

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
  const label = 'text-neutral-500';
  const box =
    'w-36 min-w-0 border border-neutral-700 bg-neutral-900 px-1 text-neutral-600';
  const select = 'border border-neutral-700 bg-neutral-900 px-1 text-neutral-300';
</script>

{#snippet scope()}
  <span class={label}>scope</span>
  <span class={on}>all</span>
  <span class={off}>this space</span>
  <span class={off}>unplaced</span>
{/snippet}

{#snippet attention()}
  <span class="cursor-default rounded border border-green-600 px-1.5 text-green-300">live</span>
  <span class={off}>unread</span>
{/snippet}

{#snippet idbox()}
  <span class={box}>conversation id</span>
{/snippet}

{#snippet show()}
  <span class={label}>show</span>
  {#each ['repo', 'role'] as k (k)}
    <span class="cursor-default rounded border border-current px-1.5" style="color: {colours[k]}">{k}</span>
  {/each}
  {#each ['org', 'pr'] as k (k)}
    <span class="cursor-default rounded border border-neutral-700 px-1.5 text-neutral-500">{k}</span>
  {/each}
{/snippet}

{#snippet group()}
  <span class={label}>group</span>
  <span class={select}>repo</span>
  <span class={off}>hide untagged</span>
{/snippet}

{#snippet facets()}
  {#each keys as k (k)}
    <span class={k === 'org' ? on : off}>{k}{k === 'org' ? ' (2)' : ''}</span>
  {/each}
{/snippet}

{#snippet rowsBelow()}
  <div class="border-b border-neutral-800 px-3 py-2">
    <div class="flex justify-between gap-2">
      <span class="truncate text-neutral-200">Land tag-conversations PR with the fix</span>
      <span class="flex shrink-0 gap-2 text-neutral-400"
        ><span class="rounded bg-sky-900 px-1.5 text-sky-100">tower</span><span>query</span><span
          class="text-neutral-500">14d</span
        ></span
      >
    </div>
  </div>
  <div class="border-b border-neutral-800 px-3 py-2">
    <div class="flex justify-between gap-2">
      <span class="truncate text-neutral-200">Land dev.sh signal handling fix</span>
      <span class="flex shrink-0 gap-2 text-neutral-400"><span>message</span><span class="text-neutral-500">14d</span></span>
    </div>
  </div>
{/snippet}

{#snippet variant(title: string, note: string, body: import('svelte').Snippet)}
  <section class="flex w-[320px] shrink-0 flex-col border-r border-neutral-700">
    <header class="border-b border-neutral-700 px-3 py-2">
      <h2 class="text-sm font-bold text-sky-300">{title}</h2>
      <p class="mt-0.5 text-xs text-neutral-500">{note}</p>
    </header>
    <div class="text-xs">
      {@render body()}
      {@render rowsBelow()}
    </div>
  </section>
{/snippet}

<div class="flex h-screen overflow-x-auto">
  <!-- 1 -->
  {#snippet today()}
    <div class="border-b border-neutral-800 px-3 py-2">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">{@render scope()}<span class={label}>638/638</span></div>
      <div class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">{@render group()}{@render show()}</div>
      <div class="mt-1.5 flex flex-wrap items-center gap-1">
        <span class={label}>filter</span>{@render idbox()}{@render attention()}{@render facets()}
      </div>
      <p class="mt-1.5 text-neutral-500">these belong to tower <span class={off}>clear</span></p>
    </div>
  {/snippet}
  {@render variant('1 · today', 'The split is real but invisible: group sits beside show, facets beside unread.', today)}

  <!-- 2 -->
  {#snippet labelled()}
    <div class="border-b border-neutral-800 px-3 py-2">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">{@render scope()}{@render attention()}</div>
      <div class="mt-1.5 flex flex-wrap items-center gap-1">{@render idbox()}{@render show()}</div>
    </div>
    <div class="border-b border-neutral-800 px-3 py-2">
      <div class="mb-1 flex items-baseline justify-between">
        <span class="text-neutral-300">tower</span>
        <span class={off}>clear</span>
      </div>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">{@render group()}</div>
      <div class="mt-1.5 flex flex-wrap items-center gap-1">{@render facets()}</div>
    </div>
  {/snippet}
  {@render variant(
    '2 · one block is named',
    'Global is the unlabelled default; only the space block is named, and it says which space.',
    labelled,
  )}

  <!-- 3 -->
  {#snippet bothNamed()}
    <div class="border-b border-neutral-800 px-3 py-2">
      <p class="mb-1 text-neutral-600">everywhere</p>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">{@render scope()}{@render attention()}</div>
      <div class="mt-1.5 flex flex-wrap items-center gap-1">{@render idbox()}{@render show()}</div>
    </div>
    <div class="border-b border-neutral-800 px-3 py-2">
      <p class="mb-1 text-neutral-600">in tower</p>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">{@render group()}</div>
      <div class="mt-1.5 flex flex-wrap items-center gap-1">{@render facets()}</div>
    </div>
  {/snippet}
  {@render variant('3 · both named', 'Symmetrical and unambiguous. Costs two lines of pure label.', bothNamed)}

  <!-- 4 -->
  {#snippet ruled()}
    <div class="border-b border-neutral-800 px-3 py-2">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">{@render scope()}{@render attention()}</div>
      <div class="mt-1.5 flex flex-wrap items-center gap-1">{@render idbox()}{@render show()}</div>
    </div>
    <div class="border-b border-neutral-800 border-l-2 border-l-sky-800 bg-neutral-950 px-3 py-2">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">{@render group()}</div>
      <div class="mt-1.5 flex flex-wrap items-center gap-1">{@render facets()}</div>
      <p class="mt-1.5 text-neutral-600">tower <span class={off}>clear</span></p>
    </div>
  {/snippet}
  {@render variant(
    '4 · the space block is set back',
    'An edge and a darker ground carry it instead of a heading. Cheapest in height.',
    ruled,
  )}

  <!-- 5 -->
  {#snippet marked()}
    <div class="border-b border-neutral-800 px-3 py-2">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">{@render scope()}<span class={label}>638/638</span></div>
      <div class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span class={label}>group</span>
        <span class="{select} border-l-2 border-l-sky-700">repo</span>
        <span class="{off} border-l-2 border-l-sky-700">hide untagged</span>
        {@render show()}
      </div>
      <div class="mt-1.5 flex flex-wrap items-center gap-1">
        <span class={label}>filter</span>{@render idbox()}{@render attention()}
        {#each keys as k (k)}
          <span class="{k === 'org' ? on : off} border-l-2 border-l-sky-700">{k}{k === 'org' ? ' (2)' : ''}</span>
        {/each}
      </div>
      <p class="mt-1.5 text-neutral-600">▌ belongs to tower <span class={off}>clear</span></p>
    </div>
  {/snippet}
  {@render variant(
    "5 · today's layout, marked",
    'Nothing moves; a coloured edge marks the per-space ones. One legend line explains it.',
    marked,
  )}

  <!-- 6 -->
  {#snippet duplicated()}
    <div class="border-b border-neutral-800 px-3 py-2">
      <p class="mb-1 text-neutral-600">everywhere</p>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">{@render scope()}{@render attention()}</div>
      <div class="mt-1.5 flex flex-wrap items-center gap-1">{@render idbox()}{@render show()}</div>
      <div class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">{@render group()}</div>
      <div class="mt-1.5 flex flex-wrap items-center gap-1">{@render facets()}</div>
    </div>
    <div class="border-b border-neutral-800 px-3 py-2">
      <p class="mb-1 text-neutral-600">in tower</p>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">{@render attention()}</div>
      <div class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">{@render group()}</div>
      <div class="mt-1.5 flex flex-wrap items-center gap-1">{@render facets()}</div>
    </div>
  {/snippet}
  {@render variant(
    '6 · every control in both',
    'Your suggestion, taken literally: each filter exists globally and per space. Tallest, and two identical controls sit a thumb apart.',
    duplicated,
  )}
</div>
