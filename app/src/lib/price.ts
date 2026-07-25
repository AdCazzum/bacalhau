/**
 * Price conversions for the concentrated-range block.
 *
 * XYCConcentrate takes bounds as sqrt(P)·1e18 where P is expressed in RAW token
 * units and the pair is address-sorted: P = tokenGt / tokenLt. Human prices are
 * quoted the other way round (USDC per WETH) and in display units, so both the
 * decimals and the address ordering have to be folded in — getting either wrong
 * silently shifts the range by orders of magnitude.
 */

import type { Address } from "viem";

/** Integer square root (Newton). Exact floor for any non-negative bigint. */
export function isqrt(value: bigint): bigint {
  if (value < 0n) throw new RangeError("isqrt of a negative number");
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

/** Parse a decimal string into an exact fraction. */
export function decimalToFraction(input: string): { num: bigint; den: bigint } {
  const text = input.trim();
  if (!/^\d*\.?\d*$/.test(text) || text === "" || text === ".") {
    throw new RangeError(`not a decimal number: ${input}`);
  }
  const [whole = "", frac = ""] = text.split(".");
  return { num: BigInt(`${whole}${frac}` || "0"), den: 10n ** BigInt(frac.length) };
}

export interface Token {
  address: Address;
  decimals: number;
}

/**
 * Convert a human price (quote units per 1 base unit, e.g. USDC per WETH) into
 * the sqrt(P)·1e18 bound the instruction expects.
 */
export function toSqrtPriceX18(humanPrice: string, base: Token, quote: Token): bigint {
  const { num, den } = decimalToFraction(humanPrice);
  if (num === 0n) throw new RangeError("price must be positive");

  const baseIsLower = base.address.toLowerCase() < quote.address.toLowerCase();
  // P = gt/lt in raw units. Held as a fraction so the sqrt is taken once, on
  // an integer scaled by 1e36 (= (1e18)^2), which yields sqrt(P)·1e18.
  const SCALE = 10n ** 36n;
  const [pNum, pDen] = baseIsLower
    ? [num * 10n ** BigInt(quote.decimals), den * 10n ** BigInt(base.decimals)]
    : [den * 10n ** BigInt(base.decimals), num * 10n ** BigInt(quote.decimals)];

  return isqrt((pNum * SCALE) / pDen);
}

/** Inverse of {@link toSqrtPriceX18}, for labelling a range in the UI. */
export function fromSqrtPriceX18(sqrtPriceX18: bigint, base: Token, quote: Token): number {
  const baseIsLower = base.address.toLowerCase() < quote.address.toLowerCase();
  const ONE = 10n ** 18n;
  // Recover P with 1e18 of headroom, then undo the decimal shift in float —
  // this value only ever feeds a label, never an on-chain argument.
  const pX18 = (sqrtPriceX18 * sqrtPriceX18) / ONE;
  const raw = Number(pX18) / 1e18;
  const shift = 10 ** (base.decimals - quote.decimals);
  return baseIsLower ? raw * shift : 1 / (raw / shift);
}
