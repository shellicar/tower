import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Dev: vite serves the SPA; /ws and /ref proxy to a running towerd.
// Prod: `vite build` → dist/, served by towerd itself.
export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  server: {
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8080', ws: true },
      '/ref': { target: 'http://127.0.0.1:8080' },
    },
  },
});
