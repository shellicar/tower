<script lang="ts">
  import ApprovalsView from './lib/ApprovalsView.svelte';
  import ConversationPanel from './lib/ConversationPanel.svelte';
  import RowList from './lib/RowList.svelte';
  import { tower } from './lib/tower.svelte';
</script>

<!-- Staleness first: the list is always there, ordered by last event; open
     conversations are drill-downs beside it, any number at once. -->
<div class="grid h-screen grid-cols-[320px_1fr]">
  <aside class="overflow-y-auto border-r border-neutral-700">
    <header class="flex items-baseline justify-between border-b border-neutral-700 px-3 py-2">
      <h1 class="text-sm font-bold">Tower</h1>
      <span class="flex items-baseline gap-3">
        {#if tower.pendingApprovals.length > 0}
          <button
            class="cursor-pointer text-amber-300 hover:text-amber-200"
            onclick={() => (tower.approvalsOpen = !tower.approvalsOpen)}
          >
            ⚠ {tower.pendingApprovals.length}
          </button>
        {/if}
        <span class={tower.connected ? 'text-green-500' : 'text-red-400'}>
          {tower.connected ? 'live' : 'reconnecting…'}
        </span>
      </span>
    </header>
    <RowList />
  </aside>
  <main class="flex overflow-x-auto">
    {#if tower.approvalsOpen}
      <ApprovalsView />
    {/if}
    {#each [...tower.open.values()] as oc (oc.conv)}
      <ConversationPanel {oc} />
    {:else}
      {#if !tower.approvalsOpen}
        <p class="m-auto text-neutral-500">Open a conversation from the list.</p>
      {/if}
    {/each}
  </main>
</div>
