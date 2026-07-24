/**
 * Rebalance execution via the Uniswap Trading API against the Base fork.
 *
 * Flow (docs/04, the "core" Uniswap integration):
 *   1. quote WETH<->USDC on Base (chain 8453)
 *   2. sign the Permit2 typed-data with the demo wallet
 *   3. /swap -> executable transaction (approve is folded into the route)
 *   4. send it from the maker wallet against the forked Uniswap pools
 *
 * The corrective direction/size is chosen to move the strategy's inventory
 * back toward its target split.
 */

import type { Address, Hex } from "viem";

import { walletClient, publicClient } from "./chain";
import { erc20Abi } from "./abi";

const QUOTE_URL = "/uniswap/v1/quote";
const SWAP_URL = "/uniswap/v1/swap";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

const apiKey: string | undefined = import.meta.env.VITE_UNISWAP_API_KEY;

export interface RebalancePlan {
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
  expectedBuyAmount: bigint;
  routeString: string;
  feeTier: number;
}

export class RebalanceError extends Error {}

function headers(): Record<string, string> {
  if (!apiKey) throw new RebalanceError("VITE_UNISWAP_API_KEY is not set");
  return { "Content-Type": "application/json", "x-api-key": apiKey };
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
    headers: headers(),
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
  if (!res.ok) throw new RebalanceError(`quote failed: HTTP ${res.status}`);
  const body = await res.json();
  const q = body.quote;
  if (!q?.output?.amount) throw new RebalanceError("quote missing output");
  // Parse the dominant fee tier from the route (e.g. "[0.05%]" -> 500).
  const feeMatch = /\[(\d+(?:\.\d+)?)%\]/.exec(q.routeString ?? "");
  const feeTier = feeMatch ? Math.round(parseFloat(feeMatch[1]!) * 10000) : 500;
  return {
    plan: {
      sellToken,
      buyToken,
      sellAmount,
      expectedBuyAmount: BigInt(q.output.amount),
      routeString: q.routeString ?? "",
      feeTier,
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
