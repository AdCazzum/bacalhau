import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

// @ts-expect-error - plain JS, deliberately unbundled so the Cloudflare worker
// and this dev middleware run the identical file (see the module docstring).
import { handleAgent } from "./public/_worker.js/agent.js";

/**
 * Dev-side half of the copilot route. In production this lives in the
 * Cloudflare worker; locally Vite has no server logic, so the same handler is
 * mounted as middleware. Both call `handleAgent`, so there is one loop.
 */
function agentRoute(env: Record<string, string>): Plugin {
  return {
    name: "qilinswap-agent",
    configureServer(server) {
      server.middlewares.use("/agent", (req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", async () => {
          const request = new Request("http://local/agent", {
            method: req.method,
            headers: { "Content-Type": "application/json" },
            body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
          });
          const out: Response = await handleAgent(request, env);
          res.statusCode = out.status;
          res.setHeader("Content-Type", "application/json");
          res.end(await out.text());
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Empty prefix: read UNISWAP_API_KEY, which is deliberately *not* VITE_*
  // so it never gets inlined into the client bundle.
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [react(), agentRoute(env)],
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
