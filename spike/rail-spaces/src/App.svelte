<script lang="ts">
  import { fixture } from './fixture';
  import Panel from './lib/Panel.svelte';
  import Rail from './lib/Rail.svelte';
  import SpaceStrip from './lib/SpaceStrip.svelte';
  import { livenessVerdict } from './lib/core/time';
  import { reactive } from './lib/reactive.svelte';
  import { Layout } from './model/layout';

  const rows = new Map(fixture.conversations.map((r) => [r.conv, r]));
  // The fixture is a snapshot, so "now" is the instant it was taken rather than
  // the wall clock: ages and the liveness verdict then read as they did then.
  const now = fixture.takenAtMs;
  const verdicts = new Map(
    fixture.attachments.map((a) => [a.conv, livenessVerdict(now, a.lastPulse, a.intervalS)] as const),
  );
  const rowOf = (conv: string) => rows.get(conv);
  const stale = new Set(fixture.conversations.filter((r) => r.stale).map((r) => r.conv));
  const staleCount = (convs: string[]) => convs.filter((c) => stale.has(c)).length;

  const model = reactive(new Layout(fixture.layout));

  const drawn = $derived(model.layout.drawn);
  const shown = $derived(model.layout.shownSpace);

  // Which panel was asked for, when several are drawn.
  let arrived = $state('');
  let clearArrival: ReturnType<typeof setTimeout> | undefined;
  function arriveAt(conv: string) {
    arrived = conv;
    clearTimeout(clearArrival);
    clearArrival = setTimeout(() => (arrived = ''), 1500);
  }
</script>

<div class="grid h-screen grid-cols-[320px_1fr]">
  <aside class="flex min-h-0 flex-col overflow-hidden border-r border-neutral-700">
    <header class="flex items-baseline justify-between border-b border-neutral-700 px-3 py-2">
      <h1 class="text-sm font-bold">Tower <span class="font-normal text-neutral-600">rail spaces spike</span></h1>
      <span class="text-sky-300">● {stale.size}</span>
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <Rail
        {model}
        rows={fixture.conversations}
        tagKeys={fixture.tagKeys}
        {now}
        {verdicts}
        onArrive={arriveAt}
      />
    </div>
  </aside>
  <main class="flex min-h-0 min-w-0 flex-col">
    <SpaceStrip {model} {staleCount} />
    <div class="flex min-h-0 flex-1 overflow-x-auto">
      {#each drawn as conv (conv)}
        {@const row = rowOf(conv)}
        {#if row !== undefined}
          <Panel
            {row}
            arrived={arrived === conv}
            onMinimise={() => model.act((m) => m.minimise(conv))}
            onUnplace={() => model.act((m) => m.unplace(conv))}
          />
        {/if}
      {:else}
        <p class="m-auto max-w-md text-center text-neutral-500">
          {#if shown === null}
            No space shown. Pick one above, or click a conversation to show the space it is placed in.
          {:else if model.layout.placedIn(shown).length === 0}
            Nothing is placed here yet. Right click a conversation in the rail to place it here.
          {:else}
            Every conversation placed here is minimised. Scope the rail to this space to draw one again.
          {/if}
        </p>
      {/each}
    </div>
  </main>
</div>
