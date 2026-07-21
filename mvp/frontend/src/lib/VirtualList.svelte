<script lang="ts" generics="T extends { id: string }">
  // Minimal hand-rolled virtual list (spike 1: does windowing actually cut
  // Rendering/Layout cost — CLAUDE.md "Known follow-up"). Only rows within
  // `overscan` px of the viewport mount; a spacer above and below stands in
  // for the rest, sized from a per-id height cache. No pretext/canvas
  // measurement (spike 2) and no library (spike 3) — real DOM rows, measured
  // once mounted, cached by id.
  import type { Snippet } from 'svelte';

  let {
    items,
    row,
    header,
    footer,
    estimate = 96,
    overscan = 600,
    scroller = $bindable(),
    pinning = false,
    onscroll,
    class: className = '',
  }: {
    items: T[];
    row: Snippet<[T]>;
    header?: Snippet;
    footer?: Snippet;
    /** Fallback height (px) for a row never yet measured — spike 2 refines
     *  this; here it only has to be in the right ballpark so the scrollbar
     *  doesn't jump wildly before rows settle. */
    estimate?: number;
    /** Extra px rendered beyond the visible viewport on each side, so a
     *  small scroll or resize doesn't pop rows in at the edge. */
    overscan?: number;
    scroller?: HTMLDivElement;
    /** True while the caller is programmatically pinning scrollTop to the
     *  bottom (e.g. ConversationPanel.pin()) — the resulting scroll event
     *  carries no new information (the caller already knows where it put
     *  it), so reading scroller.scrollTop back would be a forced layout for
     *  a value already known. */
    pinning?: boolean;
    onscroll?: () => void;
    class?: string;
  } = $props();

  // Keyed by item id, not index: an id's measured height survives reordering
  // and insertion (insertMessage splices ts-ordered) without invalidating
  // every other row's cache entry.
  const heights = new Map<string, number>();

  let scrollTop = $state(0);
  let viewportHeight = $state(0);

  function handleScroll() {
    if (!scroller) return;
    // While pinning, the caller just set scrollTop itself — derive the same
    // clamped value the browser will land on from what's already known
    // (totalHeight/viewportHeight) instead of reading it back.
    scrollTop = pinning ? Math.max(0, totalHeight - viewportHeight) : scroller.scrollTop;
    onscroll?.();
  }

  $effect(() => {
    if (!scroller) return;
    const el = scroller;
    viewportHeight = el.clientHeight;
    const ro = new ResizeObserver(() => (viewportHeight = el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  });

  // Bumped whenever a row's real height lands, so the offsets pass below
  // re-derives. Keeping it a plain counter (not the Map itself) avoids
  // teaching Svelte to track Map mutations.
  let version = $state(0);

  // Prefix offsets over the current item list. O(n) per recompute — items.length
  // is at most a few thousand (CLAUDE.md: max observed ~2,300 messages), so a
  // full pass is microseconds; no need for a fancier incremental structure here.
  const offsets = $derived.by(() => {
    void version;
    let y = 0;
    const next: number[] = new Array(items.length);
    for (let i = 0; i < items.length; i++) {
      next[i] = y;
      y += heights.get(items[i].id) ?? estimate;
    }
    return next;
  });

  const totalHeight = $derived.by(() => {
    if (items.length === 0) return 0;
    return offsets[items.length - 1] + (heights.get(items[items.length - 1].id) ?? estimate);
  });

  /** First index whose offset is <= target — offsets is ascending. */
  function findStart(target: number): number {
    let lo = 0;
    let hi = offsets.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid] <= target) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, lo - 1);
  }

  const range = $derived.by(() => {
    if (items.length === 0) return { start: 0, end: 0 };
    const top = Math.max(0, scrollTop - overscan);
    const bottom = scrollTop + viewportHeight + overscan;
    const start = findStart(top);
    let end = start;
    while (end < items.length && offsets[end] < bottom) end++;
    return { start, end: Math.min(items.length, end) };
  });

  const before = $derived(offsets[range.start] ?? 0);
  const after = $derived(totalHeight - (range.end > 0 ? offsets[range.end - 1] + (heights.get(items[range.end - 1]?.id ?? '') ?? estimate) : 0));
  const visible = $derived(items.slice(range.start, range.end));

  function setHeight(id: string, h: number) {
    if (h > 0 && heights.get(id) !== h) {
      heights.set(id, h);
      version++;
    }
  }

  /** Measures once mounted (the only forced-layout read — there's no cached
   *  height yet to hand it), then tracks resize (content reflow, font load,
   *  image decode) via the size ResizeObserver already computed off the
   *  render path — never re-reading getBoundingClientRect, which would force
   *  a layout on every entry instead of using the one the browser already did. */
  function measureAction(node: HTMLElement, id: string) {
    setHeight(id, node.getBoundingClientRect().height);
    const ro = new ResizeObserver((entries) => {
      setHeight(id, entries[0].borderBoxSize?.[0]?.blockSize ?? entries[0].contentRect.height);
    });
    ro.observe(node);
    return {
      destroy() {
        ro.disconnect();
      },
    };
  }
</script>

<div bind:this={scroller} class={className} onscroll={handleScroll}>
  {#if header}{@render header()}{/if}
  <div style="height: {before}px"></div>
  {#each visible as item (item.id)}
    <div use:measureAction={item.id}>
      {@render row(item)}
    </div>
  {/each}
  <div style="height: {after}px"></div>
  {#if footer}{@render footer()}{/if}
</div>
