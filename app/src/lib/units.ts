import { formatUnits, parseUnits } from "viem";

/** Token decimals for the demo pair on Base. */
export const WETH_DECIMALS = 18;
export const USDC_DECIMALS = 6;

/** Human-readable amount for a token balance, with sensible precision. */
export function fmtAmount(raw: bigint, decimals: number): string {
  const n = Number(formatUnits(raw, decimals));
  return n >= 1000
    ? n.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function parseAmount(value: string, decimals: number): bigint {
  return parseUnits(value === "" ? "0" : value, decimals);
}

/**
 * Value of a WETH balance in USDC's smallest unit, given a market price
 * expressed as USDC(1e18-scaled) per WETH. Normalizes the 18/6 mismatch so
 * it can be summed with a raw USDC balance.
 */
export function wethValueInUsdc(wethRaw: bigint, priceUsdcPerWeth1e18: bigint): bigint {
  // wethRaw(1e18) * price(1e18 USDC/WETH) / 1e18 -> USDC at 1e18 scale,
  // then down to 6 decimals.
  return (wethRaw * priceUsdcPerWeth1e18) / 10n ** 18n / 10n ** 12n;
}
