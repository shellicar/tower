<script lang="ts">
  import type { Row } from '../fixture';
  import { ago } from './ago';
  import type { Live } from './reactive.svelte';

  const {
    live,
    rowOf,
    tagKeys,
    now,
  }: {
    live: Live;
    rowOf: (conv: string) => Row | undefined;
    tagKeys: Record<string, string>;
    now: number;
  } = $props();

  const shown = $derived(live.model.shownSpace);
  const drawn = $derived(live.model.drawn);
  const away = $derived(live.model.minimised);
</script>

{#if shown === null}
  <div class="empty">No space in front. Pick one above, or click a conversation in the rail to go where it lives.</div>
{:else}
  <div class="panels">
    {#each drawn as conv (conv)}
      {@const row = rowOf(conv)}
      <div class="panel">
        <div class="panel-head">
          <span class="panel-title">{row?.title ?? '(untitled)'}</span>
          <button onclick={() => live.act((m) => m.minimise(conv))}>×</button>
        </div>
        <div class="row-bottom">
          <span class="id">{conv}</span>
          {#if row !== undefined}<span>{ago(row.lastEvent, now)}</span>{/if}
          {#if row?.stale}<span style="color: var(--warn)">stale</span>{/if}
        </div>
        {#if row?.tags !== undefined}
          <div class="row-bottom">
            {#each Object.entries(row.tags) as [key, value] (key)}
              <span class="tag" style="background: {tagKeys[key] ?? '#928374'}">{key}:{value}</span>
            {/each}
          </div>
        {/if}
        <div class="panel-body">no content: the spike carries no transport</div>
      </div>
    {/each}
    {#if drawn.length === 0}
      <div class="empty">
        {live.model.placedIn(shown).length === 0
          ? 'This space holds nothing yet. Right click a rail row to file one in.'
          : 'Nothing on screen. Everything placed here is away.'}
      </div>
    {/if}
  </div>
  {#if away.length > 0}
    <div class="away">
      <span>away ({away.length}):</span>
      {#each away as conv (conv)}
        <span class="chip" onclick={() => live.act((m) => m.restore(conv))} role="button" tabindex="-1"
          >{rowOf(conv)?.title ?? conv}</span
        >
      {/each}
    </div>
  {/if}
{/if}
