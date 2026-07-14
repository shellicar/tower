import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Dev: vite serves the SPA; /ws and /ref proxy to a running towerd — the
// same TOWER_BIND towerd itself reads (dev.sh sets both), so the pair moves
// together. Prod: `vite build` → dist/, served by towerd itself.
const towerd = process.env.TOWER_BIND ?? '127.0.0.1:8080';
const port = Number(process.env.WEB_PORT ?? 5173);

export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  server: {
    port,
    proxy: {
      '/ws': { target: `ws://${towerd}`, ws: true },
      '/ref': { target: `http://${towerd}` },
    },
  },
});
