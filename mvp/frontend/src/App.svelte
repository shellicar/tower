<script lang="ts">
  import ConversationPanel from './lib/ConversationPanel.svelte';
  import RowList from './lib/RowList.svelte';
  import { tower } from './lib/tower.svelte';
</script>

<!-- Staleness first: the list is always there, ordered by last event; open
     conversations are drill-downs beside it, any number at once. -->
<div class="layout">
  <aside>
    <header>
      <h1>Tower</h1>
      <span class="status" class:connected={tower.connected}>
        {tower.connected ? 'live' : 'reconnecting…'}
      </span>
    </header>
    <RowList />
  </aside>
  <main>
    {#each [...tower.open.values()] as oc (oc.conv)}
      <ConversationPanel {oc} />
    {:else}
      <p class="empty">Open a conversation from the list.</p>
    {/each}
  </main>
</div>

<style>
  :global(body) {
    margin: 0;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 13px;
    background: #111;
    color: #ddd;
  }
  .layout {
    display: grid;
    grid-template-columns: 320px 1fr;
    height: 100vh;
  }
  aside {
    border-right: 1px solid #333;
    overflow-y: auto;
  }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid #333;
  }
  h1 {
    font-size: 14px;
    margin: 0;
  }
  .status {
    color: #b66;
  }
  .status.connected {
    color: #6b6;
  }
  main {
    display: flex;
    overflow-x: auto;
  }
  .empty {
    margin: auto;
    color: #666;
  }
</style>
