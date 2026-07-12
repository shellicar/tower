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
        class:open={tower.open.has(row.conv)}
        onclick={() =>
          tower.open.has(row.conv)
            ? tower.closeConversation(row.conv)
            : tower.openConversation(row.conv)}
      >
        <span class="conv">{row.conv}</span>
        <span class="meta">
          <span class="kind">{row.lastKind}</span>
          <span class="age">{age(row.lastEvent)}</span>
        </span>
      </button>
    </li>
  {:else}
    <li class="none">No conversations yet.</li>
  {/each}
</ul>

<style>
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li.none {
    padding: 12px;
    color: #666;
  }
  button {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    background: none;
    border: none;
    border-bottom: 1px solid #222;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  button:hover {
    background: #1a1a1a;
  }
  button.open {
    background: #1d2733;
  }
  .conv {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
    color: #888;
  }
  .age {
    min-width: 3ch;
    text-align: right;
  }
</style>
