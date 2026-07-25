import { afterEach, describe, expect, it, vi } from "vitest";
import { keccak256, toBytes } from "viem";

import {
  compile,
  resolvePath,
  validate,
  GraphError,
  type Edge,
  type GraphNode,
  type StrategyGraph,
} from "./graph";
import { AQUA_OPCODES, BPS, MAX_SKEW_CAP } from "./opcodes";

/**
 * The compiler mints programs that move real funds, so these tests defend the
 * two properties the module docstring promises — jump targets always land on
 * an instruction boundary, and the audited pre-swap order holds on every path
 * — plus byte-compatibility with the Solidity golden fixture.
 *
 * Programs are checked by *decoding and running* them the way the VM does
 * (read opcode, read length, skip the args), never by matching the emitter's
 * internal layout choices.
 */

// ---------- program decoding: the VM's own view of the bytes ----------

interface Instruction {
  pc: number;
  op: number;
  args: Uint8Array;
}

/** Ops whose last two argument bytes are an absolute jump target. */
const JUMPING_OPS = new Set<number>([
  AQUA_OPCODES.jump,
  AQUA_OPCODES.jumpIfTokenIn,
  AQUA_OPCODES.inventoryBranch,
]);

const HEX_DIGITS = "0123456789abcdef";

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += HEX_DIGITS[b >> 4]! + HEX_DIGITS[b & 0x0f]!;
  return out;
}

function beHex(value: bigint, width: number): string {
  const out = value.toString(16).padStart(width * 2, "0");
  if (out.length !== width * 2) throw new Error(`${value} does not fit in ${width} bytes`);
  return out;
}

/** Split a program the way `VM.runLoop` does; throws if a length runs off the end. */
function decodeProgram(bytes: Uint8Array): Instruction[] {
  const instructions: Instruction[] = [];
  let pc = 0;
  while (pc < bytes.length) {
    if (pc + 2 > bytes.length) throw new Error(`instruction header at ${pc} is truncated`);
    const end = pc + 2 + bytes[pc + 1]!;
    if (end > bytes.length) {
      throw new Error(`args of the instruction at ${pc} run ${end - bytes.length} bytes past the end`);
    }
    instructions.push({ pc, op: bytes[pc]!, args: bytes.subarray(pc + 2, end) });
    pc = end;
  }
  return instructions;
}

function targetOf(instruction: Instruction): number {
  const { args } = instruction;
  return (args[args.length - 2]! << 8) | args[args.length - 1]!;
}

/**
 * Identity of an instruction, ignoring any encoded jump target: enough to say
 * "this is the instruction node X asked for" without knowing where it landed.
 */
function signatureOf(instruction: Instruction): string {
  const { op, args } = instruction;
  const payload = JUMPING_OPS.has(op) ? args.subarray(0, args.length - 2) : args;
  return `${op}:${hex(payload)}`;
}

/** The same identity, derived from the graph model instead of the bytes. */
function signatureOfNode(node: GraphNode): string {
  switch (node.kind) {
    case "constantProduct":
      return `${AQUA_OPCODES.xycSwap}:`;
    case "priceRange":
      return `${AQUA_OPCODES.xycConcentrateGrowLiquidity2D}:${beHex(node.sqrtPriceMinX18, 32)}${beHex(node.sqrtPriceMaxX18, 32)}`;
    case "inventorySkew":
      return `${AQUA_OPCODES.inventorySkew}:${beHex(node.target0, 16)}${beHex(node.target1, 16)}${beHex(BigInt(node.maxSkewBps), 4)}`;
    case "flowDecay":
      return `${AQUA_OPCODES.decay}:${beHex(BigInt(node.periodSeconds), 2)}`;
    case "flatFee":
      return `${AQUA_OPCODES.flatFeeAmountIn}:${beHex(BigInt(node.feeBps), 4)}`;
    case "deadline":
      return `${AQUA_OPCODES.deadline}:${beHex(BigInt(node.timestamp), 5)}`;
    case "holderGate":
      return `${AQUA_OPCODES.onlyTakerTokenBalanceGte}:${beHex(BigInt(node.token), 20)}${beHex(node.minBalance, 32)}`;
    case "ifDirection":
      return `${AQUA_OPCODES.jumpIfTokenIn}:${beHex(BigInt(node.token), 20)}`;
    case "ifInventoryAbove":
      return `${AQUA_OPCODES.inventoryBranch}:${beHex(node.target0, 16)}${beHex(node.target1, 16)}`;
  }
}

/**
 * Every jump target in the program must be the first byte of an instruction.
 * A target one byte off would make the VM execute argument bytes as opcodes.
 */
function expectJumpTargetsToBeInstructionBoundaries(bytes: Uint8Array, context = ""): Instruction[] {
  const instructions = decodeProgram(bytes);
  const boundaries = new Set(instructions.map((i) => i.pc));
  for (const instruction of instructions.filter((i) => JUMPING_OPS.has(i.op))) {
    const target = targetOf(instruction);
    expect(
      boundaries.has(target),
      `${context}jump at pc ${instruction.pc} (op 0x${instruction.op.toString(16)}) targets ${target}, ` +
        `which is not an instruction boundary; boundaries are [${[...boundaries].join(", ")}]`,
    ).toBe(true);
  }
  return instructions;
}

/** Run the program, resolving each conditional with `takeBranch`. */
function runProgram(bytes: Uint8Array, takeBranch: (i: Instruction) => boolean): Instruction[] {
  const byPc = new Map(decodeProgram(bytes).map((i) => [i.pc, i]));
  const trace: Instruction[] = [];
  let pc = 0;
  while (pc < bytes.length) {
    const instruction = byPc.get(pc);
    if (!instruction) throw new Error(`the VM landed at ${pc}, inside another instruction's arguments`);
    if (trace.length > byPc.size) throw new Error("the program does not terminate");
    trace.push(instruction);
    if (
      instruction.op === AQUA_OPCODES.jump ||
      (JUMPING_OPS.has(instruction.op) && takeBranch(instruction))
    ) {
      pc = targetOf(instruction);
      continue;
    }
    pc = instruction.pc + 2 + instruction.args.length;
  }
  return trace;
}

/** The nodes a taker walks through, given how each branch resolves. */
function pathThroughGraph(graph: StrategyGraph, taken: Record<string, boolean>): GraphNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const hasIncoming = new Set(graph.edges.map((e) => e.to));
  let current = graph.nodes.find((n) => !hasIncoming.has(n.id))!.id;
  const path: GraphNode[] = [];
  for (let steps = 0; steps <= graph.nodes.length; steps++) {
    path.push(byId.get(current)!);
    const out = graph.edges.filter((e) => e.from === current);
    const ports = out.filter((e) => e.port !== undefined);
    const edge = ports.length > 0 ? ports.find((e) => e.port === (taken[current] ? "then" : "else")) : out[0];
    if (!edge) return path;
    current = edge.to;
  }
  throw new Error("the graph walk did not terminate");
}

/**
 * The instructions a taker actually executes, minus the assembler's own
 * bookkeeping (unconditional jumps and the trailing salt).
 */
function executedNodes(bytes: Uint8Array, taken: Record<string, boolean>, branchOwner: Map<string, string>): string[] {
  const trace = runProgram(bytes, (i) => {
    const owner = branchOwner.get(signatureOf(i));
    if (owner === undefined) throw new Error(`no graph node matches the branch at pc ${i.pc}`);
    return taken[owner] ?? false;
  });
  expect(trace.at(-1)?.op, "every path must fall through to the trailing salt").toBe(AQUA_OPCODES.salt);
  return trace
    .filter((i) => i.op !== AQUA_OPCODES.jump && i.op !== AQUA_OPCODES.salt)
    .map(signatureOf);
}

function branchOwners(graph: StrategyGraph): Map<string, string> {
  return new Map(
    graph.nodes
      .filter((n) => n.kind === "ifDirection" || n.kind === "ifInventoryAbove")
      .map((n) => [signatureOfNode(n), n.id]),
  );
}

// ---------- fixtures ----------

const TOKEN_A = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const TOKEN_B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

/** keccak256("bacalhau.golden.v1"), the salt the Solidity twin pins. */
const GOLDEN_SALT = BigInt(keccak256(toBytes("bacalhau.golden.v1")));

/**
 * contracts/test/GoldenPrograms.t.sol:46 (test_PassiveAmm_GoldenBytes).
 * flatFeeAmountIn(3e6) | xycSwap | salt(32). Byte-identical output is the
 * contract between this compiler and the audited on-chain builders.
 */
const PASSIVE_AMM_GOLDEN =
  "0x1504002dc6c0110014200cf8ae082572c3264391ea8f6c9b5017997876cd451b56941ef59da3b3b87bac";

const FEE_030 = (3 * BPS) / 1000; // 0.3% on the 1e9 base

const swapOnly: StrategyGraph = { nodes: [{ id: "swap", kind: "constantProduct" }], edges: [] };

/** `node -> constantProduct`: the smallest graph that puts `node` in a program. */
function beforeSwap(node: GraphNode): StrategyGraph {
  return {
    nodes: [node, { id: "swap", kind: "constantProduct" }],
    edges: [{ from: node.id, to: "swap" }],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------- 1. backward compatibility ----------

describe("golden vector (byte-identical to the audited Solidity fixture)", () => {
  it("flatFee -> constantProduct reproduces the pinned on-chain program", () => {
    const graph: StrategyGraph = {
      nodes: [
        { id: "fee", kind: "flatFee", feeBps: FEE_030 },
        { id: "swap", kind: "constantProduct" },
      ],
      edges: [{ from: "fee", to: "swap" }],
    };
    expect(compile(graph, { salt: GOLDEN_SALT }).bytecode).toBe(PASSIVE_AMM_GOLDEN);
  });
});

// ---------- 2. jump-target safety ----------

/**
 * gate -> inv ?then: hot -> skew -> swap
 *            ?else: dir ?then: cold -> swap
 *                       ?else: decay -> range -> swap
 */
const nestedBranches: StrategyGraph = {
  nodes: [
    { id: "expiry", kind: "deadline", timestamp: 2_000_000_000 },
    { id: "gate", kind: "holderGate", token: TOKEN_B, minBalance: 5n * 10n ** 18n },
    { id: "inv", kind: "ifInventoryAbove", target0: 1000n * 10n ** 18n, target1: 2000n * 10n ** 18n },
    { id: "hot", kind: "flatFee", feeBps: 1_000_000 },
    { id: "skew", kind: "inventorySkew", target0: 7n, target1: 11n, maxSkewBps: 50_000_000 },
    { id: "dir", kind: "ifDirection", token: TOKEN_A },
    { id: "cold", kind: "flatFee", feeBps: 5_000_000 },
    { id: "decay", kind: "flowDecay", periodSeconds: 300 },
    { id: "range", kind: "priceRange", sqrtPriceMinX18: 10n ** 18n, sqrtPriceMaxX18: 4n * 10n ** 18n },
    { id: "swap", kind: "constantProduct" },
  ],
  edges: [
    { from: "expiry", to: "gate" },
    { from: "gate", to: "inv" },
    { from: "inv", to: "hot", port: "then" },
    { from: "inv", to: "dir", port: "else" },
    { from: "hot", to: "skew" },
    { from: "skew", to: "swap" },
    { from: "dir", to: "cold", port: "then" },
    { from: "dir", to: "decay", port: "else" },
    { from: "cold", to: "swap" },
    { from: "decay", to: "range" },
    { from: "range", to: "swap" },
  ],
};

describe("jump-target safety (a target inside an instruction's args would execute data as code)", () => {
  it("every jump target in a nested-branch program is an instruction boundary", () => {
    const { bytes } = compile(nestedBranches, { salt: 1n });
    const instructions = expectJumpTargetsToBeInstructionBoundaries(bytes);
    // Guard against a vacuous pass: the program really does contain jumps.
    expect(instructions.filter((i) => JUMPING_OPS.has(i.op)).length).toBeGreaterThanOrEqual(4);
  });

  it("each conditional jumps to the instruction its 'then' node compiles to", () => {
    const byId = new Map(nestedBranches.nodes.map((n) => [n.id, n]));
    const { bytes } = compile(nestedBranches, { salt: 1n });
    const instructions = decodeProgram(bytes);
    const at = new Map(instructions.map((i) => [i.pc, i]));

    for (const [branchId, thenId] of [
      ["inv", "hot"],
      ["dir", "cold"],
    ] as const) {
      const conditional = instructions.find((i) => signatureOf(i) === signatureOfNode(byId.get(branchId)!));
      expect(conditional, `no instruction emitted for ${branchId}`).toBeDefined();
      const landed = at.get(targetOf(conditional!));
      expect(landed, `${branchId} jumps into the middle of an instruction`).toBeDefined();
      expect(signatureOf(landed!)).toBe(signatureOfNode(byId.get(thenId)!));
    }
  });

  const PATHS: { name: string; taken: Record<string, boolean>; expected: string[] }[] = [
    {
      name: "inventory above target",
      taken: { inv: true },
      expected: ["expiry", "gate", "inv", "hot", "skew", "swap"],
    },
    {
      name: "inventory below, taker pays token A",
      taken: { inv: false, dir: true },
      expected: ["expiry", "gate", "inv", "dir", "cold", "swap"],
    },
    {
      name: "inventory below, taker pays token B",
      taken: { inv: false, dir: false },
      expected: ["expiry", "gate", "inv", "dir", "decay", "range", "swap"],
    },
  ];

  it.each(PATHS)("running the program with $name executes exactly the nodes on that graph path", ({ taken, expected }) => {
    const byId = new Map(nestedBranches.nodes.map((n) => [n.id, n]));
    const { bytes } = compile(nestedBranches, { salt: 1n });
    expect(executedNodes(bytes, taken, branchOwners(nestedBranches))).toEqual(
      expected.map((id) => signatureOfNode(byId.get(id)!)),
    );
  });

  it("the graph walk and the program agree on every path (200 seeded random graphs)", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const random = mulberry32(seed);
      const graph = randomPreSwapGraph(random);
      const where = `seed ${seed}: ${JSON.stringify(graph, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))}\n`;

      expect(validate(graph).map((e) => e.message), `${where}generator produced an invalid graph`).toEqual([]);
      const { bytes } = compile(graph, { salt: 1n });
      expectJumpTargetsToBeInstructionBoundaries(bytes, where);

      const owners = branchOwners(graph);
      for (let attempt = 0; attempt < 4; attempt++) {
        const taken = Object.fromEntries([...owners.values()].map((id) => [id, random() < 0.5]));
        expect(executedNodes(bytes, taken, owners), `${where}decisions ${JSON.stringify(taken)}`).toEqual(
          pathThroughGraph(graph, taken).map(signatureOfNode),
        );
      }
    }
  });
});

// ---------- 3. fork layout ----------

/** dir ?then: cheap -> swap ; ?else: dear -> swap */
const asymmetricFork: StrategyGraph = {
  nodes: [
    { id: "dir", kind: "ifDirection", token: TOKEN_A },
    { id: "cheap", kind: "flatFee", feeBps: 500_000 },
    { id: "dear", kind: "flatFee", feeBps: 20_000_000 },
    { id: "swap", kind: "constantProduct" },
  ],
  edges: [
    { from: "dir", to: "cheap", port: "then" },
    { from: "dir", to: "dear", port: "else" },
    { from: "cheap", to: "swap" },
    { from: "dear", to: "swap" },
  ],
};

describe("fork layout (both legs reachable, distinct, and the join is not duplicated)", () => {
  it("each leg charges its own fee and neither leg sees the other's", () => {
    const { bytes } = compile(asymmetricFork, { salt: 1n });
    const owners = branchOwners(asymmetricFork);
    const cheap = signatureOfNode(asymmetricFork.nodes[1]!);
    const dear = signatureOfNode(asymmetricFork.nodes[2]!);

    const thenLeg = executedNodes(bytes, { dir: true }, owners);
    const elseLeg = executedNodes(bytes, { dir: false }, owners);

    expect(thenLeg).toContain(cheap);
    expect(thenLeg).not.toContain(dear);
    expect(elseLeg).toContain(dear);
    expect(elseLeg).not.toContain(cheap);
  });

  it("the 'else' leg is the instruction right after the branch, with no jump in between", () => {
    const { bytes } = compile(asymmetricFork, { salt: 1n });
    const instructions = decodeProgram(bytes);
    const conditional = instructions.findIndex((i) => i.op === AQUA_OPCODES.jumpIfTokenIn);
    expect(conditional).toBeGreaterThanOrEqual(0);
    expect(signatureOf(instructions[conditional + 1]!)).toBe(signatureOfNode(asymmetricFork.nodes[2]!));
  });

  it("a join reached by both legs is emitted once, not copied into each leg", () => {
    const { bytes } = compile(asymmetricFork, { salt: 1n });
    const swaps = decodeProgram(bytes).filter((i) => i.op === AQUA_OPCODES.xycSwap);
    expect(swaps).toHaveLength(1);
  });
});

// ---------- the canvas preview must be the leg the VM will run ----------

/** Resolve a conditional from its own encoded args, as InventoryBranch.sol does. */
function branchTakenByVm(instruction: Instruction, trade: Trade): boolean {
  if (instruction.op === AQUA_OPCODES.jumpIfTokenIn) {
    return hex(instruction.args.subarray(0, 20)) === trade.tokenIn.slice(2).toLowerCase();
  }
  const toBigInt = (b: Uint8Array) => b.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
  const target0 = toBigInt(instruction.args.subarray(0, 16));
  const target1 = toBigInt(instruction.args.subarray(16, 32));
  // balance0 / balance1 > target0 / target1, cross-multiplied.
  return trade.balance0 * target1 > trade.balance1 * target0;
}

interface Trade {
  tokenIn: `0x${string}`;
  balance0: bigint;
  balance1: bigint;
}

const TRADES: { name: string; trade: Trade; expected: string[] }[] = [
  {
    name: "inventory above the 1000:2000 split",
    trade: { tokenIn: TOKEN_A, balance0: 900n * 10n ** 18n, balance1: 1000n * 10n ** 18n },
    expected: ["expiry", "gate", "inv", "hot", "skew", "swap"],
  },
  {
    name: "inventory below the split, taker paying the branch token in",
    trade: { tokenIn: TOKEN_A, balance0: 100n * 10n ** 18n, balance1: 5000n * 10n ** 18n },
    expected: ["expiry", "gate", "inv", "dir", "cold", "swap"],
  },
  {
    name: "inventory below the split, taker paying the other token in",
    trade: { tokenIn: TOKEN_B, balance0: 100n * 10n ** 18n, balance1: 5000n * 10n ** 18n },
    expected: ["expiry", "gate", "inv", "dir", "decay", "range", "swap"],
  },
];

describe("resolvePath (what the canvas previews must be what the program runs)", () => {
  it.each(TRADES)("previews the leg taken with $name", ({ trade, expected }) => {
    expect(resolvePath(nestedBranches, trade).map((n) => n.id)).toEqual(expected);
  });

  it.each(TRADES)("the compiled program executes exactly that leg with $name", ({ trade }) => {
    const { bytes } = compile(nestedBranches, { salt: 1n });
    const executed = runProgram(bytes, (i) => branchTakenByVm(i, trade))
      .filter((i) => i.op !== AQUA_OPCODES.jump && i.op !== AQUA_OPCODES.salt)
      .map(signatureOf);
    expect(executed).toEqual(resolvePath(nestedBranches, trade).map(signatureOfNode));
  });

  it("holding exactly the target split does not count as being above it", () => {
    const atTarget: Trade = { tokenIn: TOKEN_B, balance0: 1000n * 10n ** 18n, balance1: 2000n * 10n ** 18n };
    const oneWeiAbove: Trade = { ...atTarget, balance0: atTarget.balance0 + 1n };

    expect(resolvePath(nestedBranches, atTarget).map((n) => n.id)).toEqual([
      "expiry",
      "gate",
      "inv",
      "dir",
      "decay",
      "range",
      "swap",
    ]);
    expect(resolvePath(nestedBranches, oneWeiAbove).map((n) => n.id)).toEqual([
      "expiry",
      "gate",
      "inv",
      "hot",
      "skew",
      "swap",
    ]);
  });
});

// ---------- 4. validation ----------

const cyclic: StrategyGraph = {
  nodes: [
    { id: "fee", kind: "flatFee", feeBps: 1_000 },
    { id: "gate", kind: "holderGate", token: TOKEN_A, minBalance: 1n },
    { id: "swap", kind: "constantProduct" },
  ],
  edges: [
    { from: "fee", to: "gate" },
    { from: "gate", to: "swap" },
    { from: "swap", to: "gate" },
  ],
};

const REJECTED: { name: string; graph: StrategyGraph; nodeId: string | null; match: RegExp }[] = [
  { name: "an empty canvas", graph: { nodes: [], edges: [] }, nodeId: null, match: /empty/i },
  { name: "a cycle reachable from the entry", graph: cyclic, nodeId: null, match: /cycle/i },
  {
    name: "zero entry nodes (everything is a jump target)",
    graph: {
      nodes: [
        { id: "fee", kind: "flatFee", feeBps: 1_000 },
        { id: "swap", kind: "constantProduct" },
      ],
      edges: [
        { from: "fee", to: "swap" },
        { from: "swap", to: "fee" },
      ],
    },
    nodeId: null,
    match: /no entry node/i,
  },
  {
    name: "two entry nodes",
    graph: {
      nodes: [
        { id: "feeA", kind: "flatFee", feeBps: 1_000 },
        { id: "feeB", kind: "flatFee", feeBps: 2_000 },
        { id: "swap", kind: "constantProduct" },
      ],
      edges: [
        { from: "feeA", to: "swap" },
        { from: "feeB", to: "swap" },
      ],
    },
    nodeId: null,
    match: /2 entry nodes/i,
  },
  {
    name: "a node unreachable from the entry",
    graph: {
      nodes: [
        { id: "swap", kind: "constantProduct" },
        { id: "orphanA", kind: "flatFee", feeBps: 1_000 },
        { id: "orphanB", kind: "flatFee", feeBps: 2_000 },
      ],
      // The orphans point at each other, so `swap` is still the only entry.
      edges: [
        { from: "orphanA", to: "orphanB" },
        { from: "orphanB", to: "orphanA" },
      ],
    },
    nodeId: "orphanA",
    match: /unreachable/i,
  },
  {
    name: "a path that never prices",
    graph: { nodes: [{ id: "fee", kind: "flatFee", feeBps: 1_000 }], edges: [] },
    nodeId: "fee",
    match: /without a pricing block/i,
  },
  {
    name: "a path whose only price block is a priceRange (which cannot price on its own)",
    graph: {
      nodes: [{ id: "range", kind: "priceRange", sqrtPriceMinX18: 1n, sqrtPriceMaxX18: 2n }],
      edges: [],
    },
    nodeId: "range",
    match: /without a pricing block/i,
  },
  {
    name: "a path that prices twice",
    graph: {
      nodes: [
        { id: "swapA", kind: "constantProduct" },
        { id: "swapB", kind: "constantProduct" },
      ],
      edges: [{ from: "swapA", to: "swapB" }],
    },
    nodeId: "swapB",
    match: /price once per path/i,
  },
  {
    name: "a fee placed after the pricing block",
    graph: {
      nodes: [
        { id: "swap", kind: "constantProduct" },
        { id: "fee", kind: "flatFee", feeBps: 1_000 },
      ],
      edges: [{ from: "swap", to: "fee" }],
    },
    nodeId: "fee",
    match: /before the pricing block/i,
  },
  {
    name: "an Inventory Skew placed after the pricing block",
    graph: {
      nodes: [
        { id: "swap", kind: "constantProduct" },
        { id: "skew", kind: "inventorySkew", target0: 1n, target1: 1n, maxSkewBps: 1_000 },
      ],
      edges: [{ from: "swap", to: "skew" }],
    },
    nodeId: "skew",
    match: /before the pricing block/i,
  },
  {
    name: "a priceRange placed after the pricing block",
    graph: {
      nodes: [
        { id: "swap", kind: "constantProduct" },
        { id: "range", kind: "priceRange", sqrtPriceMinX18: 1n, sqrtPriceMaxX18: 2n },
      ],
      edges: [{ from: "swap", to: "range" }],
    },
    nodeId: "range",
    match: /before the pricing block/i,
  },
  {
    name: "an inventory branch reading balances an Inventory Skew already tilted",
    graph: {
      nodes: [
        { id: "skew", kind: "inventorySkew", target0: 1n, target1: 1n, maxSkewBps: 1_000 },
        { id: "inv", kind: "ifInventoryAbove", target0: 1n, target1: 1n },
        { id: "swapA", kind: "constantProduct" },
        { id: "swapB", kind: "constantProduct" },
      ],
      edges: [
        { from: "skew", to: "inv" },
        { from: "inv", to: "swapA", port: "then" },
        { from: "inv", to: "swapB", port: "else" },
      ],
    },
    nodeId: "inv",
    match: /move this branch before/i,
  },
  {
    name: "an inventory branch reading balances a Flow Decay already tilted",
    graph: {
      nodes: [
        { id: "decay", kind: "flowDecay", periodSeconds: 60 },
        { id: "inv", kind: "ifInventoryAbove", target0: 1n, target1: 1n },
        { id: "swapA", kind: "constantProduct" },
        { id: "swapB", kind: "constantProduct" },
      ],
      edges: [
        { from: "decay", to: "inv" },
        { from: "inv", to: "swapA", port: "then" },
        { from: "inv", to: "swapB", port: "else" },
      ],
    },
    nodeId: "inv",
    match: /move this branch before/i,
  },
  {
    name: "an inventory branch reading balances a priceRange already grew",
    graph: {
      nodes: [
        { id: "range", kind: "priceRange", sqrtPriceMinX18: 1n, sqrtPriceMaxX18: 2n },
        { id: "inv", kind: "ifInventoryAbove", target0: 1n, target1: 1n },
        { id: "swapA", kind: "constantProduct" },
        { id: "swapB", kind: "constantProduct" },
      ],
      edges: [
        { from: "range", to: "inv" },
        { from: "inv", to: "swapA", port: "then" },
        { from: "inv", to: "swapB", port: "else" },
      ],
    },
    nodeId: "inv",
    match: /move this branch before/i,
  },
  {
    name: "a branch missing one port",
    graph: {
      nodes: [
        { id: "dir", kind: "ifDirection", token: TOKEN_A },
        { id: "swap", kind: "constantProduct" },
      ],
      edges: [{ from: "dir", to: "swap", port: "then" }],
    },
    nodeId: "dir",
    match: /one 'then' and one 'else'/i,
  },
  {
    name: "a step with two outgoing edges",
    graph: {
      nodes: [
        { id: "fee", kind: "flatFee", feeBps: 1_000 },
        { id: "swapA", kind: "constantProduct" },
        { id: "swapB", kind: "constantProduct" },
      ],
      edges: [
        { from: "fee", to: "swapA" },
        { from: "fee", to: "swapB" },
      ],
    },
    nodeId: "fee",
    match: /only continue to one node/i,
  },
  {
    name: "a port-tagged edge leaving a step node",
    graph: {
      nodes: [
        { id: "fee", kind: "flatFee", feeBps: 1_000 },
        { id: "swap", kind: "constantProduct" },
      ],
      // reviveEdge accepts a port on any edge, so an LLM proposal can reach
      // this shape; compile() used to wire it as a half-formed branch and die
      // with an internal error instead of the GraphError validate() promises.
      edges: [{ from: "fee", to: "swap", port: "then" }],
    },
    nodeId: "fee",
    match: /only branches label their edges/i,
  },
  {
    name: "an edge pointing at a node that does not exist",
    graph: {
      nodes: [{ id: "swap", kind: "constantProduct" }],
      edges: [{ from: "swap", to: "ghost" }],
    },
    nodeId: null,
    match: /unknown node ghost/i,
  },
  {
    name: "a self-edge",
    graph: {
      nodes: [{ id: "swap", kind: "constantProduct" }],
      edges: [{ from: "swap", to: "swap" }],
    },
    nodeId: "swap",
    match: /cannot connect to itself/i,
  },
  {
    name: "duplicate node ids",
    graph: {
      nodes: [
        { id: "swap", kind: "constantProduct" },
        { id: "swap", kind: "flatFee", feeBps: 1_000 },
      ],
      edges: [],
    },
    nodeId: null,
    match: /duplicate node ids/i,
  },
];

describe("validation rejects unsafe graphs", () => {
  it.each(REJECTED)("rejects $name, blaming the right node", ({ graph, nodeId, match }) => {
    const errors = validate(graph);
    expect(errors.length, "the graph should have been rejected").toBeGreaterThan(0);
    const blamed = errors.find((e) => e.nodeId === nodeId);
    expect(blamed, `no error blamed ${nodeId}; got ${JSON.stringify(errors.map((e) => [e.nodeId, e.message]))}`)
      .toBeDefined();
    expect(blamed!.message).toMatch(match);
  });

  it.each(REJECTED)("compile() refuses $name with the same GraphError validate() reports", ({ graph }) => {
    const first = validate(graph)[0]!;
    let thrown: unknown;
    try {
      compile(graph, { salt: 1n });
    } catch (error) {
      thrown = error;
    }
    expect(thrown, "compile() accepted a graph validate() rejects").toBeInstanceOf(GraphError);
    expect((thrown as GraphError).message).toBe(first.message);
    expect((thrown as GraphError).nodeId).toBe(first.nodeId);
  });

  it("gives each class of unsafe graph its own message, so the canvas can explain the fix", () => {
    // Rows sharing a `match` are the same problem stated twice (e.g. three
    // ways to place a branch after a balance modifier); across classes the
    // messages must differ, or the badge cannot tell the user what to fix.
    const byClass = new Map<string, Set<string>>();
    for (const { graph, match } of REJECTED) {
      const message = validate(graph)[0]!.message;
      expect(message.length, "an empty message explains nothing").toBeGreaterThan(0);
      byClass.set(match.source, (byClass.get(match.source) ?? new Set()).add(message));
    }
    const messages = [...byClass.values()].flatMap((forClass) => [...forClass]);
    expect(new Set(messages).size, `two unrelated problems share a message: ${messages.join(" / ")}`).toBe(
      messages.length,
    );
  });

  it("accepts the shapes the canvas is meant to produce", () => {
    for (const graph of [swapOnly, asymmetricFork, nestedBranches]) {
      expect(validate(graph).map((e) => `${e.nodeId}: ${e.message}`)).toEqual([]);
    }
  });
});

// ---------- 5. parameter bounds ----------

const OUT_OF_BOUNDS: { name: string; node: GraphNode; match: RegExp }[] = [
  { name: "a fee above the 1e9 base", node: { id: "n", kind: "flatFee", feeBps: BPS + 1 }, match: /fee out of range/i },
  { name: "a negative fee", node: { id: "n", kind: "flatFee", feeBps: -1 }, match: /fee out of range/i },
  { name: "a fractional fee", node: { id: "n", kind: "flatFee", feeBps: 1.5 }, match: /fee out of range/i },
  {
    name: "a skew above the 10% cap",
    node: { id: "n", kind: "inventorySkew", target0: 1n, target1: 1n, maxSkewBps: MAX_SKEW_CAP + 1 },
    match: /cap/i,
  },
  {
    name: "a zero skew target",
    node: { id: "n", kind: "inventorySkew", target0: 0n, target1: 1n, maxSkewBps: 1_000 },
    match: /targets must be positive/i,
  },
  {
    name: "a negative skew target",
    node: { id: "n", kind: "inventorySkew", target0: 1n, target1: -1n, maxSkewBps: 1_000 },
    match: /targets must be positive/i,
  },
  {
    name: "a skew target past uint128",
    node: { id: "n", kind: "inventorySkew", target0: 1n << 128n, target1: 1n, maxSkewBps: 1_000 },
    match: /fit uint128/i,
  },
  {
    name: "a zero lower price bound",
    node: { id: "n", kind: "priceRange", sqrtPriceMinX18: 0n, sqrtPriceMaxX18: 10n },
    match: /lower price bound must be positive/i,
  },
  {
    name: "an inverted price range",
    node: { id: "n", kind: "priceRange", sqrtPriceMinX18: 10n, sqrtPriceMaxX18: 9n },
    match: /below the upper/i,
  },
  {
    name: "a degenerate (empty) price range",
    node: { id: "n", kind: "priceRange", sqrtPriceMinX18: 10n, sqrtPriceMaxX18: 10n },
    match: /below the upper/i,
  },
  {
    name: "an upper price bound past uint256",
    node: { id: "n", kind: "priceRange", sqrtPriceMinX18: 1n, sqrtPriceMaxX18: 1n << 256n },
    match: /fit uint256/i,
  },
  {
    name: "a decay period of zero",
    node: { id: "n", kind: "flowDecay", periodSeconds: 0 },
    match: /decay period/i,
  },
  {
    name: "a decay period past uint16",
    node: { id: "n", kind: "flowDecay", periodSeconds: 0x1_0000 },
    match: /decay period/i,
  },
  {
    name: "a deadline past uint40",
    node: { id: "n", kind: "deadline", timestamp: 2 ** 40 },
    match: /uint40/i,
  },
  { name: "a deadline of zero", node: { id: "n", kind: "deadline", timestamp: 0 }, match: /uint40/i },
  {
    name: "a truncated token address on a holder gate",
    node: { id: "n", kind: "holderGate", token: "0xdeadbeef", minBalance: 1n },
    match: /invalid token address/i,
  },
  {
    name: "a negative minimum balance",
    node: { id: "n", kind: "holderGate", token: TOKEN_A, minBalance: -1n },
    match: /minimum balance/i,
  },
  {
    name: "a minimum balance past uint256",
    node: { id: "n", kind: "holderGate", token: TOKEN_A, minBalance: 1n << 256n },
    match: /fit uint256/i,
  },
];

describe("parameter bounds (a value the instruction cannot hold must never reach the encoder)", () => {
  it.each(OUT_OF_BOUNDS)("rejects $name", ({ node, match }) => {
    const graph = beforeSwap(node);
    const blamed = validate(graph).filter((e) => e.nodeId === node.id);
    expect(blamed.length, "the offending node was not blamed").toBeGreaterThan(0);
    expect(blamed.map((e) => e.message).join(" | ")).toMatch(match);
    expect(() => compile(graph, { salt: 1n })).toThrow(GraphError);
  });

  it("rejects a malformed token address on a direction branch", () => {
    const graph: StrategyGraph = {
      nodes: [
        { id: "dir", kind: "ifDirection", token: "0xnothex" },
        { id: "swapA", kind: "constantProduct" },
        { id: "swapB", kind: "constantProduct" },
      ],
      edges: [
        { from: "dir", to: "swapA", port: "then" },
        { from: "dir", to: "swapB", port: "else" },
      ],
    };
    expect(validate(graph).map((e) => e.message)).toContain("invalid token address: 0xnothex");
  });

  it("rejects non-positive inventory-branch targets", () => {
    const graph: StrategyGraph = {
      nodes: [
        { id: "inv", kind: "ifInventoryAbove", target0: 1n, target1: 0n },
        { id: "swapA", kind: "constantProduct" },
        { id: "swapB", kind: "constantProduct" },
      ],
      edges: [
        { from: "inv", to: "swapA", port: "then" },
        { from: "inv", to: "swapB", port: "else" },
      ],
    };
    expect(validate(graph).map((e) => e.message)).toContain("branch targets must be positive");
  });

  it("rejects an inventory-branch target past uint128", () => {
    const graph: StrategyGraph = {
      nodes: [
        { id: "inv", kind: "ifInventoryAbove", target0: 1n << 128n, target1: 1n },
        { id: "swapA", kind: "constantProduct" },
        { id: "swapB", kind: "constantProduct" },
      ],
      edges: [
        { from: "inv", to: "swapA", port: "then" },
        { from: "inv", to: "swapB", port: "else" },
      ],
    };
    expect(validate(graph).map((e) => e.message)).toContain("branch targets must fit uint128 (16 bytes)");
    expect(() => compile(graph, { salt: 1n })).toThrow(GraphError);
  });

  it("accepts the exact upper bound of every capped field", () => {
    const atTheLimit: GraphNode[] = [
      { id: "n", kind: "flatFee", feeBps: BPS },
      { id: "n", kind: "inventorySkew", target0: (1n << 128n) - 1n, target1: (1n << 128n) - 1n, maxSkewBps: MAX_SKEW_CAP },
      { id: "n", kind: "flowDecay", periodSeconds: 0xffff },
      { id: "n", kind: "deadline", timestamp: 2 ** 40 - 1 },
      { id: "n", kind: "priceRange", sqrtPriceMinX18: 1n, sqrtPriceMaxX18: (1n << 256n) - 1n },
      { id: "n", kind: "holderGate", token: TOKEN_A, minBalance: (1n << 256n) - 1n },
    ];
    for (const node of atTheLimit) {
      expect(validate(beforeSwap(node)).map((e) => e.message), `${node.kind} at its limit`).toEqual([]);
    }
  });
});

// ---------- 6. encoding fidelity ----------

const ENCODINGS: { name: string; node: GraphNode; op: number; args: string }[] = [
  {
    name: "inventorySkew packs target0 (16) | target1 (16) | maxSkewBps (4)",
    node: {
      id: "n",
      kind: "inventorySkew",
      target0: (1n << 128n) - 1n, // full uint128 width
      target1: 1000n * 10n ** 18n,
      maxSkewBps: MAX_SKEW_CAP,
    },
    op: AQUA_OPCODES.inventorySkew,
    args: "ff".repeat(16) + "000000000000003635c9adc5dea00000" + "05f5e100",
  },
  {
    name: "priceRange packs sqrtPriceMin (32) | sqrtPriceMax (32)",
    node: {
      id: "n",
      kind: "priceRange",
      sqrtPriceMinX18: 10n ** 18n,
      sqrtPriceMaxX18: (1n << 256n) - 1n, // full uint256 width
    },
    op: AQUA_OPCODES.xycConcentrateGrowLiquidity2D,
    args: "0de0b6b3a7640000".padStart(64, "0") + "ff".repeat(32),
  },
  {
    name: "holderGate packs token (20) | minBalance (32)",
    node: { id: "n", kind: "holderGate", token: TOKEN_A, minBalance: (1n << 256n) - 1n },
    op: AQUA_OPCODES.onlyTakerTokenBalanceGte,
    args: "f39fd6e51aad88f6f4ce6ab8827279cfffb92266" + "ff".repeat(32),
  },
  {
    name: "flowDecay packs periodSeconds as uint16",
    node: { id: "n", kind: "flowDecay", periodSeconds: 0xffff },
    op: AQUA_OPCODES.decay,
    args: "ffff",
  },
  {
    name: "deadline packs the timestamp as uint40",
    node: { id: "n", kind: "deadline", timestamp: 2 ** 40 - 1 },
    op: AQUA_OPCODES.deadline,
    args: "ffffffffff",
  },
  {
    name: "flatFee packs the fee as uint32",
    node: { id: "n", kind: "flatFee", feeBps: BPS },
    op: AQUA_OPCODES.flatFeeAmountIn,
    args: "3b9aca00",
  },
  {
    name: "constantProduct takes no arguments",
    node: { id: "n", kind: "constantProduct" },
    op: AQUA_OPCODES.xycSwap,
    args: "",
  },
];

describe("instruction encoding (argument bytes, widths and order the VM reads)", () => {
  it.each(ENCODINGS)("$name", ({ node, op, args }) => {
    const graph: StrategyGraph =
      node.kind === "constantProduct" ? { nodes: [node], edges: [] } : beforeSwap(node);
    const [emitted] = decodeProgram(compile(graph, { salt: 1n }).bytes);

    expect(emitted!.op).toBe(op);
    expect(emitted!.args.length, "the declared length must match the argument width").toBe(args.length / 2);
    expect(hex(emitted!.args)).toBe(args);
  });

  /** Argument width each opcode's on-chain parser reads, in bytes. */
  const ARG_WIDTH = new Map<number, number>([
    [AQUA_OPCODES.jump, 2],
    [AQUA_OPCODES.jumpIfTokenIn, 22],
    [AQUA_OPCODES.deadline, 5],
    [AQUA_OPCODES.onlyTakerTokenBalanceGte, 52],
    [AQUA_OPCODES.xycSwap, 0],
    [AQUA_OPCODES.xycConcentrateGrowLiquidity2D, 64],
    [AQUA_OPCODES.decay, 2],
    [AQUA_OPCODES.salt, 32],
    [AQUA_OPCODES.flatFeeAmountIn, 4],
    [AQUA_OPCODES.inventorySkew, 36],
    [AQUA_OPCODES.inventoryBranch, 34],
  ]);

  it("declares the argument width its opcode's parser reads, for every instruction it emits", () => {
    const { bytes } = compile(nestedBranches, { salt: 1n });
    const instructions = decodeProgram(bytes);
    for (const { pc, op, args } of instructions) {
      const where = `opcode 0x${op.toString(16)} at pc ${pc}`;
      expect(ARG_WIDTH.has(op), `${where} is not an opcode this compiler should emit`).toBe(true);
      expect(args.length, where).toBe(ARG_WIDTH.get(op));
    }
    // The fixture covers every node kind, so this is not a one-opcode check.
    expect(new Set(instructions.map((i) => i.op)).size).toBe(ARG_WIDTH.size);
  });
});

// ---------- 7. determinism and salt ----------

describe("determinism and the trailing salt", () => {
  it("the same graph and pinned salt always produce the same bytes", () => {
    expect(compile(nestedBranches, { salt: GOLDEN_SALT }).bytecode).toBe(
      compile(nestedBranches, { salt: GOLDEN_SALT }).bytecode,
    );
  });

  it("reordering the nodes and edges a canvas stores does not change the program", () => {
    const shuffled: StrategyGraph = {
      nodes: [...nestedBranches.nodes].reverse(),
      edges: [...nestedBranches.edges].reverse(),
    };
    expect(compile(shuffled, { salt: GOLDEN_SALT }).bytecode).toBe(
      compile(nestedBranches, { salt: GOLDEN_SALT }).bytecode,
    );
  });

  it("the pinned salt is the last instruction, carrying all 32 bytes", () => {
    const salt = (1n << 255n) | 0x1234n; // exercises the top byte
    const instructions = decodeProgram(compile(nestedBranches, { salt }).bytes);
    const last = instructions.at(-1)!;
    expect(last.op).toBe(AQUA_OPCODES.salt);
    expect(hex(last.args)).toBe(beHex(salt, 32));
  });

  it("without a pinned salt the program is still well formed and only its salt differs", () => {
    let call = 0;
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(((array: Uint8Array) => {
      array.fill(++call);
      return array;
    }) as typeof crypto.getRandomValues);

    const first = compile(asymmetricFork).bytes;
    const second = compile(asymmetricFork).bytes;

    const body = first.length - 32;
    expect(hex(first.subarray(0, body))).toBe(hex(second.subarray(0, body)));
    expect(hex(first.subarray(body))).not.toBe(hex(second.subarray(body)));
    expectJumpTargetsToBeInstructionBoundaries(first);
    expect(decodeProgram(first).at(-1)!.op).toBe(AQUA_OPCODES.salt);
  });
});

// ---------- regressions ----------

describe("regressions", () => {
  /**
   * `swapOrderErrors` used to check only `after.max` at a terminal, so a fork
   * where one leg priced and the other did not passed validation: the `else`
   * taker got a program with no swap at all, and the `then` taker paid the fee
   * *after* the swap. Both bounds are checked now.
   */
  it("rejects a fork where only one leg prices", () => {
    const graph: StrategyGraph = {
      nodes: [
        { id: "dir", kind: "ifDirection", token: TOKEN_A },
        { id: "swap", kind: "constantProduct" },
        { id: "fee", kind: "flatFee", feeBps: 1_000 },
      ],
      edges: [
        { from: "dir", to: "swap", port: "then" },
        { from: "dir", to: "fee", port: "else" },
        { from: "swap", to: "fee" },
      ],
    };
    expect(validate(graph)).not.toHaveLength(0);
  });

  /**
   * `"tail"` used to double as the sentinel for "end of program" in the offset
   * map, so a node the user happened to call `tail` had its offset overwritten
   * and every jump aimed at it silently retargeted to the salt. The sentinel is
   * a symbol now.
   */
  it("does not let a node called 'tail' steal the end-of-program label", () => {
    const graph: StrategyGraph = {
      nodes: [
        { id: "dir", kind: "ifDirection", token: TOKEN_A },
        { id: "tail", kind: "flatFee", feeBps: 1_000 },
        { id: "other", kind: "flatFee", feeBps: 2_000 },
        { id: "swap", kind: "constantProduct" },
      ],
      edges: [
        { from: "dir", to: "tail", port: "then" },
        { from: "dir", to: "other", port: "else" },
        { from: "tail", to: "swap" },
        { from: "other", to: "swap" },
      ],
    };
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const executed = executedNodes(compile(graph, { salt: 1n }).bytes, { dir: true }, branchOwners(graph));
    expect(executed).toEqual(["dir", "tail", "swap"].map((id) => signatureOfNode(byId.get(id)!)));
  });
});

// ---------- random graph generator ----------

/** Seeded PRNG so a failing case is reproducible from the seed alone. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A random, always-valid strategy: nested branches over guards and fees whose
 * every path joins at a single constantProduct. Node parameters are unique so
 * each emitted instruction can be traced back to the node that produced it.
 */
function randomPreSwapGraph(random: () => number): StrategyGraph {
  const nodes: GraphNode[] = [{ id: "swap", kind: "constantProduct" }];
  const edges: Edge[] = [];
  let counter = 0;

  const step = (): GraphNode => {
    const n = ++counter;
    const id = `n${n}`;
    const pick = random();
    if (pick < 0.5) return { id, kind: "flatFee", feeBps: n };
    if (pick < 0.75) return { id, kind: "deadline", timestamp: 1_700_000_000 + n };
    return {
      id,
      kind: "holderGate",
      token: `0x${n.toString(16).padStart(40, "0")}`,
      minBalance: BigInt(n),
    };
  };

  const branch = (): GraphNode => {
    const n = ++counter;
    const id = `n${n}`;
    return random() < 0.5
      ? { id, kind: "ifDirection", token: `0x${(0x1000 + n).toString(16).padStart(40, "0")}` }
      : { id, kind: "ifInventoryAbove", target0: BigInt(n), target1: BigInt(n + 1) };
  };

  /** Build a sub-DAG whose every path ends at `exit`; returns its first node. */
  const chain = (exit: string, depth: number): string => {
    const shape = random();
    if (depth <= 0 || shape < 0.35) {
      const node = step();
      nodes.push(node);
      edges.push({ from: node.id, to: exit });
      return node.id;
    }
    if (shape < 0.7) {
      const node = step();
      nodes.push(node);
      edges.push({ from: node.id, to: chain(exit, depth - 1) });
      return node.id;
    }
    const node = branch();
    nodes.push(node);
    const thenId = chain(exit, depth - 1);
    // Sometimes both ports lead to the same sub-DAG: a join the layout must
    // reach with a jump instead of duplicating.
    const elseId = random() < 0.25 ? thenId : chain(exit, depth - 1);
    edges.push({ from: node.id, to: thenId, port: "then" }, { from: node.id, to: elseId, port: "else" });
    return node.id;
  };

  chain("swap", 3);
  return { nodes, edges };
}

