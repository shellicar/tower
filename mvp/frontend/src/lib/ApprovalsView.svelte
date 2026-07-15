<script lang="ts">
  import { approvals, rail, view } from './app';
  import { age } from './core/time';
  import type { ApprovalState } from './types';

  // The one-click answer surface: pending asks oldest-first, the
  // decision-relevant payload on the line, the conversation as context.
  // Void is the store's derivation (~3 missed pulses = the holder died):
  // a void ask keeps approve/deny off the line — answering a corpse only
  // yields `unreachable` — and offers dismiss instead, a local drop, not
  // an answer (nobody settles an abandoned ask).
  const isVoid = (a: ApprovalState) => approvals.isVoid(a);

  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 1_000);
    return () => clearInterval(t);
  });


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
    return rail.row(conv)?.title ?? conv;
  }
</script>

<section class="flex h-full min-w-[480px] flex-1 flex-col border-r border-neutral-700">
  <header class="flex items-center justify-between border-b border-neutral-700 px-3 py-2">
    <span class="text-amber-300">
      approvals · {approvals.liveApprovals.length} pending{#if approvals.pendingApprovals.length > approvals.liveApprovals.length}
        · {approvals.pendingApprovals.length - approvals.liveApprovals.length} void{/if}
    </span>
    <button
      class="cursor-pointer text-base text-neutral-400 hover:text-neutral-200"
      onclick={() => (view.approvalsOpen = false)}>×</button
    >
  </header>

  <div class="flex-1 overflow-y-auto">
    {#each approvals.pendingApprovals as a (a.id)}
      <article
        class="border-b border-neutral-800 px-3 py-2 {isVoid(a) ? 'opacity-40' : ''}"
      >
        <div class="flex items-baseline justify-between gap-2">
          <span class="truncate">
            <span class="text-neutral-200">⚒ {a.ask.name ?? a.ask.type}</span>
            <span class="text-neutral-400"> {payload(a)}</span>
          </span>
          <span class="shrink-0 text-neutral-500">{age(now, a.raisedTs)}</span>
        </div>
        <div class="mt-1 flex items-center justify-between gap-2">
          {#if a.correlation?.conversationId}
            <button
              class="cursor-pointer truncate text-sky-300 hover:underline"
              onclick={() => view.openConversation(a.correlation!.conversationId!)}
            >
              {convLabel(a)}
            </button>
          {:else}
            <span class="text-neutral-500">no conversation</span>
          {/if}
          <span class="flex shrink-0 gap-2">
            {#if approvals.answerNote(a.id)}
              <span class="text-orange-300">{approvals.answerNote(a.id)}</span>
            {/if}
            {#if isVoid(a)}
              <span class="text-neutral-500">void — holder silent</span>
              <button
                class="cursor-pointer border border-neutral-700 px-2 text-neutral-400 hover:bg-neutral-800"
                onclick={() => approvals.dismiss(a.id)}>dismiss</button
              >
            {:else}
              <button
                class="cursor-pointer border border-green-800 px-2 text-green-300 hover:bg-green-950"
                onclick={() => approvals.answer(a.id, true)}>approve</button
              >
              <button
                class="cursor-pointer border border-red-900 px-2 text-red-300 hover:bg-red-950"
                onclick={() => approvals.answer(a.id, false)}>deny</button
              >
            {/if}
          </span>
        </div>
      </article>
    {:else}
      <p class="p-3 text-neutral-500">Nothing waiting on you.</p>
    {/each}
  </div>
</section>
