import { describe, expect, it } from "vitest";
import type { Address } from "viem";

import { feeTierFromRoute } from "./rebalance";

// Base mainnet tokens, as the Trading API reports them.
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as Address;

/** One pool hop as quote.route[i][j] delivers it. */
function hop(
  tokenIn: string,
  tokenOut: string,
  fee: string | number,
  amountIn?: string,
): Record<string, unknown> {
  return {
    tokenIn: { address: tokenIn },
    tokenOut: { address: tokenOut },
    fee,
    ...(amountIn !== undefined ? { amountIn } : {}),
  };
}

describe("feeTierFromRoute", () => {
  it("live repro: picks the 0.05% pool carrying 95%, not the first-listed 0.01% sliver", () => {
    // Observed 5-WETH quote: splits arrive 5% @ 0.01% / 15% @ 0.05% / 80% @ 0.05%.
    const route = [
      [hop(WETH, USDC, "100", "250000000000000000")], // 0.25 WETH
      [hop(WETH, USDC, "500", "750000000000000000")], // 0.75 WETH
      [hop(WETH, USDC, "500", "4000000000000000000")], // 4 WETH
    ];
    const routeString =
      "[v3] 5.00% = [0.01%] 0xb4cb..., [v3] 15.00% = [0.05%] ..., [v3] 80.00% = [0.05%] 0xd0b5...";
    const fee = feeTierFromRoute(route, routeString, WETH, USDC);
    expect(fee).toBe(500);
    // The old regex-the-first-[N%] behavior would have returned 100.
    expect(fee).not.toBe(100);
  });

  it("prefers a direct sell/buy hop over a larger multi-hop split", () => {
    const route = [
      // 8 WETH through WETH -> cbBTC -> USDC: bigger share, but not the direct pool.
      [hop(WETH, CBBTC, "500", "8000000000000000000"), hop(CBBTC, USDC, "3000")],
      // 2 WETH straight through the WETH/USDC 0.30% pool.
      [hop(WETH, USDC, "3000", "2000000000000000000")],
    ];
    expect(feeTierFromRoute(route, "", WETH, USDC)).toBe(3000);
  });

  it("all splits multi-hop: falls back to the first hop of the largest split", () => {
    const route = [
      [hop(WETH, CBBTC, "3000", "1000000000000000000"), hop(CBBTC, USDC, "500")],
      [hop(WETH, CBBTC, "100", "9000000000000000000"), hop(CBBTC, USDC, "500")],
    ];
    expect(feeTierFromRoute(route, "", WETH, USDC)).toBe(100);
  });

  it("no structured route: routeString fallback picks the largest split, not the first", () => {
    const routeString = "[v3] 5.00% = [0.01%] 0xb4cb..., [v3] 95.00% = [0.30%] 0xd0b5...";
    expect(feeTierFromRoute(undefined, routeString, WETH, USDC)).toBe(3000);
  });

  it("no route and no parseable routeString: defaults to 500", () => {
    expect(feeTierFromRoute(undefined, "", WETH, USDC)).toBe(500);
    expect(feeTierFromRoute(undefined, "best price via aggregator", WETH, USDC)).toBe(500);
  });

  it("accepts numeric fees and matches addresses case-insensitively", () => {
    // Hop carries the checksummed USDC address; the caller passes lowercase.
    const route = [[hop(USDC, WETH, 500, "1000000")]];
    const lowerUsdc = USDC.toLowerCase() as Address;
    const lowerWeth = WETH.toLowerCase() as Address;
    expect(feeTierFromRoute(route, "", lowerUsdc, lowerWeth)).toBe(500);
  });
});
