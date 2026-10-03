<script lang="ts">
  import BlockView from './BlockView.svelte';
  import { senderLabel } from './core/sender';
  import {
    blocksText,
    clockLabel,
    formatDuration,
    shownToUser,
    userBlocks,
  } from './core/extras';
  import type { ConversationMessage } from './types';

  // `replaced`: a compaction took this message out of what the model is sent.
  let { message, replaced = false }: { message: ConversationMessage; replaced?: boolean } =
    $props();

  const who = $derived(senderLabel(message));
  const time = $derived(
    new Date(message.ts).toLocaleTimeString(undefined, { hour12: false }),
  );
  const edge = $derived(
    message.role === 'assistant'
      ? 'border-green-800'
      : message.role === 'user'
        ? 'border-indigo-800'
        : 'border-neutral-600',
  );
  const blocks = $derived(userBlocks(message));
  const shownText = $derived(blocksText(blocks));
  const fields = $derived(message.fields ?? {});
  const number = (value: unknown): number | undefined =>
    typeof value === 'number' ? value : undefined;
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;
  // Only a message the person is not shown reaches here when the view shows
  // what only the model sees.
  const modelOnly = $derived(!shownToUser(message));
  const finished = $derived(
    number(fields.durationMs) !== undefined
      ? `Worked for ${formatDuration(number(fields.durationMs) as number)}`
      : shownText,
  );
  const ended = $derived(clockLabel(text(fields.endedAt) ?? message.at ?? message.ts));
</script>

{#snippet marks()}
  {#if replaced}
    <span class="text-neutral-500">· no longer sent to the model</span>
  {/if}
{/snippet}

<div class:opacity-40={replaced}>
  {#if modelOnly}
    <article class="my-2 border-l-2 border-dashed border-neutral-700 py-1.5 pl-2 opacity-70">
      <header class="mb-1 flex gap-2 text-neutral-500">
        <span>model only · {message.kind ?? who}</span>
        <span>{time}</span>
        {@render marks()}
      </header>
      {#each message.content as block, i (i)}
        <div class="max-h-24 overflow-hidden text-neutral-500">
          <BlockView {block} />
        </div>
      {/each}
    </article>
  {:else if message.kind === 'turn-finished'}
    <div class="my-1 pl-2 text-neutral-500">
      {finished}{ended ? ` · done ${ended}` : ''}
      {@render marks()}
    </div>
  {:else if message.kind === 'interrupted'}
    <div class="my-1 pl-2 text-neutral-500">
      {shownText}{fields.during === 'tool-use' ? ' · during tool use' : ''}
      {@render marks()}
    </div>
  {:else if message.kind === 'tool-call-note'}
    <div class="my-1 pl-2 text-neutral-500">
      {shownText}
      {@render marks()}
    </div>
  {:else if message.kind === 'task-finished'}
    <div class="my-1 pl-2">
      <span class={fields.status === 'failed' ? 'text-red-500' : 'text-green-500'}>●</span>
      <span class="text-neutral-300">{shownText}</span>
      <span class="text-neutral-500">{time}</span>
      {@render marks()}
    </div>
  {:else if message.kind === 'subagent-report'}
    <details class="my-2 border-l-2 border-indigo-800 py-1.5 pl-2">
      <summary class="cursor-pointer text-neutral-400">
        Message from @{text(fields.agentType) ?? 'agent'}
        <span class="text-neutral-500">{time}</span>
        {@render marks()}
      </summary>
      {#each blocks as block, i (i)}
        <BlockView {block} />
      {/each}
    </details>
  {:else if message.kind === 'compaction'}
    <details class="my-2 border-l-2 border-amber-800 py-1.5 pl-2">
      <summary class="cursor-pointer text-amber-300">
        Conversation compacted
        <span class="text-neutral-500">
          {text(fields.trigger) ?? ''}{number(fields.durationMs) !== undefined
            ? ` · ${formatDuration(number(fields.durationMs) as number)}`
            : ''}
        </span>
        <span class="text-neutral-500">{time}</span>
        {@render marks()}
      </summary>
      {#each blocks as block, i (i)}
        <BlockView {block} />
      {/each}
    </details>
  {:else if message.kind === 'api-error'}
    <article class="my-2 border-l-2 border-red-700 py-1.5 pl-2">
      <header class="mb-1 flex gap-2 text-red-400">
        <span>API error</span>
        <span class="text-neutral-500">
          {text(fields.error) ?? ''}{number(fields.status) !== undefined
            ? ` · ${number(fields.status)}`
            : ''}
        </span>
        <span class="text-neutral-500">{time}</span>
      </header>
      {#each blocks as block, i (i)}
        <div class="text-red-300"><BlockView {block} /></div>
      {/each}
    </article>
  {:else}
    <article class="my-2 border-l-2 py-1.5 pl-2 {edge}">
      <header class="mb-1 flex gap-2 text-neutral-400">
        <span class="text-neutral-300">{who}</span>
        <span>{time}</span>
        {@render marks()}
      </header>
      {#each blocks as block, i (i)}
        <BlockView {block} markdown={message.role === 'assistant'} />
      {/each}
    </article>
  {/if}
</div>
