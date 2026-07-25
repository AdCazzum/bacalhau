import { afterEach, beforeEach, describe, expect, it } from "vitest";

// `public/` is outside tsconfig's `include` and `allowJs` is off, so the plain-JS
// worker ships no declarations. Its shape is the Cloudflare module-worker contract.
// @ts-expect-error - untyped JS module
import workerModule from "../../public/_worker.js";

/**
 * Contract tests for the Cloudflare Pages worker (app/public/_worker.js).
 *
 * Two things make this worth pinning down. It is the only thing keeping the
 * Uniswap API key out of the public bundle, and src/lib/uniswap.ts branches on
 * the *status code* the worker relays (UNAVAILABLE_STATUS = 401/403/503) to
 * decide whether live market data exists at all. A silently rewritten path,
 * a dropped key or a masked status all fail the app in ways no other test sees.
 *
 * The global fetch is replaced by a capture stub for every test, so nothing
 * here touches the network.
 */

const KEY = "uniswap-key-under-test";
const UPSTREAM = "https://trade-api.gateway.uniswap.org";
const ORIGIN = "https://bacalhau.pages.dev";

interface Capture {
  url: string;
  init: RequestInit;
}

interface Env {
  UNISWAP_API_KEY?: string;
  ASSETS: { fetch(request: Request): Promise<Response> };
}

const worker = workerModule as { fetch(request: Request, env: Env): Promise<Response> };

let calls: Capture[];
/** Built fresh per call so a body is never read twice. */
let upstreamReply: () => Response;
let realFetch: typeof globalThis.fetch;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  calls = [];
  upstreamReply = () => json(200, { ok: true });
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), init });
    return Promise.resolve(upstreamReply());
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The one upstream call a proxied request must produce — no more, no less. */
function upstreamCall(): Capture {
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

function fakeEnv(apiKey?: string) {
  const assetRequests: Request[] = [];
  const assetResponse = new Response("<!doctype html>", { status: 200 });
  const env: Env = {
    UNISWAP_API_KEY: apiKey,
    ASSETS: {
      fetch: (request: Request) => {
        assetRequests.push(request);
        return Promise.resolve(assetResponse);
      },
    },
  };
  return { env, assetRequests, assetResponse };
}

describe("static asset passthrough", () => {
  it("hands a non-/uniswap request to the asset handler and returns its response", async () => {
    const { env, assetRequests, assetResponse } = fakeEnv(KEY);
    const request = new Request(`${ORIGIN}/index.html`);

    const res = await worker.fetch(request, env);

    expect(res).toBe(assetResponse);
    expect(assetRequests).toHaveLength(1);
    expect(assetRequests[0]).toBe(request);
    expect(calls).toHaveLength(0);
  });

  // The prefix carries a trailing slash, and the rewrite slices by its length:
  // both halves of that break if `startsWith` ever loosens.
  const notProxied = [
    { name: "the bare prefix without a trailing slash", path: "/uniswap" },
    { name: "a path that merely starts with the same letters", path: "/uniswaps/v1/quote" },
    { name: "the prefix in a later segment", path: "/assets/uniswap/v1/quote" },
  ];

  for (const { name, path } of notProxied) {
    it(`serves ${name} as a static asset`, async () => {
      const { env, assetRequests, assetResponse } = fakeEnv(KEY);

      const res = await worker.fetch(new Request(ORIGIN + path), env);

      expect(res).toBe(assetResponse);
      expect(assetRequests).toHaveLength(1);
      expect(calls).toHaveLength(0);
    });
  }
});

describe("unconfigured deployment", () => {
  it("answers /uniswap/* with 503 and the documented error body", async () => {
    const { env, assetRequests } = fakeEnv(undefined);

    const res = await worker.fetch(new Request(`${ORIGIN}/uniswap/v1/quote`), env);

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "UNISWAP_API_KEY is not configured" });
    // Neither upstream (no key to send) nor the static build (a 404 page would
    // read as a different failure to uniswap.ts) may see the request.
    expect(calls).toHaveLength(0);
    expect(assetRequests).toHaveLength(0);
  });

  it("treats an empty key as unconfigured rather than sending it upstream", async () => {
    const { env } = fakeEnv("");

    const res = await worker.fetch(new Request(`${ORIGIN}/uniswap/v1/quote`), env);

    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});

describe("upstream URL rewrite", () => {
  const routes = [
    {
      name: "strips the prefix and keeps the query string",
      path: "/uniswap/v1/quote?x=1",
      expected: `${UPSTREAM}/v1/quote?x=1`,
    },
    {
      name: "applies to any route, not just /v1/quote",
      path: "/uniswap/v1/swap",
      expected: `${UPSTREAM}/v1/swap`,
    },
    {
      name: "preserves every segment and every query parameter",
      path: "/uniswap/v1/swappable_tokens?chainId=1&tokenIn=0xC02aaA39",
      expected: `${UPSTREAM}/v1/swappable_tokens?chainId=1&tokenIn=0xC02aaA39`,
    },
  ];

  for (const { name, path, expected } of routes) {
    it(name, async () => {
      const { env } = fakeEnv(KEY);

      await worker.fetch(new Request(ORIGIN + path), env);

      expect(upstreamCall().url).toBe(expected);
    });
  }
});

describe("upstream headers", () => {
  it("attaches the key from env and asks for JSON", async () => {
    const { env } = fakeEnv(KEY);

    await worker.fetch(new Request(`${ORIGIN}/uniswap/v1/quote`), env);

    const headers = new Headers(upstreamCall().init.headers);
    expect(headers.get("x-api-key")).toBe(KEY);
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("ignores caller-supplied headers, so the key cannot be overridden", async () => {
    const { env } = fakeEnv(KEY);
    const request = new Request(`${ORIGIN}/uniswap/v1/quote`, {
      headers: { "x-api-key": "caller-supplied", cookie: "session=secret" },
    });

    await worker.fetch(request, env);

    const headers = new Headers(upstreamCall().init.headers);
    expect(headers.get("x-api-key")).toBe(KEY);
    expect(headers.get("cookie")).toBeNull();
  });
});

describe("request body forwarding", () => {
  it("forwards a POST body verbatim, with the method intact", async () => {
    const { env } = fakeEnv(KEY);
    const body = JSON.stringify({ type: "EXACT_INPUT", amount: "1000000000000000000" });

    const request = new Request(`${ORIGIN}/uniswap/v1/quote`, { method: "POST", body });
    await worker.fetch(request, env);

    const { init } = upstreamCall();
    expect(init.method).toBe("POST");
    expect(init.body).toBe(body);
  });

  it("forwards a body for methods other than GET/HEAD", async () => {
    const { env } = fakeEnv(KEY);
    const body = JSON.stringify({ permit: "0xdeadbeef" });

    const request = new Request(`${ORIGIN}/uniswap/v1/order`, { method: "PUT", body });
    await worker.fetch(request, env);

    const { init } = upstreamCall();
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(body);
  });

  // undici throws on a GET/HEAD carrying a body, so "" instead of undefined
  // would turn every read request into a runtime failure.
  for (const method of ["GET", "HEAD"]) {
    it(`sends no body at all on ${method}`, async () => {
      const { env } = fakeEnv(KEY);

      const request = new Request(`${ORIGIN}/uniswap/v1/quote?x=1`, { method });
      await worker.fetch(request, env);

      const { init } = upstreamCall();
      expect(init.method).toBe(method);
      expect(init.body).toBeUndefined();
    });
  }
});

describe("upstream response relay", () => {
  it("passes the JSON payload through unchanged", async () => {
    const { env } = fakeEnv(KEY);
    const payload = { quote: { output: { amount: "3421550000" } } };
    upstreamReply = () => json(200, payload);

    const res = await worker.fetch(new Request(`${ORIGIN}/uniswap/v1/quote`), env);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(payload);
  });

  it("relays a non-2xx status instead of masking or throwing it", async () => {
    const { env } = fakeEnv(KEY);
    upstreamReply = () => json(429, { errorCode: "RATE_LIMIT" });

    const res = await worker.fetch(new Request(`${ORIGIN}/uniswap/v1/quote`), env);

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ errorCode: "RATE_LIMIT" });
  });
});
