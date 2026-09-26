import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// Built into ../public/app and served by the website Worker at /app.
export default defineConfig({
  root: __dirname,
  base: "/app/",
  plugins: [react(), nodePolyfills({ include: ["buffer", "process"], globals: { Buffer: true, process: true } })],
  build: { outDir: "../public/app", emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 4000 },
});
