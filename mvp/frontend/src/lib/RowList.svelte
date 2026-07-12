<script lang="ts">
  import { tower } from './tower.svelte';

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
</script>

<ul>
  {#each tower.ordered as row (row.conv)}
    <li>
      <button
        class="flex w-full cursor-pointer justify-between gap-2 border-b border-neutral-800 px-3 py-2 text-left hover:bg-neutral-900 {tower.open.has(row.conv) ? 'bg-slate-800' : ''}"
        onclick={() =>
          tower.open.has(row.conv)
            ? tower.closeConversation(row.conv)
            : tower.openConversation(row.conv)}
      >
        <span class="truncate" class:text-neutral-200={row.title}>
          {#if tower.pendingByConv.has(row.conv)}<span class="text-amber-300">⚠ </span>{/if}{row.title ?? row.conv}
        </span>
        <span class="flex shrink-0 gap-2 text-neutral-400">
          <span>{row.lastKind}</span>
          <span class="min-w-[3ch] text-right">{age(row.lastEvent)}</span>
        </span>
      </button>
    </li>
  {:else}
    <li class="p-3 text-neutral-500">No conversations yet.</li>
  {/each}
</ul>
