<script lang="ts">
  import { fixture } from './fixture';
  import Panel from './lib/Panel.svelte';
  import Rail from './lib/Rail.svelte';
  import SpaceStrip from './lib/SpaceStrip.svelte';
  import { live } from './lib/reactive.svelte';
  import { Layout } from './model/layout';

  const rows = new Map(fixture.conversations.map((r) => [r.conv, r]));
  const register = fixture.conversations.map((r) => r.conv);
  // The fixture is a snapshot, so "now" is its newest event rather than the
  // wall clock: otherwise every row reads as weeks old.
  const now = fixture.conversations.reduce((latest, r) => Math.max(latest, r.lastEvent), 0);
  const rowOf = (conv: string) => rows.get(conv);
  const stale = new Set(fixture.conversations.filter((r) => r.stale).map((r) => r.conv));
  const staleCount = (convs: string[]) => convs.filter((c) => stale.has(c)).length;

  const model = live(new Layout(fixture.layout));

  const drawn = $derived(model.model.drawn);
  const away = $derived(model.model.minimised);
  const shown = $derived(model.model.shownSpace);
</script>

<div class="grid h-screen grid-cols-[320px_1fr]">
  <aside class="flex min-h-0 flex-col overflow-hidden border-r border-neutral-700">
    <header class="flex items-baseline justify-between border-b border-neutral-700 px-3 py-2">
      <h1 class="text-sm font-bold">Tower <span class="font-normal text-neutral-600">rail spaces spike</span></h1>
      <span class="text-sky-300">● {stale.size}</span>
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <Rail live={model} {register} {rowOf} tagKeys={fixture.tagKeys} {now} />
    </div>
  </aside>
  <main class="flex min-h-0 min-w-0 flex-col">
    <SpaceStrip live={model} {staleCount} />
    <div class="flex min-h-0 flex-1 overflow-x-auto">
      {#each drawn as conv (conv)}
        {@const row = rowOf(conv)}
        {#if row !== undefined}
          <Panel {row} onMinimise={() => model.act((m) => m.minimise(conv))} />
        {/if}
      {:else}
        <p class="m-auto text-neutral-500">
          {#if shown === null}
            No space in front. Pick one above, or click a conversation to go where it lives.
          {:else if model.model.placedIn(shown).length === 0}
            Nothing lives here yet. Right click a conversation in the rail to file it in.
          {:else}
            Nothing on screen. Everything that lives here is away.
          {/if}
        </p>
      {/each}
    </div>
    {#if away.length > 0}
      <div class="flex flex-wrap items-center gap-1.5 border-t border-neutral-700 px-3 py-1.5 text-xs">
        <span class="text-neutral-500">away</span>
        {#each away as conv (conv)}
          <button
            class="max-w-72 cursor-pointer truncate rounded border border-dashed border-neutral-700 px-1.5 text-neutral-400 hover:text-neutral-100"
            title="bring it back onto the screen"
            onclick={() => model.act((m) => m.restore(conv))}>{rowOf(conv)?.title ?? conv}</button
          >
        {/each}
      </div>
    {/if}
  </main>
</div>
