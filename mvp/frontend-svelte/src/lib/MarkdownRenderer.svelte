<script lang="ts">
  import { renderMarkdown } from './core/markdown';

  let { text }: { text: string } = $props();

  const html = $derived(renderMarkdown(text));
</script>

<div class="markdown-content wrap-anywhere">{@html html}</div>
