<script lang="ts">
  import { tower } from './tower.svelte';
  import type { ApprovalState } from './types';

  // The one-click answer surface: pending asks oldest-first, the
  // decision-relevant payload on the line, the conversation as context.
  // Void is this client's derivation: the pulse is ~15s while pending, so
  // ~3 missed pulses reads as "the holder died" — greyed, never dropped.
  const VOID_AFTER_MS = 45_000;

  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 1_000);
    return () => clearInterval(t);
  });

  function isVoid(a: ApprovalState): boolean {
    return now - a.lastPulse > VOID_AFTER_MS;
  }

  function age(ts: number): string {
    const s = Math.max(0, Math.floor((now - ts) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h`;
  }

  /** The decision-relevant payload: file paths render as themselves (the
   *  90% case — DeleteFile/DeleteDirectory take a top-level `files` array;
   *  the typed-content shape carries `content.type: "files"`); anything
   *  else truncates. */
  function payload(a: ApprovalState): string {
    const input = a.ask.input as
      | { files?: unknown[]; content?: { type?: string; values?: unknown[] } }
      | undefined;
    if (Array.isArray(input?.files) && input.files.every((f) => typeof f === 'string')) {
      return input.files.join(', ');
    }
    const content = input?.content;
    if (content?.type === 'files' && Array.isArray(content.values)) {
      return content.values.join(', ');
    }
    const s = a.ask.input === undefined ? '' : JSON.stringify(a.ask.input);
    return s.length > 120 ? s.slice(0, 120) + '…' : s;
  }

  function convLabel(a: ApprovalState): string | null {
    const conv = a.correlation?.conversationId;
    if (!conv) return null;
    return tower.rows.get(conv)?.title ?? conv;
  }
</script>

<section class="flex h-full min-w-[480px] flex-1 flex-col border-r border-neutral-700">
  <header class="flex items-center justify-between border-b border-neutral-700 px-3 py-2">
    <span class="text-amber-300">approvals · {tower.pendingApprovals.length} pending</span>
    <button
      class="cursor-pointer text-base text-neutral-400 hover:text-neutral-200"
      onclick={() => (tower.approvalsOpen = false)}>×</button
    >
  </header>

  <div class="flex-1 overflow-y-auto">
    {#each tower.pendingApprovals as a (a.id)}
      <article
        class="border-b border-neutral-800 px-3 py-2 {isVoid(a) ? 'opacity-40' : ''}"
      >
        <div class="flex items-baseline justify-between gap-2">
          <span class="truncate">
            <span class="text-neutral-200">⚒ {a.ask.name ?? a.ask.type}</span>
            <span class="text-neutral-400"> {payload(a)}</span>
          </span>
          <span class="shrink-0 text-neutral-500">{age(a.raisedTs)}</span>
        </div>
        <div class="mt-1 flex items-center justify-between gap-2">
          {#if a.correlation?.conversationId}
            <button
              class="cursor-pointer truncate text-sky-300 hover:underline"
              onclick={() => tower.openConversation(a.correlation!.conversationId!)}
            >
              {convLabel(a)}
            </button>
          {:else}
            <span class="text-neutral-500">no conversation</span>
          {/if}
          <span class="flex shrink-0 gap-2">
            {#if isVoid(a)}
              <span class="text-neutral-500">void — holder silent</span>
            {/if}
            {#if tower.answerNotes.get(a.id)}
              <span class="text-orange-300">{tower.answerNotes.get(a.id)}</span>
            {/if}
            <button
              class="cursor-pointer border border-green-800 px-2 text-green-300 hover:bg-green-950"
              onclick={() => tower.answer(a.id, true)}>approve</button
            >
            <button
              class="cursor-pointer border border-red-900 px-2 text-red-300 hover:bg-red-950"
              onclick={() => tower.answer(a.id, false)}>deny</button
            >
          </span>
        </div>
      </article>
    {:else}
      <p class="p-3 text-neutral-500">Nothing waiting on you.</p>
    {/each}
  </div>
</section>
