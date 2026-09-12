<script lang="ts">
  import { fixture } from './fixture';
  import Panels from './lib/Panels.svelte';
  import Rail from './lib/Rail.svelte';
  import SpaceStrip from './lib/SpaceStrip.svelte';
  import { live } from './lib/reactive.svelte';
  import { Layout } from './model/layout';

  const rows = new Map(fixture.conversations.map((r) => [r.conv, r]));
  const register = fixture.conversations.map((r) => r.conv);
  const now = fixture.conversations.reduce((latest, r) => Math.max(latest, r.lastEvent), 0);
  const rowOf = (conv: string) => rows.get(conv);

  const model = live(new Layout(fixture.layout));
</script>

<div class="app">
  <Rail live={model} {register} {rowOf} tagKeys={fixture.tagKeys} {now} />
  <div class="stage">
    <SpaceStrip live={model} />
    <Panels live={model} {rowOf} tagKeys={fixture.tagKeys} {now} />
  </div>
</div>
