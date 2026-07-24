/**
 * Opcode table for the Aqua-backed router (BacalhauRouter).
 *
 * Source of truth: swap-vm/src/opcodes/AquaOpcodes.sol — opcode byte N maps
 * to `instructions[N + 1]` after the length-rewrite trick. Verified against
 * the pinned golden vector in contracts/test/GoldenPrograms.t.sol
 * (xycSwap=0x11, salt=0x14, flatFeeIn=0x15) and the InventorySkew tests
 * (0x22, appended by BacalhauOpcodes).
 *
 * NOTE: 1D strategies (limit orders, dutch auctions) run on a DIFFERENT
 * router with its own table (LimitOpcodes.sol). Out of scope for v1 — the
 * demo path is Aqua-backed AMM strategies. Do not guess those bytes; derive
 * them the same way when 1D blocks land.
 */
export const AQUA_OPCODES = {
  jump: 0x0a,
  jumpIfTokenIn: 0x0b,
  jumpIfTokenOut: 0x0c,
  deadline: 0x0d,
  onlyTakerTokenBalanceNonZero: 0x0e,
  onlyTakerTokenBalanceGte: 0x0f,
  onlyTakerTokenSupplyShareGte: 0x10,
  xycSwap: 0x11,
  xycConcentrateGrowLiquidity2D: 0x12,
  decay: 0x13,
  salt: 0x14,
  flatFeeAmountIn: 0x15,
  protocolFeeAmountIn: 0x1b,
  aquaProtocolFeeAmountIn: 0x1c,
  dynamicProtocolFeeAmountIn: 0x1d,
  aquaDynamicProtocolFeeAmountIn: 0x1e,
  peggedSwapGrowPriceRange2D: 0x1f,
  extruction: 0x20,
  onlyTxOriginTokenBalanceNonZero: 0x21,
  /** Bacalhau custom instruction, appended after the 34 stock opcodes. */
  inventorySkew: 0x22,
} as const;

/** Fee/skew basis: matches `BPS = 1e9` in swap-vm/src/instructions/Fee.sol. */
export const BPS = 1_000_000_000;

/** Builder-enforced cap in InventorySkewArgsBuilder (10% of BPS). */
export const MAX_SKEW_CAP = BPS / 10;
