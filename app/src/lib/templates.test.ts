import { describe, expect, it } from "vitest";

import { compile, validate, type StrategyGraph } from "../compiler/graph";
import { fromSqrtPriceX18 } from "./price";
import { TEMPLATES, type TemplateContext } from "./templates";
import { USDC_DECIMALS, WETH_DECIMALS } from "./units";

/**
 * Templates are the one-click demo path: a build() that throws or produces a
 * graph validate() rejects turns a headline button into a dead one. These
 * tests pin the two ways that happened — an address ordering that inverts the
 * concentrated price band, and a blank allocation with no market feed.
 */

const LOW = "0x00000000000000000000000000000000000000aa" as const;
const HIGH = "0x00000000000000000000000000000000000000bb" as const;

/** 10 WETH against 18,500 USDC: an implied price of 1850, no market feed. */
function context(overrides: Partial<TemplateContext> = {}): TemplateContext {
  return {
    weth: LOW,
    usdc: HIGH,
    allocWeth: 10n * 10n ** BigInt(WETH_DECIMALS),
    allocUsdc: 18_500n * 10n ** BigInt(USDC_DECIMALS),
    marketPrice: null,
    ...overrides,
  };
}

const ORDERINGS = [
  { name: "WETH sorted below USDC", weth: LOW, usdc: HIGH },
  // The ordering no current deployment has: sqrt bounds price the
  // address-sorted pair, so the human->sqrt conversion becomes a reciprocal.
  { name: "WETH sorted above USDC", weth: HIGH, usdc: LOW },
] as const;

describe("every template builds a compilable graph for both address orderings", () => {
  for (const { name, weth, usdc } of ORDERINGS) {
    it.each(TEMPLATES)(`$label with ${name}`, (template) => {
      const graph: StrategyGraph = template.build(context({ weth, usdc }));
      expect(validate(graph).map((e) => `${e.nodeId}: ${e.message}`)).toEqual([]);
      expect(() => compile(graph, { salt: 1n })).not.toThrow();
    });
  }
});

function concentratedRange(ctx: TemplateContext): { min: bigint; max: bigint } {
  const template = TEMPLATES.find((t) => t.id === "concentrated");
  const range = template?.build(ctx).nodes.find((n) => n.kind === "priceRange");
  if (!range || range.kind !== "priceRange") throw new Error("the concentrated template lost its priceRange node");
  return { min: range.sqrtPriceMinX18, max: range.sqrtPriceMaxX18 };
}

describe("the concentrated desk's price band", () => {
  it("keeps min below max when WETH is the higher-sorted address", () => {
    // Regression: bounds() used to pass lo->min unconditionally, so the
    // reciprocal ordering produced an inverted range validate() rejects.
    const { min, max } = concentratedRange(context({ weth: HIGH, usdc: LOW }));
    expect(min).toBeLessThan(max);
  });

  it("brackets the same human prices regardless of address order", () => {
    for (const { weth, usdc } of ORDERINGS) {
      const ctx = context({ weth, usdc });
      const { min, max } = concentratedRange(ctx);
      const base = { address: ctx.weth, decimals: WETH_DECIMALS };
      const quote = { address: ctx.usdc, decimals: USDC_DECIMALS };
      const human = [fromSqrtPriceX18(min, base, quote), fromSqrtPriceX18(max, base, quote)].sort((a, b) => a - b);
      // ±8% around the implied 1850 USDC per WETH.
      expect(human[0]).toBeCloseTo(1850 * 0.92, 0);
      expect(human[1]).toBeCloseTo(1850 * 1.08, 0);
    }
  });
});

describe("templates with no price signal (blank allocation, no market feed)", () => {
  it.each(TEMPLATES)("$label still builds a graph validate() accepts", (template) => {
    // Regression: a zero implied price made bounds() feed "0.000000" to
    // toSqrtPriceX18, which throws — the button died in its click handler.
    const graph = template.build(context({ allocWeth: 0n, allocUsdc: 0n }));
    expect(validate(graph).map((e) => `${e.nodeId}: ${e.message}`)).toEqual([]);
  });
});
