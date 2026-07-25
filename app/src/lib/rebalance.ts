/**
 * Rebalance execution via the Uniswap Trading API against the Base fork.
 *
 * Flow (docs/04, the "core" Uniswap integration):
 *   1. quote WETH<->USDC on Base (chain 8453) through the same-origin
 *      /uniswap proxy, which attaches the API key server-side
 *   2. approve SwapRouter02 for the sell token
 *   3. execute exactInputSingle on the fee tier the API's best route reported
 *
 * The corrective direction/size is chosen to move the strategy's inventory
 * back toward its target split.
 */

import type { Address, Hex } from "viem";

import { walletClient, publicClient } from "./chain";
import { erc20Abi } from "./abi";
import { UNAVAILABLE_STATUS } from "./uniswap";

const QUOTE_URL = "/uniswap/v1/quote";

export interface RebalancePlan {
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
  expectedBuyAmount: bigint;
  routeString: string;
  feeTier: number;
  /** Date.now() when the API quoted; the sheet expires the plan after 15s. */
  quotedAt: number;
}

export class RebalanceError extends Error {}

/** 0.05% — the deep Base WETH/USDC pool, used only when the quote names no route. */
const DEFAULT_FEE_TIER = 500;

/** One pool hop inside the Trading API's structured route (quote.route[i][j]). */
interface RouteHop {
  tokenIn?: { address?: string };
  tokenOut?: { address?: string };
  /** Fee in hundredths of a bip, e.g. "500" for 0.05%. */
  fee?: string | number;
  /** Present on a split's first hop: the input share routed through that split. */
  amountIn?: string;
}

function bigintOrZero(raw: string | undefined): bigint {
  try {
    return raw ? BigInt(raw) : 0n;
  } catch {
    return 0n;
  }
}

/**
 * Fee tier for the direct sell/buy pool, read from the structured route.
 *
 * quote.route is an array of splits; each split route[i] is an array of pool
 * hops route[i][j], each with its own `fee` (hundredths of a bip) and, on the
 * first hop, the `amountIn` share the router sent through that split. Splits
 * arrive in arbitrary order — a live 5-WETH quote came back as 5% @ 0.01% /
 * 15% @ 0.05% / 80% @ 0.05% — so "first fee mentioned" can be a pool the
 * router trusted with a sliver of the flow, or the first hop of a multi-hop
 * leg through a different pair entirely. Preference order:
 *   1. the direct single-hop split for the pair carrying the largest share;
 *   2. the first hop of the largest split (execution is exactInputSingle on
 *      the direct pool, so this is best-effort when every split multi-hops);
 *   3. no structured route: the fee of the largest split named in
 *      routeString, else the default tier.
 */
export function feeTierFromRoute(
  route: unknown,
  routeString: string,
  sellToken: Address,
  buyToken: Address,
): number {
  if (Array.isArray(route)) {
    const splits = route
      .filter((s): s is RouteHop[] => Array.isArray(s) && s.length > 0)
      .map((hops) => ({ hops, share: bigintOrZero(hops[0]?.amountIn) }));
    const pair = [sellToken.toLowerCase(), buyToken.toLowerCase()];
    const direct = splits.filter(
      ({ hops }) =>
        hops.length === 1 &&
        hops[0]!.tokenIn?.address?.toLowerCase() === pair[0] &&
        hops[0]!.tokenOut?.address?.toLowerCase() === pair[1],
    );
    const candidates = direct.length > 0 ? direct : splits;
    const best = candidates.reduce<(typeof splits)[number] | null>(
      (acc, split) => (acc === null || split.share > acc.share ? split : acc),
      null,
    );
    const fee = Number(best?.hops[0]!.fee);
    if (Number.isFinite(fee) && fee > 0) return Math.round(fee);
  }
  // Defensive fallback for responses without a structured route: the fee of
  // the *largest* split named in the display string, never just the first.
  let bestShare = -1;
  let bestFee: number | null = null;
  for (const m of routeString.matchAll(/(\d+(?:\.\d+)?)%\s*=\s*\[(\d+(?:\.\d+)?)%\]/g)) {
    const share = parseFloat(m[1]!);
    if (share > bestShare) {
      bestShare = share;
      bestFee = Math.round(parseFloat(m[2]!) * 10_000);
    }
  }
  return bestFee ?? DEFAULT_FEE_TIER;
}

/** Quote the corrective swap; returns the plan the sheet previews. */
export async function quoteRebalance(
  sellToken: Address,
  buyToken: Address,
  sellAmount: bigint,
  swapper: Address,
): Promise<{ plan: RebalancePlan; quote: unknown; permitData: unknown }> {
  const res = await fetch(QUOTE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "EXACT_INPUT",
      tokenIn: sellToken,
      tokenOut: buyToken,
      amount: sellAmount.toString(),
      tokenInChainId: 8453,
      tokenOutChainId: 8453,
      swapper,
      // Fork pools can diverge from the live block the API quotes against;
      // a generous slippage keeps the swap from reverting on minAmountOut.
      slippageTolerance: 5,
    }),
  });
  if (!res.ok) {
    throw new RebalanceError(
      UNAVAILABLE_STATUS.includes(res.status)
        ? "the /uniswap proxy has no API key configured"
        : `quote failed: HTTP ${res.status}`,
    );
  }
  const body = await res.json();
  const q = body.quote;
  if (!q?.output?.amount) throw new RebalanceError("quote missing output");
  // Fee tier comes from the structured route — the direct pool carrying the
  // bulk of the flow — not from string-scraping (see feeTierFromRoute).
  const routeString: string = q.routeString ?? "";
  const feeTier = feeTierFromRoute(q.route, routeString, sellToken, buyToken);
  return {
    plan: {
      sellToken,
      buyToken,
      sellAmount,
      expectedBuyAmount: BigInt(q.output.amount),
      routeString,
      feeTier,
      quotedAt: Date.now(),
    },
    quote: q,
    permitData: body.permitData ?? null,
  };
}

/**
 * Uniswap SwapRouter02 on Base. Execution goes through it directly with a
 * plain ERC20 approval: the Trading API still drives pricing/quoting (the
 * "core" integration and the preview), but direct router execution avoids
 * Permit2's EIP-712 path, which is brittle against a pinned fork block.
 */
const SWAP_ROUTER_02 = "0x2626664c2603336E57B271c5C0b26F421741e481" as const;

const swapRouterAbi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

/** Ensure the router can pull the sell token (one-time approval). */
async function ensureRouterAllowance(sellToken: Address, owner: Address, amount: bigint) {
  const allowance = (await publicClient.readContract({
    address: sellToken,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, SWAP_ROUTER_02],
  })) as bigint;
  if (allowance >= amount) return;
  const tx = await walletClient.writeContract({
    address: sellToken,
    abi: erc20Abi,
    functionName: "approve",
    args: [SWAP_ROUTER_02, 2n ** 256n - 1n],
  });
  await publicClient.waitForTransactionReceipt({ hash: tx });
}

/**
 * Execute the corrective swap through SwapRouter02, using the fee tier the
 * API's best route reported and the API's expected output (minus tolerance)
 * as the minimum, so the price still comes from Uniswap's routing.
 */
export async function executeRebalance(
  plan: RebalancePlan,
  feeTier: number,
): Promise<Hex> {
  await ensureRouterAllowance(plan.sellToken, walletClient.account.address, plan.sellAmount);
  // 5% floor below the API's expected output.
  const minOut = (plan.expectedBuyAmount * 95n) / 100n;
  const tx = await walletClient.writeContract({
    address: SWAP_ROUTER_02,
    abi: swapRouterAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: plan.sellToken,
        tokenOut: plan.buyToken,
        fee: feeTier,
        recipient: walletClient.account.address,
        amountIn: plan.sellAmount,
        amountOutMinimum: minOut,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  return tx;
}
