/**
 * Cloudflare Pages worker (advanced mode) for the public demo deployment.
 *
 * Two jobs:
 *   1. proxy /uniswap/* to the Uniswap Trading API, injecting the API key
 *      server-side. The upstream sends no CORS headers for browser origins,
 *      and a public deployment must not ship the key in the bundle — which
 *      is what the dev-only Vite proxy used to paper over (docs/08).
 *   2. hand everything else to the static Vite build.
 *
 * Lives in app/public/ so Vite copies it verbatim into dist/, making the
 * build output a self-contained deploy root. Advanced mode (_worker.js in
 * the output dir) is deliberate: a functions/ directory would sit outside
 * dist/ and would not survive `nix build` -> `result` -> `wrangler deploy`.
 *
 * Plain JS on purpose: no bundling step, so nothing to keep in sync with the
 * app's tsconfig. Keep the route contract aligned with vite.config.ts.
 */

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
