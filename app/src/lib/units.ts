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
 * Decimals for the Base Sepolia demo pair (contracts/deployments/sepolia.json),
 * the tokens the subgraph reports. Returns null for anything else so amounts
 * degrade to raw units instead of being silently mis-scaled.
 */
export function indexedDecimals(token: string): number | null {
  const t = token.toLowerCase();
  if (t === "0x0f599727f37d4fc8ab5dbd3afe86c3ebf4a892f7") return WETH_DECIMALS;
  if (t === "0xb6ec46c767b71a5aa4b51bad4a40827560d63e55") return USDC_DECIMALS;
  return null;
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
