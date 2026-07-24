import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // The Uniswap Trading API has no CORS for browser origins; the dev
      // server forwards the call (PoC posture, docs/08 - no real backend).
      "/uniswap": {
        target: "https://trade-api.gateway.uniswap.org",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/uniswap/, ""),
      },
    },
  },
});
