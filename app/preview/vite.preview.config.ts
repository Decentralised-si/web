import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { resolve } from "node:path";
export default defineConfig({
  root: resolve(__dirname, ".."),
  plugins: [react(), nodePolyfills({ include: ["buffer", "process"], globals: { Buffer: true, process: true } })],
  resolve: { alias: [{ find: /^@privy-io\/react-auth(\/solana)?$/, replacement: resolve(__dirname, "privy-mock.tsx") }] },
  server: { port: 5199, strictPort: true },
});
