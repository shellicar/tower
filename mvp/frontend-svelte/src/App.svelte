<script lang="ts">
  import ApprovalsView from './lib/ApprovalsView.svelte';
  import ConversationPanel from './lib/ConversationPanel.svelte';
  import RowList from './lib/RowList.svelte';
  import UnreadView from './lib/UnreadView.svelte';
  import { approvals, conversations, rail, transport, view } from './lib/app';

  const tabStaleCount = (convs: string[]) => convs.filter((c) => rail.staleConvs.has(c)).length;
</script>

<!-- Staleness first: the list is always there, ordered by last event; open
     conversations are drill-downs beside it, any number at once. -->
<div class="grid h-screen grid-cols-[320px_1fr]">
  <aside class="overflow-y-auto border-r border-neutral-700">
    <header class="flex items-baseline justify-between border-b border-neutral-700 px-3 py-2">
      <h1 class="text-sm font-bold">Tower</h1>
      <span class="flex items-baseline gap-3">
        {#if approvals.pendingApprovals.length > 0}
          <button
            class="cursor-pointer text-amber-300 hover:text-amber-200"
            onclick={() => (view.approvalsOpen = !view.approvalsOpen)}
          >
            ⚠ {approvals.pendingApprovals.length}
          </button>
        {/if}
        {#if rail.staleRows.length > 0}
          <button
            class="cursor-pointer text-sky-300 hover:text-sky-200"
            onclick={() => (view.unreadOpen = !view.unreadOpen)}
          >
            ● {rail.staleRows.length}
          </button>
        {/if}
        <span class={transport.connected ? 'text-green-500' : 'text-red-400'}>
          {transport.connected ? 'live' : 'reconnecting…'}
        </span>
      </span>
    </header>
    <RowList />
  </aside>
  <!-- min-h-0 defeats the grid child's implicit min-height:auto — without
       it, content grows main past the track and h-full children follow. -->
  <main class="flex min-h-0 min-w-0 flex-col">
    <!-- Tabs: each is a whole view — its own filters, grouping, and open
         conversations. Click switches; click the active one renames;
         × closes (never the last). -->
    <div class="flex items-baseline gap-1 border-b border-neutral-700 px-2 pt-1">
      {#each view.tabs as t, i (i)}
        <span
          class="flex items-baseline gap-1.5 rounded-t border border-b-0 px-2.5 py-0.5 text-xs {i ===
          view.active
            ? 'border-neutral-600 bg-neutral-900 text-neutral-100'
            : 'border-neutral-800 text-neutral-500'}"
        >
          <button
            class="cursor-pointer"
            onclick={() =>
              i === view.active
                ? view.renameTab(i, prompt('tab name', t.name) ?? t.name)
                : view.switchTab(i)}>{t.name}</button
          >
          {#if tabStaleCount(t.convs) > 0}
            <span class="text-sky-300" title="unread in this tab">● {tabStaleCount(t.convs)}</span>
          {/if}
          <!-- Closing is deliberate: only the active tab offers it, and it
               confirms — a tab is a mission control, not a scratch view. -->
          {#if view.tabs.length > 1 && i === view.active}
            <button
              class="cursor-pointer text-neutral-600 hover:text-red-400"
              onclick={() => {
                if (confirm(`Close tab “${t.name}”?`)) view.closeTab(i);
              }}>×</button
            >
          {/if}
        </span>
      {/each}
      <button
        class="cursor-pointer px-1.5 text-neutral-500 hover:text-neutral-200"
        onclick={() => view.addTab()}>+</button
      >
    </div>
    <div class="flex min-h-0 flex-1 overflow-x-auto">
      {#if view.approvalsOpen}
        <ApprovalsView />
      {/if}
      {#if view.unreadOpen}
        <UnreadView />
      {/if}
      <!-- Only the active tab's conversations render. -->
      {#each view.tab.convs.filter((c) => conversations.get(c) !== undefined) as conv (conv)}
        <ConversationPanel oc={conversations.get(conv)!} />
      {:else}
        {#if !view.approvalsOpen && !view.unreadOpen}
          <p class="m-auto text-neutral-500">Open a conversation from the list.</p>
        {/if}
      {/each}
    </div>
  </main>
</div>
