/**
 * Cloudflare Pages worker (advanced mode) for the public demo deployment.
 *
 * Three jobs:
 *   1. proxy /uniswap/* to the Uniswap Trading API, injecting the API key
 *      server-side. The upstream sends no CORS headers for browser origins,
 *      and a public deployment must not ship the key in the bundle — which
 *      is what the dev-only Vite proxy used to paper over (docs/08).
 *   2. run the copilot's tool loop on /agent, which holds the model key and
 *      the Graph key and speaks MCP's JSON-RPC (see ./agent.js).
 *   3. hand everything else to the static Vite build.
 *
 * Lives in app/public/ so Vite copies it verbatim into dist/, making the
 * build output a self-contained deploy root. A _worker.js *directory* rather
 * than a single file, because the agent loop is shared with the Vite dev
 * middleware and Pages only resolves sibling imports in directory mode.
 *
 * Plain JS on purpose: no bundling step, so nothing to keep in sync with the
 * app's tsconfig. Keep the route contract aligned with vite.config.ts.
 */

import { handleAgent } from "./agent.js";

const UPSTREAM = "https://trade-api.gateway.uniswap.org";
const PREFIX = "/uniswap/";

/** 503 is the app's signal for "live market data is unavailable". */
function unconfigured() {
  return new Response(JSON.stringify({ error: "UNISWAP_API_KEY is not configured" }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/agent") return handleAgent(request, env);
    if (!url.pathname.startsWith(PREFIX)) return env.ASSETS.fetch(request);
    if (!env.UNISWAP_API_KEY) return unconfigured();

    // "/uniswap/v1/quote" -> "/v1/quote"
    const path = url.pathname.slice(PREFIX.length - 1);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";

    const upstream = await fetch(UPSTREAM + path + url.search, {
      method: request.method,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.UNISWAP_API_KEY,
      },
      body: hasBody ? await request.text() : undefined,
    });

    // Same-origin from the browser's point of view, so no CORS headers needed.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  },
};
