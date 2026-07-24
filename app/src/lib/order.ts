/**
 * TS port of the swap-vm order/taker encodings for the cases Bacalhau uses.
 *
 * MakerTraitsLib.build (swap-vm/src/libs/MakerTraits.sol), Aqua mode with no
 * hooks and no receiver, collapses to:
 *   traits = USE_AQUA_INSTEAD_OF_SIGNATURE (1 << 254)   [all slice indexes 0]
 *   data   = program bytecode
 *
 * TakerTraitsLib.build (swap-vm/src/libs/TakerTraits.sol) with no threshold,
 * recipient, deadline, hook or callback data collapses to a 22-byte header:
 *   [slicesIndexes: uint160 = 0][flags: uint16]
 */

import {
  decodeAbiParameters,
  encodeAbiParameters,
  keccak256,
  type Address,
  type Hex,
} from "viem";

export const USE_AQUA_TRAIT = 1n << 254n;

export interface Order {
  maker: Address;
  traits: bigint;
  data: Hex;
}

export const ORDER_ABI = [
  {
    type: "tuple",
    components: [
      { name: "maker", type: "address" },
      { name: "traits", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
  },
] as const;

/** Aqua-backed order: funds come from Aqua balances, no signature needed. */
export function buildAquaOrder(maker: Address, program: Hex): Order {
  return { maker, traits: USE_AQUA_TRAIT, data: program };
}

/** `abi.encode(order)` — what Aqua.ship() stores and hashes. */
export function encodeOrder(order: Order): Hex {
  return encodeAbiParameters(ORDER_ABI, [order]);
}

/** Aqua strategies: strategyHash == keccak256(abi.encode(order)). */
export function orderHash(order: Order): Hex {
  return keccak256(encodeOrder(order));
}

/** Decode the `strategy` bytes carried by Aqua's Shipped event. */
export function decodeOrder(strategy: Hex): Order {
  const [o] = decodeAbiParameters(ORDER_ABI, strategy);
  return { maker: o.maker, traits: o.traits, data: o.data };
}

// ---------- taker side ----------

const IS_EXACT_IN = 0x0001;
const HAS_PRE_TRANSFER_IN_CALLBACK = 0x0004;

/**
 * Minimal taker data used by the demo taker (MockTaker):
 * exact-in/out + pre-transfer-in callback (pushes tokenIn into Aqua),
 * every variable-length slice empty.
 */
export function takerData(isExactIn: boolean): Hex {
  const flags = (isExactIn ? IS_EXACT_IN : 0) | HAS_PRE_TRANSFER_IN_CALLBACK;
  return `0x${"00".repeat(20)}${flags.toString(16).padStart(4, "0")}` as Hex;
}
