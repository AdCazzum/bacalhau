/**
 * Strategy graph -> SwapVM bytecode (Aqua-backed router).
 *
 * SwapVM is a real machine, not a pipeline: every instruction may rewrite the
 * program counter (`VM.runLoop` re-reads `ctx.vm.nextPC` after each call), so a
 * strategy is a control-flow graph. This module owns the translation, and with
 * it two safety properties the UI cannot express:
 *
 *  1. Jump targets are byte offsets. A target landing inside an instruction's
 *     arguments would make the VM execute argument bytes as opcodes. We only
 *     ever emit labels that resolve to emission-unit boundaries, and the
 *     assembler is the only thing allowed to compute them.
 *  2. The audited order (guards/modifiers/fees BEFORE the core swap) still
 *     holds on *every* path. Rather than silently reordering the user's graph
 *     — what you see should be what executes — we reject graphs that break it.
 *
 * Cycles are rejected: the Aqua opcode table has no arithmetic or register
 * comparison, so a back edge cannot have a computed exit condition and would
 * simply burn gas until it reverts.
 */

import { AQUA_OPCODES, BPS, MAX_SKEW_CAP } from "./opcodes";
import { concatBytes, instruction, toHex, uintBE } from "./encode";

// ---------- Model ----------

export type NodeId = string;

/** Nodes that emit an instruction and continue to at most one successor. */
export type StepNode =
  /** x·y=k over the balances Aqua allocated to the strategy. */
  | { id: NodeId; kind: "constantProduct" }
  /** Concentrated range; bounds are sqrt(P)·1e18, P = tokenGt/tokenLt (raw). */
  | { id: NodeId; kind: "priceRange"; sqrtPriceMinX18: bigint; sqrtPriceMaxX18: bigint }
  /** Custom opcode 0x22: tilt the quote toward a target inventory split. */
  | { id: NodeId; kind: "inventorySkew"; target0: bigint; target1: bigint; maxSkewBps: number }
  /** Per-swap offsets that worsen the price and decay over `periodSeconds`. */
  | { id: NodeId; kind: "flowDecay"; periodSeconds: number }
  | { id: NodeId; kind: "flatFee"; feeBps: number }
  | { id: NodeId; kind: "deadline"; timestamp: number }
  /** Taker must hold at least `minBalance` of `token`. */
  | { id: NodeId; kind: "holderGate"; token: `0x${string}`; minBalance: bigint };

/** Nodes that emit a conditional jump and have exactly two successors. */
export type BranchNode =
  /** True when the taker is paying `token` in. */
  | { id: NodeId; kind: "ifDirection"; token: `0x${string}` }
  /** Custom opcode 0x23: true when holdings exceed the target split. */
  | { id: NodeId; kind: "ifInventoryAbove"; target0: bigint; target1: bigint };

export type GraphNode = StepNode | BranchNode;

export type Port = "then" | "else";

export interface Edge {
  from: NodeId;
  to: NodeId;
  /** Required on branch nodes, absent on steps. */
  port?: Port;
}

export interface StrategyGraph {
  nodes: GraphNode[];
  edges: Edge[];
}

export interface CompileResult {
  bytecode: `0x${string}`;
  bytes: Uint8Array;
}

export class GraphError extends Error {
  /** Node the problem belongs to, or null when it is about the whole graph. */
  readonly nodeId: NodeId | null;
  constructor(nodeId: NodeId | null, message: string) {
    super(message);
    this.name = "GraphError";
    this.nodeId = nodeId;
  }
}

const BRANCH_KINDS = ["ifDirection", "ifInventoryAbove"] as const;
/**
 * Only `xycSwap` computes swap amounts. `priceRange` (xycConcentrate) is a
 * *pre-swap* instruction: it reverts unless amounts are still zero, and only
 * grows the balances the swap then prices against.
 */
const PRICING_KINDS = ["constantProduct"] as const;

export function isBranch(node: GraphNode): node is BranchNode {
  return (BRANCH_KINDS as readonly string[]).includes(node.kind);
}

export function isPricing(node: GraphNode): boolean {
  return (PRICING_KINDS as readonly string[]).includes(node.kind);
}

/** Everything that adjusts balances or fees must run before the core swap. */
function isPreSwap(node: GraphNode): boolean {
  return (
    node.kind === "inventorySkew" ||
    node.kind === "flowDecay" ||
    node.kind === "flatFee" ||
    node.kind === "priceRange"
  );
}

/**
 * Instructions that move the balances an inventory branch tests, so the branch
 * has to be placed before them to read the real inventory.
 */
function movesBalances(node: GraphNode): boolean {
  return node.kind === "inventorySkew" || node.kind === "flowDecay" || node.kind === "priceRange";
}
/**
 * Structural + semantic checks. Returns every problem found so the canvas can
 * badge all offending nodes at once rather than one error per fix.
 */
export function validate(graph: StrategyGraph): GraphError[] {
  const errors: GraphError[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  if (graph.nodes.length === 0) return [new GraphError(null, "the canvas is empty")];
  if (byId.size !== graph.nodes.length) errors.push(new GraphError(null, "duplicate node ids"));

  for (const e of graph.edges) {
    if (!byId.has(e.from)) errors.push(new GraphError(null, `edge from unknown node ${e.from}`));
    if (!byId.has(e.to)) errors.push(new GraphError(null, `edge to unknown node ${e.to}`));
    if (e.from === e.to) errors.push(new GraphError(e.from, "a node cannot connect to itself"));
  }
  if (errors.length > 0) return errors; // later checks assume a well-formed edge list

  // Arity: steps take one successor, branches need both ports wired.
  const next = new Map<NodeId, NodeId>();
  const branches = new Map<NodeId, { then: NodeId; else: NodeId }>();
  for (const node of graph.nodes) {
    const out = graph.edges.filter((e) => e.from === node.id);
    if (isBranch(node)) {
      const then = out.filter((e) => e.port === "then");
      const els = out.filter((e) => e.port === "else");
      const thenEdge = then[0];
      const elseEdge = els[0];
      if (then.length !== 1 || els.length !== 1 || out.length !== 2 || !thenEdge || !elseEdge) {
        errors.push(new GraphError(node.id, "a branch needs exactly one 'then' and one 'else' path"));
      } else {
        branches.set(node.id, { then: thenEdge.to, else: elseEdge.to });
      }
    } else {
      const only = out[0];
      if (out.length > 1) errors.push(new GraphError(node.id, "a step can only continue to one node"));
      else if (only) next.set(node.id, only.to);
    }
  }

  // Exactly one entry.
  const hasIncoming = new Set(graph.edges.map((e) => e.to));
  const entries = graph.nodes.filter((n) => !hasIncoming.has(n.id));
  if (entries.length !== 1) {
    errors.push(
      new GraphError(
        null,
        entries.length === 0
          ? "no entry node: every node is a target, so the graph must contain a cycle"
          : `${entries.length} entry nodes: the strategy needs a single starting point`,
      ),
    );
  }
  for (const [i, node] of graph.nodes.entries()) errors.push(...paramErrors(node, i));
  if (errors.length > 0) return errors;

  const entryNode = entries[0];
  if (!entryNode) return errors;
  const entry = entryNode.id;
  const succ = (id: NodeId): NodeId[] => {
    const b = branches.get(id);
    return b ? [b.else, b.then] : next.has(id) ? [next.get(id)!] : [];
  };

  // Acyclicity + reachability, via an explicit colour DFS.
  const colour = new Map<NodeId, 0 | 1 | 2>();
  let cyclic = false;
  const walk = (id: NodeId) => {
    colour.set(id, 1);
    for (const s of succ(id)) {
      const c = colour.get(s) ?? 0;
      if (c === 1) cyclic = true;
      else if (c === 0) walk(s);
    }
    colour.set(id, 2);
  };
  walk(entry);
  if (cyclic) {
    errors.push(new GraphError(null, "the graph has a cycle; loops cannot terminate on this VM"));
    return errors;
  }
  for (const n of graph.nodes) {
    if (!colour.has(n.id)) errors.push(new GraphError(n.id, "unreachable from the entry node"));
  }
  if (errors.length > 0) return errors;

  errors.push(...swapOrderErrors(graph, entry, succ, byId));
  return errors;
}

/**
 * Path-sensitive ordering rules, tracked as the min/max count of preceding
 * nodes of each kind — enough to prove the properties without enumerating
 * paths (which is exponential in a DAG):
 *
 *  - exactly one pricing node per path, with nothing fee/balance-related after
 *    it (the audited order the official builders use);
 *  - an inventory branch reads `balanceIn`/`balanceOut` live, and price
 *    modifiers virtually shrink those balances, so a branch placed after one
 *    would test a tilted balance rather than the real inventory.
 */
function swapOrderErrors(
  graph: StrategyGraph,
  entry: NodeId,
  succ: (id: NodeId) => NodeId[],
  byId: Map<NodeId, GraphNode>,
): GraphError[] {
  const errors: GraphError[] = [];
  const order = topoOrder(graph, entry, succ);
  interface Seen {
    /** pricing nodes traversed */
    min: number;
    max: number;
    /** balance-shrinking modifiers traversed on at least one path */
    modifiers: number;
  }
  const seen = new Map<NodeId, Seen>();
  seen.set(entry, { min: 0, max: 0, modifiers: 0 });

  for (const id of order) {
    const before = seen.get(id) ?? { min: 0, max: 0, modifiers: 0 };
    const node = byId.get(id);
    if (!node) continue;

    if (isPricing(node) && before.max > 0) {
      errors.push(new GraphError(id, "a path already priced before this block: price once per path"));
    }
    // `max`, not `min`: a modifier is misplaced as soon as ANY path reaching it
    // has already priced, even if another path has not.
    if (isPreSwap(node) && before.max > 0) {
      errors.push(new GraphError(id, "modifiers and fees must come before the pricing block"));
    }
    if (node.kind === "ifInventoryAbove" && before.modifiers > 0) {
      errors.push(
        new GraphError(
          id,
          "move this branch before Inventory Skew / Flow Decay / Price Range: those shift the balances it tests",
        ),
      );
    }

    const shifts = movesBalances(node);
    const after: Seen = {
      min: before.min + (isPricing(node) ? 1 : 0),
      max: before.max + (isPricing(node) ? 1 : 0),
      modifiers: before.modifiers + (shifts ? 1 : 0),
    };
    for (const s of succ(id)) {
      const cur = seen.get(s);
      seen.set(
        s,
        cur
          ? {
              min: Math.min(cur.min, after.min),
              max: Math.max(cur.max, after.max),
              modifiers: Math.max(cur.modifiers, after.modifiers),
            }
          : after,
      );
    }
    // Both bounds: `max === 1` alone lets a join hide a leg that never priced.
    if (succ(id).length === 0 && (after.min !== 1 || after.max !== 1)) {
      errors.push(
        new GraphError(
          id,
          after.min === 0
            ? "a path ends without a pricing block: every branch needs one"
            : "this path prices more than once",
        ),
      );
    }
  }
  return errors;
}

function paramErrors(node: GraphNode, index: number): GraphError[] {
  const e: GraphError[] = [];
  const bad = (m: string) => e.push(new GraphError(node.id, m));
  switch (node.kind) {
    case "flatFee":
      if (!Number.isInteger(node.feeBps) || node.feeBps < 0 || node.feeBps > BPS) {
        bad(`fee out of range: ${node.feeBps} (base 1e9)`);
      }
      break;
    case "inventorySkew":
      if (node.target0 <= 0n || node.target1 <= 0n) bad("skew targets must be positive");
      if (node.maxSkewBps < 0 || node.maxSkewBps > MAX_SKEW_CAP) {
        bad(`maxSkew above cap: ${node.maxSkewBps} > ${MAX_SKEW_CAP}`);
      }
      break;
    case "ifInventoryAbove":
      if (node.target0 <= 0n || node.target1 <= 0n) bad("branch targets must be positive");
      break;
    case "deadline":
      if (!Number.isInteger(node.timestamp) || node.timestamp <= 0 || node.timestamp >= 2 ** 40) {
        bad("deadline must be a unix timestamp fitting uint40");
      }
      break;
    case "priceRange":
      if (node.sqrtPriceMinX18 <= 0n) bad("lower price bound must be positive");
      if (node.sqrtPriceMinX18 >= node.sqrtPriceMaxX18) bad("lower price bound must be below the upper");
      break;
    case "flowDecay":
      if (!Number.isInteger(node.periodSeconds) || node.periodSeconds <= 0 || node.periodSeconds > 0xffff) {
        bad("decay period must be 1..65535 seconds");
      }
      break;
    case "holderGate":
      if (!/^0x[0-9a-fA-F]{40}$/.test(node.token)) bad(`invalid token address: ${node.token}`);
      if (node.minBalance < 0n) bad("minimum balance cannot be negative");
      break;
    case "ifDirection":
      if (!/^0x[0-9a-fA-F]{40}$/.test(node.token)) bad(`invalid token address: ${node.token}`);
      break;
  }
  void index;
  return e;
}

/** Kahn order restricted to nodes reachable from `entry`. */
function topoOrder(graph: StrategyGraph, entry: NodeId, succ: (id: NodeId) => NodeId[]): NodeId[] {
  const reachable = new Set<NodeId>();
  const stack = [entry];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    stack.push(...succ(id));
  }
  const indegree = new Map<NodeId, number>();
  for (const id of reachable) indegree.set(id, 0);
  for (const id of reachable) for (const s of succ(id)) indegree.set(s, (indegree.get(s) ?? 0) + 1);

  const ready = [...reachable].filter((id) => indegree.get(id) === 0);
  const out: NodeId[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    out.push(id);
    for (const s of succ(id)) {
      const d = (indegree.get(s) ?? 0) - 1;
      indegree.set(s, d);
      if (d === 0) ready.push(s);
    }
  }
  return out;
}

/**
 * End-of-program sentinel. A symbol, not a string, so that a user node whose id
 * happens to be "tail" cannot collide with it and silently retarget every jump
 * aimed at that node to the trailing salt.
 */
const TAIL: unique symbol = Symbol("end-of-program");
type JumpTarget = NodeId | typeof TAIL;

// ---------- Emission ----------

/** opcode + length prefix. */
const HEADER = 2;
/** `_jump` args: a uint16 program counter. */
const JUMP_SIZE = HEADER + 2;

function bodySize(node: GraphNode): number {
  switch (node.kind) {
    case "constantProduct":
      return HEADER;
    case "priceRange":
      return HEADER + 64;
    case "inventorySkew":
      return HEADER + 36;
    case "flowDecay":
      return HEADER + 2;
    case "flatFee":
      return HEADER + 4;
    case "deadline":
      return HEADER + 5;
    case "holderGate":
      return HEADER + 52;
    case "ifDirection":
      return HEADER + 22;
    case "ifInventoryAbove":
      return HEADER + 34;
  }
}

/**
 * Lay the graph out so the `else` side of every branch falls through: the
 * conditional jump then only has to encode the `then` target. Nodes already
 * placed (a join) are reached with an explicit jump instead of duplication.
 */
function layout(
  entry: NodeId,
  wiring: {
    next: Map<NodeId, NodeId>;
    branches: Map<NodeId, { then: NodeId; else: NodeId }>;
  },
): NodeId[] {
  const placed: NodeId[] = [];
  const seen = new Set<NodeId>();
  const visit = (id: NodeId) => {
    if (seen.has(id)) return;
    seen.add(id);
    placed.push(id);
    const branch = wiring.branches.get(id);
    if (branch) {
      visit(branch.else);
      visit(branch.then);
      return;
    }
    const n = wiring.next.get(id);
    if (n !== undefined) visit(n);
  };
  visit(entry);
  return placed;
}

/**
 * The steps that would actually execute for a given trade, resolving branches
 * exactly as the VM does. Lets the canvas preview the live leg of a fork
 * instead of guessing, and label which mode a state machine is currently in.
 *
 * Balances are the address-sorted pair, matching the on-chain argument order.
 */
export function resolvePath(
  graph: StrategyGraph,
  trade: { tokenIn: `0x${string}`; balance0: bigint; balance1: bigint },
): GraphNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const next = new Map<NodeId, NodeId>();
  const branches = new Map<NodeId, { then: NodeId; else: NodeId }>();
  for (const e of graph.edges) {
    if (e.port === "then" || e.port === "else") {
      const cur = branches.get(e.from) ?? { then: "", else: "" };
      branches.set(e.from, { ...cur, [e.port]: e.to });
    } else {
      next.set(e.from, e.to);
    }
  }
  const hasIncoming = new Set(graph.edges.map((e) => e.to));
  const entryNode = graph.nodes.find((n) => !hasIncoming.has(n.id));
  if (!entryNode) return [];

  const path: GraphNode[] = [];
  const guard = new Set<NodeId>();
  let cursor: NodeId | undefined = entryNode.id;
  while (cursor !== undefined && !guard.has(cursor)) {
    guard.add(cursor);
    const node = byId.get(cursor);
    if (!node) break;
    path.push(node);

    const branch = branches.get(cursor);
    if (branch) {
      const taken =
        node.kind === "ifDirection"
          ? node.token.toLowerCase() === trade.tokenIn.toLowerCase()
          : node.kind === "ifInventoryAbove"
            ? trade.balance0 * node.target1 > trade.balance1 * node.target0
            : false;
      cursor = taken ? branch.then : branch.else;
    } else {
      cursor = next.get(cursor);
    }
  }
  return path;
}

/**
 * Compile a strategy graph. `options.salt` pins the trailing salt so callers
 * (and golden tests) can reproduce bytes exactly; otherwise it is random, which
 * is what makes two identical strategies distinct orders on Aqua.
 */
export function compile(graph: StrategyGraph, options?: { salt?: bigint }): CompileResult {
  const errors = validate(graph);
  if (errors.length > 0) throw errors[0];

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const next = new Map<NodeId, NodeId>();
  const branches = new Map<NodeId, { then: NodeId; else: NodeId }>();
  for (const e of graph.edges) {
    if (e.port === "then" || e.port === "else") {
      const cur = branches.get(e.from) ?? { then: "", else: "" };
      branches.set(e.from, { ...cur, [e.port]: e.to });
    } else {
      next.set(e.from, e.to);
    }
  }
  const hasIncoming = new Set(graph.edges.map((e) => e.to));
  const entry = graph.nodes.find((n) => !hasIncoming.has(n.id))!.id;
  const placed = layout(entry, { next, branches });

  // Pass 1: sizes only. Every instruction is fixed-width, so offsets computed
  // here stay valid once the real bytes (with resolved labels) are emitted.
  const trailingJump = new Map<NodeId, JumpTarget>();
  for (const [i, id] of placed.entries()) {
    const branch = branches.get(id);
    const fallthrough = branch ? branch.else : next.get(id);
    const target: JumpTarget = fallthrough ?? TAIL;
    const nextPlaced = placed[i + 1];
    if (target !== TAIL ? nextPlaced !== target : i !== placed.length - 1) {
      trailingJump.set(id, target);
    }
  }

  const offset = new Map<JumpTarget, number>();
  let cursor = 0;
  for (const id of placed) {
    offset.set(id, cursor);
    const node = byId.get(id);
    if (!node) throw new GraphError(id, "node vanished during layout");
    cursor += bodySize(node) + (trailingJump.has(id) ? JUMP_SIZE : 0);
  }
  offset.set(TAIL, cursor);

  // Pass 2: emit with resolved labels.
  const pcOf = (target: JumpTarget): number => {
    const pc = offset.get(target);
    if (pc === undefined) {
      throw new GraphError(null, `unresolved jump target ${String(target)}`);
    }
    return pc;
  };
  const chunks: Uint8Array[] = [];
  for (const id of placed) {
    const node = byId.get(id)!;
    chunks.push(emit(node, branches.get(id), pcOf));
    const jumpTo = trailingJump.get(id);
    if (jumpTo !== undefined) {
      chunks.push(instruction(AQUA_OPCODES.jump, uintBE(BigInt(pcOf(jumpTo)), 2)));
    }
  }
  // Salt lands at the tail every path falls through to, so it stays unique per
  // strategy without being part of the user's graph.
  chunks.push(instruction(AQUA_OPCODES.salt, uintBE(options?.salt ?? randomSalt(), 32)));

  const bytes = concatBytes(...chunks);
  return { bytes, bytecode: toHex(bytes) };
}

function emit(
  node: GraphNode,
  branch: { then: NodeId; else: NodeId } | undefined,
  pcOf: (target: JumpTarget) => number,
): Uint8Array {
  switch (node.kind) {
    case "constantProduct":
      return instruction(AQUA_OPCODES.xycSwap);
    case "priceRange":
      return instruction(
        AQUA_OPCODES.xycConcentrateGrowLiquidity2D,
        concatBytes(uintBE(node.sqrtPriceMinX18, 32), uintBE(node.sqrtPriceMaxX18, 32)),
      );
    case "inventorySkew":
      return instruction(
        AQUA_OPCODES.inventorySkew,
        concatBytes(
          uintBE(node.target0, 16),
          uintBE(node.target1, 16),
          uintBE(BigInt(node.maxSkewBps), 4),
        ),
      );
    case "flowDecay":
      return instruction(AQUA_OPCODES.decay, uintBE(BigInt(node.periodSeconds), 2));
    case "flatFee":
      return instruction(AQUA_OPCODES.flatFeeAmountIn, uintBE(BigInt(node.feeBps), 4));
    case "deadline":
      return instruction(AQUA_OPCODES.deadline, uintBE(BigInt(node.timestamp), 5));
    case "holderGate":
      return instruction(
        AQUA_OPCODES.onlyTakerTokenBalanceGte,
        concatBytes(uintBE(BigInt(node.token), 20), uintBE(node.minBalance, 32)),
      );
    case "ifDirection":
      return instruction(
        AQUA_OPCODES.jumpIfTokenIn,
        concatBytes(uintBE(BigInt(node.token), 20), uintBE(BigInt(pcOf(branch!.then)), 2)),
      );
    case "ifInventoryAbove":
      return instruction(
        AQUA_OPCODES.inventoryBranch,
        concatBytes(
          uintBE(node.target0, 16),
          uintBE(node.target1, 16),
          uintBE(BigInt(pcOf(branch!.then)), 2),
        ),
      );
  }
}

function randomSalt(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
}
