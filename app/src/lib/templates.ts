/**
 * Callable strategy templates.
 *
 * An empty canvas is a bad first experience and a worse demo: these are the
 * strategies worth showing, each one exercising a different SwapVM primitive,
 * ready to ship in one click. They are also the honest answer to "what can this
 * express that a normal DEX cannot" — the last three have no equivalent in a
 * constant-product pool.
 *
 * Every template is a function of the live allocation, so the numbers always
 * match what the user is about to ship.
 */

import type { Address } from "viem";

import { BPS, MAX_SKEW_CAP } from "../compiler/opcodes";
import type { StrategyGraph } from "../compiler/graph";
import { toSqrtPriceX18, type Token } from "./price";
import { USDC_DECIMALS, WETH_DECIMALS } from "./units";

export interface TemplateContext {
  weth: Address;
  usdc: Address;
  /** Allocation the user is about to ship, in raw token units. */
  allocWeth: bigint;
  allocUsdc: bigint;
  /** Live market price (USDC per WETH, 1e18-scaled), when available. */
  marketPrice: bigint | null;
}

export interface Template {
  id: string;
  label: string;
  /** One line, shown under the button; plain language, no opcode jargon. */
  blurb: string;
  /** True when the strategy cannot be expressed by a constant-product pool. */
  novel?: boolean;
  build(ctx: TemplateContext): StrategyGraph;
}

const FEE = (percent: number) => Math.round((percent / 100) * BPS);
const DAY = 24 * 3600;

/** Price implied by the allocation itself, so templates work offline. */
function impliedPrice(ctx: TemplateContext): number {
  if (ctx.marketPrice !== null && ctx.marketPrice > 0n) {
    return Number(ctx.marketPrice) / 1e18;
  }
  if (ctx.allocWeth === 0n) return 0;
  const weth = Number(ctx.allocWeth) / 10 ** WETH_DECIMALS;
  const usdc = Number(ctx.allocUsdc) / 10 ** USDC_DECIMALS;
  return weth > 0 ? usdc / weth : 0;
}

/**
 * Skew/branch targets for a desired WETH share of total value, keeping the
 * total constant so the strategy is asking to *rotate* its inventory rather
 * than acquire more of it.
 */
function targetsForShare(ctx: TemplateContext, wethShare: number): { target0: bigint; target1: bigint } {
  const price = impliedPrice(ctx);
  const wethUnits = Number(ctx.allocWeth) / 10 ** WETH_DECIMALS;
  const usdcUnits = Number(ctx.allocUsdc) / 10 ** USDC_DECIMALS;
  const totalValue = wethUnits * price + usdcUnits;

  const wantWeth = price > 0 ? (totalValue * wethShare) / price : wethUnits;
  const wantUsdc = totalValue * (1 - wethShare);
  const weth = BigInt(Math.max(1, Math.round(wantWeth * 10 ** WETH_DECIMALS)));
  const usdc = BigInt(Math.max(1, Math.round(wantUsdc * 10 ** USDC_DECIMALS)));

  // Args are keyed to the address-sorted pair, not to WETH/USDC.
  return ctx.weth.toLowerCase() < ctx.usdc.toLowerCase()
    ? { target0: weth, target1: usdc }
    : { target0: usdc, target1: weth };
}

function bounds(ctx: TemplateContext, spreadPercent: number): { min: bigint; max: bigint } {
  const price = impliedPrice(ctx);
  const base: Token = { address: ctx.weth, decimals: WETH_DECIMALS };
  const quote: Token = { address: ctx.usdc, decimals: USDC_DECIMALS };
  const lo = price * (1 - spreadPercent / 100);
  const hi = price * (1 + spreadPercent / 100);
  return {
    min: toSqrtPriceX18(lo.toFixed(6), base, quote),
    max: toSqrtPriceX18(hi.toFixed(6), base, quote),
  };
}

/** Straight line through the given node ids. */
function chain(ids: string[]): StrategyGraph["edges"] {
  return ids.slice(0, -1).map((from, i) => ({ from, to: ids[i + 1] as string }));
}

export const TEMPLATES: Template[] = [
  {
    id: "passiveAmm",
    label: "Passive AMM",
    blurb: "A Uniswap-style LP position without the pool — your funds never leave your wallet.",
    build: () => ({
      nodes: [
        { id: "fee", kind: "flatFee", feeBps: FEE(0.3) },
        { id: "amm", kind: "constantProduct" },
      ],
      edges: chain(["fee", "amm"]),
    }),
  },
  {
    id: "selfBalancing",
    label: "Self-balancing MM",
    blurb: "Quotes tilt to defend your current mix: trades that rebalance you get a better price.",
    novel: true,
    build: (ctx) => {
      const t = targetsForShare(ctx, 0.5);
      return {
        nodes: [
          { id: "expiry", kind: "deadline", timestamp: Math.floor(Date.now() / 1000) + DAY },
          { id: "skew", kind: "inventorySkew", ...t, maxSkewBps: MAX_SKEW_CAP / 2 },
          { id: "fee", kind: "flatFee", feeBps: FEE(0.3) },
          { id: "amm", kind: "constantProduct" },
        ],
        edges: chain(["expiry", "skew", "fee", "amm"]),
      };
    },
  },
  {
    id: "accumulateEth",
    label: "Accumulate ETH",
    blurb: "Pay up to buy ETH, charge up to sell it: you drift to 70% ETH and earn fees doing it.",
    novel: true,
    build: (ctx) => {
      const t = targetsForShare(ctx, 0.7);
      return {
        nodes: [
          { id: "skew", kind: "inventorySkew", ...t, maxSkewBps: MAX_SKEW_CAP / 2 },
          { id: "fee", kind: "flatFee", feeBps: FEE(0.3) },
          { id: "amm", kind: "constantProduct" },
        ],
        edges: chain(["skew", "fee", "amm"]),
      };
    },
  },
  {
    id: "concentrated",
    label: "Concentrated desk",
    blurb: "All your liquidity inside a ±8% band, so quotes are far deeper where trades happen.",
    build: (ctx) => {
      const b = bounds(ctx, 8);
      return {
        nodes: [
          { id: "range", kind: "priceRange", sqrtPriceMinX18: b.min, sqrtPriceMaxX18: b.max },
          { id: "fee", kind: "flatFee", feeBps: FEE(0.15) },
          { id: "amm", kind: "constantProduct" },
        ],
        edges: chain(["range", "fee", "amm"]),
      };
    },
  },
  {
    id: "twoSided",
    label: "Two-sided desk",
    blurb: "Cheap when someone sells you ETH, expensive when they buy: the graph forks on direction.",
    novel: true,
    build: (ctx) => ({
      nodes: [
        { id: "side", kind: "ifDirection", token: ctx.weth },
        { id: "cheap", kind: "flatFee", feeBps: FEE(0.05) },
        { id: "dear", kind: "flatFee", feeBps: FEE(0.5) },
        { id: "amm", kind: "constantProduct" },
      ],
      edges: [
        { from: "side", to: "cheap", port: "then" },
        { from: "side", to: "dear", port: "else" },
        { from: "cheap", to: "amm" },
        { from: "dear", to: "amm" },
      ],
    }),
  },
  {
    id: "adaptive",
    label: "Adaptive desk",
    blurb: "A state machine: accumulate ETH until you hold 70%, then flip to distributing it.",
    novel: true,
    build: (ctx) => {
      const trigger = targetsForShare(ctx, 0.7);
      const distribute = targetsForShare(ctx, 0.3);
      const accumulate = targetsForShare(ctx, 0.7);
      return {
        nodes: [
          { id: "state", kind: "ifInventoryAbove", target0: trigger.target0, target1: trigger.target1 },
          { id: "sellSkew", kind: "inventorySkew", ...distribute, maxSkewBps: MAX_SKEW_CAP / 2 },
          { id: "sellFee", kind: "flatFee", feeBps: FEE(0.5) },
          { id: "buySkew", kind: "inventorySkew", ...accumulate, maxSkewBps: MAX_SKEW_CAP / 2 },
          { id: "buyFee", kind: "flatFee", feeBps: FEE(0.05) },
          { id: "amm", kind: "constantProduct" },
        ],
        edges: [
          { from: "state", to: "sellSkew", port: "then" },
          { from: "state", to: "buySkew", port: "else" },
          { from: "sellSkew", to: "sellFee" },
          { from: "sellFee", to: "amm" },
          { from: "buySkew", to: "buyFee" },
          { from: "buyFee", to: "amm" },
        ],
      };
    },
  },
];
