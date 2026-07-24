/**
 * Canvas pipeline -> SwapVM bytecode (Aqua-backed router).
 *
 * The canvas gives users freedom inside UI zones (docs/03, 05); THIS module
 * owns the canonical, security-audited emission order (docs/09). The same
 * block table drives both validation errors for the UI and byte emission,
 * so a pipeline that validates always compiles to the audited sequence.
 */

import { AQUA_OPCODES, BPS, MAX_SKEW_CAP } from "./opcodes";
import { concatBytes, instruction, toHex, uintBE } from "./encode";

// ---------- Block model (mirrors docs/05 for the Aqua-backed D1 set) ----------

export type Block =
  | { kind: "constantProduct" } // pricing: Aqua supplies balances at ship()
  | { kind: "inventorySkew"; target0: bigint; target1: bigint; maxSkewBps: number }
  | { kind: "flatFee"; feeBps: number } // on the 1e9 BPS base, charged on input
  | { kind: "deadline"; timestamp: number } // unix seconds
  | { kind: "takerGate"; token: `0x${string}` } // taker must hold the token
  | { kind: "salt"; value: bigint }; // uniqueness; auto-added if absent

export interface CompileResult {
  bytecode: `0x${string}`;
  bytes: Uint8Array;
}

export class PipelineError extends Error {
  constructor(
    readonly blockIndex: number | null,
    message: string,
  ) {
    super(message);
  }
}

// ---------- Validation (single source of truth for UI hints too) ----------

export function validate(blocks: Block[]): PipelineError[] {
  const errors: PipelineError[] = [];
  const count = (kind: Block["kind"]) => blocks.filter((b) => b.kind === kind).length;

  if (count("constantProduct") !== 1) {
    errors.push(new PipelineError(null, "exactly one pricing block is required"));
  }
  for (const [i, b] of blocks.entries()) {
    switch (b.kind) {
      case "flatFee":
        if (b.feeBps < 0 || b.feeBps > BPS) {
          errors.push(new PipelineError(i, `fee out of range: ${b.feeBps} (base 1e9)`));
        }
        break;
      case "inventorySkew":
        if (b.target0 <= 0n || b.target1 <= 0n) {
          errors.push(new PipelineError(i, "skew targets must be positive"));
        }
        if (b.maxSkewBps < 0 || b.maxSkewBps > MAX_SKEW_CAP) {
          errors.push(new PipelineError(i, `maxSkew above cap: ${b.maxSkewBps} > ${MAX_SKEW_CAP}`));
        }
        break;
      case "deadline":
        if (!Number.isInteger(b.timestamp) || b.timestamp <= 0 || b.timestamp >= 2 ** 40) {
          errors.push(new PipelineError(i, "deadline must be a unix timestamp fitting uint40"));
        }
        break;
    }
  }
  const dupes = (["inventorySkew", "deadline", "salt"] as const).filter((k) => count(k) > 1);
  for (const k of dupes) errors.push(new PipelineError(null, `duplicate block: ${k}`));
  return errors;
}

// ---------- Emission ----------

/**
 * Canonical order for Aqua-backed AMM programs, mirroring the official
 * builders (AquaStrategyBuilders.buildProgram: fees/modifiers BEFORE the
 * core swap, salt last) and our audited templates:
 *
 *   gates -> deadline -> inventorySkew -> flatFee -> xycSwap -> salt
 */
const EMISSION_ORDER: Block["kind"][] = [
  "takerGate",
  "deadline",
  "inventorySkew",
  "flatFee",
  "constantProduct",
  "salt",
];

function emit(block: Block): Uint8Array {
  switch (block.kind) {
    case "constantProduct":
      return instruction(AQUA_OPCODES.xycSwap);
    case "flatFee":
      return instruction(AQUA_OPCODES.flatFeeAmountIn, uintBE(BigInt(block.feeBps), 4));
    case "inventorySkew":
      return instruction(
        AQUA_OPCODES.inventorySkew,
        concatBytes(
          uintBE(block.target0, 16),
          uintBE(block.target1, 16),
          uintBE(BigInt(block.maxSkewBps), 4),
        ),
      );
    case "deadline":
      return instruction(AQUA_OPCODES.deadline, uintBE(BigInt(block.timestamp), 5));
    case "takerGate": {
      const raw = block.token.slice(2);
      if (raw.length !== 40) throw new PipelineError(null, `invalid token address: ${block.token}`);
      return instruction(AQUA_OPCODES.onlyTakerTokenBalanceNonZero, uintBE(BigInt(block.token), 20));
    }
    case "salt":
      return instruction(AQUA_OPCODES.salt, uintBE(block.value, 32));
  }
}

export function compile(blocks: Block[], options?: { salt?: bigint }): CompileResult {
  const errors = validate(blocks);
  if (errors.length > 0) throw errors[0];

  const withSalt = blocks.some((b) => b.kind === "salt")
    ? blocks
    : [...blocks, { kind: "salt", value: options?.salt ?? randomSalt() } satisfies Block];

  const ordered = EMISSION_ORDER.flatMap((kind) => withSalt.filter((b) => b.kind === kind));
  const bytes = concatBytes(...ordered.map(emit));
  return { bytes, bytecode: toHex(bytes) };
}

function randomSalt(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
}
