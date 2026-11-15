import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import process from "node:process";
import { noeticPlugin } from "./vite-noetic-plugin.ts";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss(), noeticPlugin()],

  build: {
    rolldownOptions: {
      output: {
        // The layouts and dialogs are separate chunks (see App.tsx). Without this, every icon two
        // of them share becomes a file of its own: a few hundred bytes each, and a request each.
        codeSplitting: {
          groups: [{ name: "icons", test: /node_modules[\\/]lucide-react/ }],
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**", "**/.git/**"],
    },
  },
}));
