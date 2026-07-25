/**
 * Palette metadata: what the user sees, and how a fresh node is seeded.
 *
 * Kept apart from the compiler so wording and defaults can change without
 * touching bytecode emission, and apart from the editor so the palette can be
 * rendered anywhere (templates, docs, tests).
 */

import type { Address } from "viem";

import { BPS, MAX_SKEW_CAP } from "../compiler/opcodes";
import type { GraphNode } from "../compiler/graph";

export type NodeKind = GraphNode["kind"];

export interface PaletteEntry {
  kind: NodeKind;
  label: string;
  zone: "Pricing" | "Modifiers" | "Fees" | "Guards" | "Branches";
  blurb: string;
  /** Marks our own SwapVM instructions, which is what the 1inch track rewards. */
  custom?: boolean;
}

export const PALETTE: PaletteEntry[] = [
  {
    kind: "constantProduct",
    label: "Constant-Product",
    zone: "Pricing",
    blurb: "x·y=k on the balances Aqua allocated",
  },
  {
    kind: "priceRange",
    label: "Price Range",
    zone: "Modifiers",
    blurb: "concentrate liquidity into a band, like a v3 range",
  },
  {
    kind: "inventorySkew",
    label: "Inventory Skew",
    zone: "Modifiers",
    blurb: "tilt the quote toward a target inventory split",
    custom: true,
  },
  {
    kind: "flowDecay",
    label: "Flow Decay",
    zone: "Modifiers",
    blurb: "repeat trades pay worse; the penalty heals over time",
  },
  { kind: "flatFee", label: "Flat Fee", zone: "Fees", blurb: "earn a fixed % on every trade" },
  { kind: "deadline", label: "Deadline", zone: "Guards", blurb: "stop quoting at a set time" },
  {
    kind: "holderGate",
    label: "Holder Gate",
    zone: "Guards",
    blurb: "only takers holding a token may trade",
  },
  {
    kind: "ifDirection",
    label: "If Direction",
    zone: "Branches",
    blurb: "fork on which side the taker is trading",
  },
  {
    kind: "ifInventoryAbove",
    label: "If Inventory Above",
    zone: "Branches",
    blurb: "fork on how much of the pair you are holding",
    custom: true,
  },
];

export interface SeedContext {
  weth: Address;
  usdc: Address;
  target0: bigint;
  target1: bigint;
}

/** A newly dropped node, pre-filled with values that already validate. */
export function seedNode(kind: NodeKind, id: string, ctx: SeedContext): GraphNode {
  switch (kind) {
    case "constantProduct":
      return { id, kind };
    case "priceRange":
      // Seeded wide (a decade around parity) so the node is valid before the
      // user narrows it; templates set a meaningful band.
      return { id, kind, sqrtPriceMinX18: 10n ** 17n, sqrtPriceMaxX18: 10n ** 19n };
    case "inventorySkew":
      return { id, kind, target0: ctx.target0, target1: ctx.target1, maxSkewBps: MAX_SKEW_CAP / 2 };
    case "flowDecay":
      return { id, kind, periodSeconds: 3600 };
    case "flatFee":
      return { id, kind, feeBps: Math.round(0.003 * BPS) };
    case "deadline":
      return { id, kind, timestamp: Math.floor(Date.now() / 1000) + 24 * 3600 };
    case "holderGate":
      return { id, kind, token: ctx.usdc, minBalance: 0n };
    case "ifDirection":
      return { id, kind, token: ctx.weth };
    case "ifInventoryAbove":
      return { id, kind, target0: ctx.target0, target1: ctx.target1 };
  }
}
