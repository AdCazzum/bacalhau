/**
 * Client-side mirror of the strategy pipeline math, for the canvas preview
 * chart. Must match the on-chain instructions:
 *   InventorySkew (virtual balance shrink) -> flat fee on input -> x*y=k.
 * The source of numerical truth stays the chain (router.quote); this exists
 * only to draw curves at interactive speed.
 */

export const BPS = 1_000_000_000n;

export interface PreviewParams {
  balanceIn: bigint;
  balanceOut: bigint;
  targetIn: bigint; // 0n = no skew block
  targetOut: bigint;
  maxSkewBps: bigint;
  feeBps: bigint;
}

export function previewAmountOut(amountIn: bigint, p: PreviewParams): bigint {
  let { balanceIn, balanceOut } = p;

  if (p.targetIn > 0n && p.targetOut > 0n) {
    const inWeight = balanceIn * p.targetOut;
    const outWeight = balanceOut * p.targetIn;
    if (inWeight !== outWeight) {
      const total = inWeight + outWeight;
      const drift =
        inWeight > outWeight
          ? ((inWeight - outWeight) * BPS) / total
          : ((outWeight - inWeight) * BPS) / total;
      const skew = (drift * p.maxSkewBps) / BPS;
      if (inWeight < outWeight) {
        balanceIn = (balanceIn * (BPS - skew)) / BPS;
      } else {
        balanceOut = (balanceOut * (BPS - skew)) / BPS;
      }
    }
  }

  const netIn = amountIn - (amountIn * p.feeBps) / BPS;
  if (balanceIn + netIn === 0n) return 0n;
  return (netIn * balanceOut) / (balanceIn + netIn);
}

/** Marginal execution price (out per in, 1e18-scaled) at a given trade size. */
export function previewPrice(amountIn: bigint, p: PreviewParams): bigint {
  if (amountIn === 0n) return 0n;
  return (previewAmountOut(amountIn, p) * 10n ** 18n) / amountIn;
}
