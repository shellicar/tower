<script lang="ts">
  import MessageView from './MessageView.svelte';
  import { approvals, conversations, rail, usage, view } from './app';
  import { age } from './core/time';
  import { formatTokens, formatUsd, priceUsage } from './core/pricing';
  import { uploadAttachment } from './core/uploads';
  import type { ConversationState } from './concerns/conversation.svelte';
  import type { AttachmentRef } from './types';

  let { oc }: { oc: ConversationState } = $props();

  // Attachments ride as chips beside the editor: uploaded eagerly (the
  // transit store's TTL cleans up abandons), included in the next say,
  // cleared with it. State is only ever ASSIGNED, never mutated across an
  // await - the whole batch settles, then one write each.
  let attachments = $state<AttachmentRef[]>([]);
  let uploading = $state(false);
  let uploadNote = $state('');
  let fileInput: HTMLInputElement | undefined = $state();

  async function addFiles(list: Iterable<File>) {
    const files = [...list];
    if (files.length === 0) return;
    uploading = true;
    const settled = await Promise.allSettled(files.map((f) => uploadAttachment(f)));
    const won: AttachmentRef[] = [];
    const lost: string[] = [];
    for (const r of settled) {
      if (r.status === 'fulfilled') won.push(r.value);
      else lost.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
    }
    attachments = [...attachments, ...won];
    uploadNote = lost.length > 0 ? `upload failed: ${lost.join('; ')}` : '';
    uploading = false;
  }

  function removeAttachment(i: number) {
    attachments = attachments.filter((_, j) => j !== i);
  }

  // Paste-to-attach: a screenshot in the clipboard is the usual workflow.
  // Only file-bearing pastes are intercepted; text pastes stay the
  // textarea's own.
  function onpaste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.items ?? [])]
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  }

  function sizeLabel(n?: number): string {
    if (!n) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  // The draft survives a refresh: half-typed thoughts are the reader's own
  // in-flight state — exactly what the client's local storage is for.
  // Keyed per conversation; cleared on send; empty drafts leave no residue.
  // The initial capture is intended: panels are keyed by conv in App, so
  // this component's conversation identity never changes.
  // svelte-ignore state_referenced_locally
  const draftKey = `tower.draft.${oc.conv}`;
  let draft = $state(localStorage.getItem(draftKey) ?? '');
  // Debounced with a max-wait: a synchronous localStorage write per
  // keystroke is main-thread I/O the typing loop doesn't need. The trailing
  // write lands 300ms after the last keystroke, and continuous typing still
  // persists every ~2s — at most ~2s of draft is ever at risk. A timer that
  // outlives the panel simply fires anyway, which IS the unmount flush.
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  let lastPersist = Date.now();
  $effect(() => {
    const value = draft;
    clearTimeout(draftTimer);
    const write = () => {
      lastPersist = Date.now();
      try {
        if (value === '') localStorage.removeItem(draftKey);
        else localStorage.setItem(draftKey, value);
      } catch {
        // Storage full or blocked: persistence degrades, typing does not.
      }
    };
    if (Date.now() - lastPersist >= 2_000) write();
    else draftTimer = setTimeout(write, 300);
  });

  let scroller: HTMLDivElement | undefined = $state();
  let editor: HTMLTextAreaElement | undefined = $state();

  // The anchor is user intent, never a measurement: it changes on exactly
  // two gestures — scrolling away (unanchor) and returning to the bottom by
  // scroll or button (anchor). Content height, editor growth, and sends
  // never touch it. A panel opens anchored.
  let anchored = $state(true);
  // Set while *we* move the scroll, so the scroll event it fires isn't
  // mistaken for the reader scrolling away.
  let pinning = false;

  function pin() {
    if (!scroller) return;
    pinning = true;
    // Never read scrollHeight to compute this: that read forces a synchronous
    // layout, and live profiling (21 Jul) showed Layout as the dominant cost
    // with several panels streaming at once. A constant far past any real
    // height needs no read — the browser clamps scrollTop to the actual max.
    scroller.scrollTop = 1_000_000_000;
    requestAnimationFrame(() => (pinning = false));
  }

  function onscroll() {
    if (pinning || !scroller) return;
    // A genuine gesture: at the bottom (small tolerance for fractional
    // pixels) means anchored; anywhere above means the reader left.
    anchored = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 2;
  }

  // The editor grows to fit content via CSS (field-sizing: content on the
  // textarea), clamped by min/max-height, no JS measurement — a keystroke
  // never forces a synchronous height=auto/scrollHeight/height=result dance
  // (live profiling 21 Jul found this the actual cost of typing lag, same as
  // the Leptos side same night). Growth still steals viewport, so re-pin
  // while anchored on any input.
  function oninput() {
    if (anchored) pin();
  }

  // A revoked say comes back whole — words to the editor (prepended so a
  // newer half-typed thought survives), files back to the chips. The cancel
  // took back the say; nothing is lost.
  $effect(() => {
    if (oc.restoreSay !== null || oc.restoreAttachments.length > 0) {
      if (oc.restoreSay !== null) {
        draft = draft ? `${oc.restoreSay}\n${draft}` : oc.restoreSay;
      }
      if (oc.restoreAttachments.length > 0) {
        attachments = [...oc.restoreAttachments, ...attachments];
      }
      conversations.consumeRestore(oc.conv);
    }
  });

  // There is no "busy": a say is always accepted and queued, the same
  // semantics as typing while Claude is still running locally
  // (conversation-spec design: acceptance creates state, processed when
  // the conversation gets to it). The input is never locked on query
  // liveness — uploading is the only thing that legitimately blocks a send.

  // While anchored, re-pin on any geometry change — catch-up, new message,
  // streaming chunk. While unanchored, never move.
  $effect(() => {
    void oc.messages.length;
    void oc.streaming.length;
    void oc.streaming[oc.streaming.length - 1]?.text;
    void oc.loaded;
    if (anchored) pin();
  });

  // The one source of truth for send-eligibility, read by both the submit
  // guard and the textarea/button disabled state - never re-derived twice.
  // Priority: uploading always blocks; OUR OWN live query always blocks (a
  // say against it is a guaranteed `stale`, decisions.rs scenario 5 - this
  // is why the original busy gate existed, and removing it was wrong);
  // real content (text or an attachment) is always sendable; empty is
  // sendable only to resume a conversation that already ends on an
  // unanswered user-role message (a tool_result is one) - ported verbatim
  // from claude-sdk-cli's EditorHandler#submit.
  const canSend = $derived.by(() => {
    if (uploading || oc.liveQuery !== null) return false;
    if (draft.trim() || attachments.length > 0) return true;
    return oc.messages.at(-1)?.role === 'user';
  });

  function submit() {
    if (!canSend) return;
    const text = draft.trim();
    conversations.say(oc.conv, text, attachments);
    attachments = [];
    uploadNote = '';
    draft = '';
    // Deliberately no re-anchor: a reader scrolled up for a reason stays
    // exactly where they are. field-sizing: content shrinks the box back on
    // its own once the bind clears — no JS measurement needed.
  }

  // Enter is a newline; Cmd+Enter (mac) / Ctrl+Enter submits.
  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  }

  // The conversation's latest wire event — the same staleness fact the list
  // shows, put where the reader is looking. `lastKind` is display fodder
  // (an open set): shown verbatim, never branched on.
  const row = $derived(rail.row(oc.conv));

  // The conversation's cost surface: towerd ships the token facts, priced
  // here ($ and context %) — the client owns that policy. Absent until the
  // first turn commits usage; absent means zero, so the line simply hides.
  const usageSnapshot = $derived(usage.get(oc.conv));
  const priced = $derived(usageSnapshot ? priceUsage(usageSnapshot) : undefined);

  // Pending asks belonging to this conversation — the in-context answer
  // surface for the cases where the list line alone isn't enough.
  // Live asks only: a void ask is not actionable here (answering a corpse
  // yields unreachable); it waits in the approvals view for dismissal.
  const pendingHere = $derived(approvals.liveForConv(oc.conv));

  // The header is the title's editor: click the name, type, Enter or blur
  // lands it (empty clears — back to the id). Escape abandons.
  let editingTitle = $state(false);
  let titleDraft = $state('');

  function startTitleEdit() {
    titleDraft = row?.title ?? '';
    editingTitle = true;
  }

  function commitTitle() {
    if (!editingTitle) return;
    editingTitle = false;
    const title = titleDraft.trim();
    if (title !== (row?.title ?? '')) rail.setTitle(oc.conv, title);
  }

  function titleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitTitle();
    } else if (e.key === 'Escape') {
      editingTitle = false; // abandon: nothing sent
    }
  }

  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 1_000);
    return () => clearInterval(t);
  });

</script>

<section class="flex h-full min-w-[480px] flex-1 flex-col border-r border-neutral-700">
  <header class="flex items-center justify-between gap-2 border-b border-neutral-700 px-3 py-2">
    {#if editingTitle}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="min-w-0 flex-1 border border-neutral-600 bg-neutral-900 px-1 text-sky-300"
        bind:value={titleDraft}
        onblur={commitTitle}
        onkeydown={titleKeydown}
        placeholder={oc.conv}
        autofocus
      />
    {:else}
      <button
        class="min-w-0 cursor-text truncate text-left text-sky-300"
        title={oc.conv}
        onclick={startTitleEdit}
      >
        {row?.title ?? oc.conv}
      </button>
    {/if}
    <button
      class="cursor-pointer text-base text-neutral-400 hover:text-neutral-200"
      onclick={() => view.closeConversation(oc.conv)}>×</button
    >
  </header>

  <div class="relative min-h-0 flex-1">
    <div class="h-full overflow-y-auto px-3 py-2" bind:this={scroller} {onscroll}>
      {#if !oc.loaded}
        <p class="text-neutral-500">loading…</p>
      {/if}
      {#each oc.messages as message (message.id)}
        <MessageView {message} />
      {/each}
      {#if oc.pendingSay}
        <!-- The say in flight: accepted, not yet committed — the record
             doesn't hold it, so it renders greyed, not as a message. -->
        <div class="my-2 border-l-2 border-neutral-700 pl-2 opacity-50">
          <div class="whitespace-pre-wrap text-neutral-300">{oc.pendingSay}</div>
        </div>
      {/if}
      {#if oc.streaming.length > 0}
        <div class="my-2 border-l-2 border-indigo-800 pl-2">
          {#each oc.streaming as segment, i (i)}
            {#if segment.text}
              {#if segment.blockType === 'thinking'}
                <div class="whitespace-pre-wrap text-neutral-500 italic">{segment.text}</div>
              {:else if segment.blockType === 'tool_use'}
                <div class="wrap-anywhere whitespace-pre-wrap text-neutral-500">⚒ {segment.text}</div>
              {:else}
                <div class="whitespace-pre-wrap text-indigo-200">{segment.text}</div>
              {/if}
            {/if}
          {/each}
        </div>
      {/if}
    </div>
    {#if !anchored}
      <button
        class="absolute bottom-2 left-1/2 -translate-x-1/2 cursor-pointer rounded border border-neutral-600 bg-neutral-900/90 px-3 py-1 text-neutral-300 hover:text-neutral-100"
        onclick={() => {
          anchored = true;
          pin();
        }}
      >
        ↓ latest
      </button>
    {/if}
  </div>

  <div class="border-t border-neutral-700 px-3 py-2">
    {#each pendingHere as a (a.id)}
      <div class="mb-1.5 flex items-center justify-between gap-2 border border-amber-900 bg-amber-950/30 px-2 py-1">
        <span class="truncate text-amber-200">
          ⚠ {a.ask.name ?? a.ask.type}
          {#if approvals.answerNote(a.id)}
            <span class="text-orange-300"> · {approvals.answerNote(a.id)}</span>
          {/if}
        </span>
        <span class="flex shrink-0 gap-2">
          <button
            class="cursor-pointer border border-green-800 px-2 text-green-300 hover:bg-green-950"
            onclick={() => approvals.answer(a.id, true)}>approve</button
          >
          <button
            class="cursor-pointer border border-red-900 px-2 text-red-300 hover:bg-red-950"
            onclick={() => approvals.answer(a.id, false)}>deny</button
          >
        </span>
      </div>
    {/each}
    <p class="mb-1.5 flex items-center gap-2 text-neutral-500">
      {#if row}<span>{row.lastKind} · {age(now, row.lastEvent)} ago</span>{/if}
      {#if oc.queryState === 'unknown'}
        <span class="rounded border border-neutral-700 px-1.5 text-neutral-500" title="no evidence yet whether a query is running">state unknown</span>
      {:else if oc.queryState === 'live'}
        <span class="rounded border border-indigo-800 px-1.5 text-indigo-300">query running</span>
        {#if oc.liveQuery}
          <button
            class="cursor-pointer rounded border border-red-900 px-1.5 text-red-300 hover:bg-red-950"
            onclick={() => conversations.cancel(oc.conv)}>cancel</button
          >
        {/if}
      {/if}
    </p>
    {#if usageSnapshot && priced}
      <p
        class="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-neutral-500"
        title={usageSnapshot.model}
      >
        <span>in {formatTokens(usageSnapshot.inputTokens)}</span>
        <span title="cache write">↑{formatTokens(usageSnapshot.cacheCreationTokens)}</span>
        <span title="cache read">↓{formatTokens(usageSnapshot.cacheReadTokens)}</span>
        <span>out {formatTokens(usageSnapshot.outputTokens)}</span>
        <span class="text-neutral-300">{formatUsd(priced.costUsd)}</span>
        <span title="context window used">
          ctx {formatTokens(priced.contextUsed)}/{formatTokens(priced.contextMax)} ({priced.contextPct.toFixed(1)}%)
        </span>
        <span>turns {usageSnapshot.turns}</span>
      </p>
    {/if}
    {#if oc.lastSay}
      <p class="mb-1.5 text-orange-300">{oc.lastSay}</p>
    {/if}
    {#if uploadNote}
      <p class="mb-1.5 text-orange-300">{uploadNote}</p>
    {/if}
    {#if attachments.length > 0 || uploading}
      <p class="mb-1.5 flex flex-wrap items-center gap-1.5">
        {#each attachments as a, i}
          <span
            class="flex items-center gap-1 rounded border border-neutral-700 px-1.5 text-neutral-300"
          >
            📎 {a.source.mediaType ?? a.type} · {sizeLabel(a.source.size)}
            <button
              class="cursor-pointer text-neutral-500 hover:text-neutral-200"
              onclick={() => removeAttachment(i)}>×</button
            >
          </span>
        {/each}
        {#if uploading}
          <span class="text-neutral-500">uploading…</span>
        {/if}
      </p>
    {/if}
    <textarea
      class="max-h-48 min-h-16 w-full resize-none border border-neutral-700 bg-neutral-900 px-2 py-1.5 [field-sizing:content] overflow-y-auto disabled:opacity-50"
      bind:value={draft}
      bind:this={editor}
      {oninput}
      {onkeydown}
      {onpaste}
      disabled={oc.liveQuery !== null}
      placeholder={oc.liveQuery !== null ? 'query running… (cancel to speak)' : 'say… (⌘↩ to send)'}
    ></textarea>
    <div class="mt-1">
      <button
        class="cursor-pointer rounded border border-neutral-700 px-1.5 text-neutral-400 hover:text-neutral-200"
        title="attach a file (or paste an image)"
        onclick={() => fileInput?.click()}>📎 attach</button
      >
      <input
        class="hidden"
        type="file"
        multiple
        bind:this={fileInput}
        onchange={(e) => {
          const files = (e.currentTarget as HTMLInputElement).files;
          if (files) addFiles(files);
          (e.currentTarget as HTMLInputElement).value = '';
        }}
      />
    </div>
  </div>
</section>
