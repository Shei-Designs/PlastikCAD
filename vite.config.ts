import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import process from "node:process";
import { dracoModule } from "./tools/dracoModule.ts";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), dracoModule()],
  // A build made for the browser tests (`--mode e2e`) carries the hook they reach the app through; no other does.
  define: { "import.meta.env.VITE_E2E": JSON.stringify(mode === "e2e") },
  // That build also keeps the names of functions through minification: one test counts React's redraws by component name.
  build: mode === "e2e" ? { rolldownOptions: { output: { keepNames: true } } } : undefined,
  // The geometry worker is built apart from the page, with plugins of its own: it is where the Draco decoder is read.
  worker: { format: "es" as const, plugins: () => [dracoModule()] },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1431,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    // Vite turns browser-console forwarding on by itself when it sees an AI agent in the
    // environment, and that plugin is part of the dependency-cache hash: a dev server
    // started by an agent and one started from a terminal would otherwise keep
    // invalidating each other's cache. Pin it so every launch shares one cache.
    forwardConsole: false,
  },
  optimizeDeps: {
    // The geometry and simulation workers are the only importers, so Vite would otherwise find
    // these dependencies after the first page load, re-optimise and reload the page mid-start.
    include: ["manifold-3d", "@mujoco/mujoco", "replicad-opencascadejs"],
  },
}));
