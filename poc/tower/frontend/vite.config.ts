import { defineConfig } from "vite";

// The frontend opens its socket at ws://<same-origin>/ws. In dev, vite serves the
// page, so /ws must be proxied to the backend — otherwise the socket has nothing
// to reach and the page sits on "connecting…" forever.
export default defineConfig({
  server: {
    proxy: {
      "/ws": { target: "ws://localhost:8091", ws: true },
    },
  },
});
