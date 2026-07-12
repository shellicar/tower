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
  <main class="flex min-w-0 flex-col">
    <!-- Tabs: each is a whole view — its own filters, grouping, and open
         conversations. Click switches; click the active one renames;
         × closes (never the last). -->
    <div class="flex items-baseline gap-1 border-b border-neutral-700 px-2 pt-1">
      {#each tower.tabs as t, i (i)}
        <span
          class="flex items-baseline gap-1.5 rounded-t border border-b-0 px-2.5 py-0.5 text-xs {i ===
          tower.active
            ? 'border-neutral-600 bg-neutral-900 text-neutral-100'
            : 'border-neutral-800 text-neutral-500'}"
        >
          <button
            class="cursor-pointer"
            onclick={() =>
              i === tower.active
                ? tower.renameTab(i, prompt('tab name', t.name) ?? t.name)
                : tower.switchTab(i)}>{t.name}</button
          >
          <!-- Closing is deliberate: only the active tab offers it, and it
               confirms — a tab is a mission control, not a scratch view. -->
          {#if tower.tabs.length > 1 && i === tower.active}
            <button
              class="cursor-pointer text-neutral-600 hover:text-red-400"
              onclick={() => {
                if (confirm(`Close tab “${t.name}”?`)) tower.closeTab(i);
              }}>×</button
            >
          {/if}
        </span>
      {/each}
      <button
        class="cursor-pointer px-1.5 text-neutral-500 hover:text-neutral-200"
        onclick={() => tower.addTab()}>+</button
      >
    </div>
    <div class="flex min-h-0 flex-1 overflow-x-auto">
      {#if tower.approvalsOpen}
        <ApprovalsView />
      {/if}
      <!-- Only the active tab's conversations render; the others stay warm. -->
      {#each tower.tab.convs.filter((c) => tower.open.has(c)) as conv (conv)}
        <ConversationPanel oc={tower.open.get(conv)!} />
      {:else}
        {#if !tower.approvalsOpen}
          <p class="m-auto text-neutral-500">Open a conversation from the list.</p>
        {/if}
      {/each}
    </div>
  </main>
</div>
