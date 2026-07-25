<script lang="ts">
  import { rail, view } from './app';
  import { age } from './core/time';

  // The unread/stale-conversations pane, same shape as ApprovalsView: a
  // one-click surface listing what's waiting, oldest-touched first. Opening
  // a conversation from here auto-acks it server-side (towerd infers the ack
  // from the open, not a click here) — the badge just clears on its own.
  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 1_000);
    return () => clearInterval(t);
  });
</script>

<section class="flex h-full min-w-[480px] flex-1 flex-col border-r border-neutral-700">
  <header class="flex items-center justify-between border-b border-neutral-700 px-3 py-2">
    <span class="text-sky-300">unread · {rail.staleRows.length}</span>
    <button
      class="cursor-pointer text-base text-neutral-400 hover:text-neutral-200"
      onclick={() => (view.unreadOpen = false)}>×</button
    >
  </header>

  <div class="flex-1 overflow-y-auto">
    {#each rail.staleRows as row (row.conv)}
      <article class="flex items-center justify-between gap-2 border-b border-neutral-800 px-3 py-2">
        <button
          class="cursor-pointer truncate text-sky-300 hover:underline"
          onclick={() => view.openConversation(row.conv)}
        >
          ● {row.title ?? row.conv}
        </button>
        <span class="shrink-0 text-neutral-500">{age(now, row.lastEvent)}</span>
      </article>
    {:else}
      <p class="p-3 text-neutral-500">Nothing's gone stale.</p>
    {/each}
  </div>
</section>
