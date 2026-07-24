import { describe, expect, it } from "vitest";

import { compile, validate, type Block } from "./compile";
import { BPS, MAX_SKEW_CAP } from "./opcodes";

/**
 * Golden vector pinned in contracts/test/GoldenPrograms.t.sol
 * (test_PassiveAmm_GoldenBytes). Byte-identical output is the contract
 * between this compiler and the on-chain Solidity builders.
 */
const PASSIVE_AMM_GOLDEN =
  "0x1504002dc6c0110014200cf8ae082572c3264391ea8f6c9b5017997876cd451b56941ef59da3b3b87bac";

/** keccak256("bacalhau.golden.v1") — the salt used by the Solidity twin. */
const GOLDEN_SALT = 0x0cf8ae082572c3264391ea8f6c9b5017997876cd451b56941ef59da3b3b87bacn;

const FEE_030 = (3 * BPS) / 1000; // 0.3% on the 1e9 base

describe("golden vectors (must match Solidity builders byte for byte)", () => {
  it("passive AMM template reproduces the pinned on-chain vector", () => {
    const blocks: Block[] = [
      { kind: "constantProduct" },
      { kind: "flatFee", feeBps: FEE_030 },
    ];
    const { bytecode } = compile(blocks, { salt: GOLDEN_SALT });
    expect(bytecode).toBe(PASSIVE_AMM_GOLDEN);
  });

  it("canvas order does not matter: emission order is canonical", () => {
    const shuffled: Block[] = [
      { kind: "flatFee", feeBps: FEE_030 },
      { kind: "constantProduct" },
    ];
    expect(compile(shuffled, { salt: GOLDEN_SALT }).bytecode).toBe(PASSIVE_AMM_GOLDEN);
  });
});

describe("self-balancing MM template (InventorySkew encoding)", () => {
  it("encodes skew args as target0 | target1 | maxSkewBps", () => {
    const blocks: Block[] = [
      { kind: "constantProduct" },
      {
        kind: "inventorySkew",
        target0: 1000n * 10n ** 18n,
        target1: 1000n * 10n ** 18n,
        maxSkewBps: BPS / 20, // 5%, as in contracts/test/InventorySkew.t.sol
      },
    ];
    const { bytecode } = compile(blocks, { salt: 1n });
    const target = "000000000000003635c9adc5dea00000"; // 1000e18 as uint128 BE
    expect(bytecode).toBe(
      "0x" +
        "2224" + // inventorySkew opcode, 36-byte args
        target + // target0
        target + // target1
        "02faf080" + // maxSkew = 5e7 (5% of 1e9)
        "1100" + // xycSwap, no args
        "1420" + "1".padStart(64, "0"), // salt = 1 as uint256
    );
  });
});

describe("validation", () => {
  it("rejects a pipeline without a pricing block", () => {
    expect(validate([{ kind: "flatFee", feeBps: FEE_030 }])).not.toHaveLength(0);
    expect(() => compile([{ kind: "flatFee", feeBps: FEE_030 }])).toThrow(/pricing/);
  });

  it("rejects skew above the builder cap", () => {
    const blocks: Block[] = [
      { kind: "constantProduct" },
      { kind: "inventorySkew", target0: 1n, target1: 1n, maxSkewBps: MAX_SKEW_CAP + 1 },
    ];
    expect(() => compile(blocks)).toThrow(/cap/);
  });

  it("rejects duplicate deadline", () => {
    const blocks: Block[] = [
      { kind: "constantProduct" },
      { kind: "deadline", timestamp: 2_000_000_000 },
      { kind: "deadline", timestamp: 2_000_000_001 },
    ];
    expect(() => compile(blocks)).toThrow(/duplicate/);
  });

  it("adds a random salt when none is provided (unique strategies)", () => {
    const blocks: Block[] = [{ kind: "constantProduct" }];
    expect(compile(blocks).bytecode).not.toBe(compile(blocks).bytecode);
  });
});
