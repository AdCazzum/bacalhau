import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Empty prefix: read UNISWAP_API_KEY, which is deliberately *not* VITE_*
  // so it never gets inlined into the client bundle.
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [react()],
    server: {
      proxy: {
        // The Uniswap Trading API has no CORS for browser origins, so the
        // request is proxied and the key attached here. This mirrors what
        // public/_worker.js does in production — keep the two in sync.
        "/uniswap": {
          target: "https://trade-api.gateway.uniswap.org",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/uniswap/, ""),
          headers: env.UNISWAP_API_KEY
            ? { "x-api-key": env.UNISWAP_API_KEY }
            : undefined,
        },
      },
    },
  };
});
