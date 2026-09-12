<script lang="ts">
  import type { Row } from '../fixture';
  import MessageView from './MessageView.svelte';
  import { messagesFor, usageFor } from './content';

  const { row, onMinimise }: { row: Row; onMinimise: () => void } = $props();

  const messages = $derived(messagesFor(row));
  const usage = $derived(usageFor(row));

  const formatTokens = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
  const formatUsd = (n: number) => `$${n.toFixed(2)}`;
</script>

<section class="flex h-full min-w-[480px] flex-1 flex-col border-r border-neutral-700">
  <header class="flex items-center justify-between gap-2 border-b border-neutral-700 px-3 py-2">
    <span class="min-w-0 truncate text-sky-300">{row.title ?? row.conv}</span>
    <button
      class="cursor-pointer text-base text-neutral-400 hover:text-neutral-200"
      title="clear it off the screen; it stays in this space"
      onclick={onMinimise}>×</button
    >
  </header>
  <div class="min-h-0 flex-1 overflow-y-auto px-3 py-2">
    {#each messages as message (message.id)}
      <MessageView {message} />
    {/each}
  </div>
  <div class="border-t border-neutral-700 px-3 py-2">
    <p class="mb-1.5 flex flex-wrap items-center gap-2 text-neutral-500">
      <span class="shrink-0">{row.conv}</span>
      <span class="rounded border border-neutral-700 px-1.5 text-neutral-500">state unknown</span>
    </p>
    <p class="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-neutral-500">
      <span class="text-neutral-300" title={usage.model}>⚡️ sonnet 4.5</span>
      <span>in {formatTokens(usage.inputTokens)}</span>
      <span title="cache write">↑{formatTokens(usage.cacheCreationTokens)}</span>
      <span title="cache read">↓{formatTokens(usage.cacheReadTokens)}</span>
      <span>out {formatTokens(usage.outputTokens)}</span>
      <span class="text-neutral-300">{formatUsd(usage.costUsd)}</span>
      <span title="context window used">{formatTokens(usage.contextTokens)} ctx</span>
      <span>turns {usage.turns}</span>
    </p>
    <textarea
      class="max-h-48 min-h-16 w-full resize-none overflow-y-auto border border-neutral-700 bg-neutral-900 px-2 py-1.5 [field-sizing:content]"
      placeholder="say something (the spike has no transport, so it goes nowhere)"
    ></textarea>
    <div class="mt-1">
      <button class="cursor-pointer rounded border border-neutral-700 px-1.5 text-neutral-400 hover:text-neutral-200"
        >attach</button
      >
    </div>
  </div>
</section>
