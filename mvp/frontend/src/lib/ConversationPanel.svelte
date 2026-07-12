<script lang="ts">
  import MessageView from './MessageView.svelte';
  import { tower, type OpenConversation } from './tower.svelte';

  let { oc }: { oc: OpenConversation } = $props();

  let draft = $state('');
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
    scroller.scrollTop = scroller.scrollHeight;
    requestAnimationFrame(() => (pinning = false));
  }

  function onscroll() {
    if (pinning || !scroller) return;
    // A genuine gesture: at the bottom (small tolerance for fractional
    // pixels) means anchored; anywhere above means the reader left.
    anchored = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 2;
  }

  // Auto-grow the editor to its content (the max-h class caps it; beyond
  // that it scrolls) so the line being typed is never below the fold.
  function autosize() {
    if (!editor) return;
    editor.style.height = 'auto';
    editor.style.height = `${editor.scrollHeight}px`;
    if (anchored) pin(); // editor growth steals viewport; keep the pin
  }

  // While anchored, re-pin on any geometry change — catch-up, new message,
  // streaming chunk. While unanchored, never move.
  $effect(() => {
    void oc.messages.length;
    void oc.streaming;
    void oc.loaded;
    if (anchored) pin();
  });

  function submit() {
    const text = draft.trim();
    if (!text) return;
    tower.say(oc.conv, text);
    draft = '';
    // Deliberately no re-anchor: a reader scrolled up for a reason stays
    // exactly where they are.
    requestAnimationFrame(autosize); // shrink back after the bind clears
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
  const row = $derived(tower.rows.get(oc.conv));

  // Pending asks belonging to this conversation — the in-context answer
  // surface for the cases where the list line alone isn't enough.
  const pendingHere = $derived(
    tower.pendingApprovals.filter((a) => a.correlation?.conversationId === oc.conv),
  );

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
    if (title !== (row?.title ?? '')) tower.setTitle(oc.conv, title);
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

  function age(ts: number): string {
    const s = Math.max(0, Math.floor((now - ts) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  }
</script>

<section class="flex h-screen min-w-[480px] flex-1 flex-col border-r border-neutral-700">
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
      onclick={() => tower.closeConversation(oc.conv)}>×</button
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
      {#if oc.streaming}
        <div class="my-2 whitespace-pre-wrap border-l-2 border-indigo-800 pl-2 text-indigo-200">
          {oc.streaming}
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
          {#if tower.answerNotes.get(a.id)}
            <span class="text-orange-300"> · {tower.answerNotes.get(a.id)}</span>
          {/if}
        </span>
        <span class="flex shrink-0 gap-2">
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
    {/each}
    {#if row}
      <p class="mb-1.5 text-neutral-500">{row.lastKind} · {age(row.lastEvent)} ago</p>
    {/if}
    {#if oc.lastSay}
      <p class="mb-1.5 text-orange-300">{oc.lastSay}</p>
    {/if}
    <textarea
      class="max-h-48 min-h-16 w-full resize-none border border-neutral-700 bg-neutral-900 px-2 py-1.5"
      bind:value={draft}
      bind:this={editor}
      oninput={autosize}
      {onkeydown}
      placeholder="say… (⌘↩ to send)"
    ></textarea>
  </div>
</section>
