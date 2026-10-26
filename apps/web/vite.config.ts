import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// One dev server for the SPA and the Worker (API, auth, sync, MCP) running in workerd.
export default defineConfig({
  plugins: [react(), cloudflare({ configPath: "../server/wrangler.jsonc", persistState: { path: "../../.wrangler/state" } })],
  server: { port: 5173, strictPort: true },
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      output: { manualChunks: undefined },
      // @workspace/core is a barrel whose modules only declare exports; without this, its yjs/zod/marked
      // imports (needed only by the lazy editor and database chunks) end up in the initial shell.
      treeshake: { moduleSideEffects: [{ test: /packages[\\/]core[\\/]src[\\/]/, sideEffects: false }] },
    },
  },
});
