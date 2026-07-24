/**
 * Uniswap Trading API client (developers.uniswap.org).
 *
 * Role in Bacalhau (docs/04): market reference price for the canvas overlay
 * and the inventory gauge, and quoting/routing for the rebalance flow.
 * The demo pair is mock WETH/USDC on a local chain; the *market truth* is
 * the real mainnet WETH/USDC quote — live data, not a mock.
 *
 * PoC posture (docs/08): the API key ships client-side via Vite env.
 */

const API_URL = "/uniswap/v1/quote";
// Mainnet canonical pair used as the price reference for the demo pair.
const MAINNET_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // 6 decimals
const PRICE_PROBE_WETH = 10n ** 18n; // quote 1 WETH

export interface MarketPrice {
  /** USDC per WETH, 1e18-scaled (demo tokens are 18-decimals). */
  price: bigint;
  fetchedAt: number; // Date.now()
}

export class UniswapApiError extends Error {}

const apiKey: string | undefined = import.meta.env.VITE_UNISWAP_API_KEY;

export function hasUniswapKey(): boolean {
  return typeof apiKey === "string" && apiKey.length > 0;
}

/** Live WETH/USDC mid from the Uniswap Trading API (EXACT_INPUT 1 WETH). */
export async function fetchMarketPrice(swapper: string): Promise<MarketPrice> {
  if (!apiKey) throw new UniswapApiError("VITE_UNISWAP_API_KEY is not set");

  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      type: "EXACT_INPUT",
      tokenIn: MAINNET_WETH,
      tokenOut: MAINNET_USDC,
      amount: PRICE_PROBE_WETH.toString(),
      tokenInChainId: 1,
      tokenOutChainId: 1,
      swapper,
    }),
  });
  if (!res.ok) {
    throw new UniswapApiError(`quote failed: HTTP ${res.status}`);
  }
  const body = await res.json();
  const rawOut: string | undefined = body?.quote?.output?.amount;
  if (!rawOut) throw new UniswapApiError("quote response missing output amount");

  // USDC has 6 decimals; normalize to 1e18 scale for the 18-decimals demo pair.
  const price = BigInt(rawOut) * 10n ** 12n;
  return { price, fetchedAt: Date.now() };
}
