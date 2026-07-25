/**
 * Turn an agent's JSON into a strategy graph the compiler can judge.
 *
 * The model answers in JSON, which has no bigint and no notion of which fields
 * are token amounts. Rather than trust the shape, every node is rebuilt field
 * by field: an unknown `kind`, a missing parameter or a non-numeric amount is
 * rejected here, so `validate()` downstream only ever sees a well-typed graph
 * and its errors are about strategy semantics rather than bad JSON.
 */
import type { Edge, GraphNode, StrategyGraph } from "../compiler/graph";

export class ProposalError extends Error {}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") throw new ProposalError(`${field} must be a non-empty string`);
  return value;
}

function asAddress(value: unknown, field: string): `0x${string}` {
  const s = asString(value, field);
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw new ProposalError(`${field} must be a 20-byte address`);
  return s as `0x${string}`;
}

/** Accepts 12, "12" and 1.0 — models emit all three for the same intent. */
function asBigInt(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  throw new ProposalError(`${field} must be an integer`);
}

function asNumber(value: unknown, field: string): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new ProposalError(`${field} must be a number`);
  return Math.round(n);
}

function reviveNode(raw: unknown, index: number): GraphNode {
  if (typeof raw !== "object" || raw === null) throw new ProposalError(`node ${index} is not an object`);
  const node = raw as Record<string, unknown>;
  const id = asString(node.id, `node ${index} id`);
  const kind = asString(node.kind, `node ${id} kind`);

  switch (kind) {
    case "constantProduct":
      return { id, kind };
    case "flatFee":
      return { id, kind, feeBps: asNumber(node.feeBps, `${id}.feeBps`) };
    case "flowDecay":
      return { id, kind, periodSeconds: asNumber(node.periodSeconds, `${id}.periodSeconds`) };
    case "deadline":
      return { id, kind, timestamp: asNumber(node.timestamp, `${id}.timestamp`) };
    case "priceRange":
      return {
        id,
        kind,
        sqrtPriceMinX18: asBigInt(node.sqrtPriceMinX18, `${id}.sqrtPriceMinX18`),
        sqrtPriceMaxX18: asBigInt(node.sqrtPriceMaxX18, `${id}.sqrtPriceMaxX18`),
      };
    case "inventorySkew":
      return {
        id,
        kind,
        target0: asBigInt(node.target0, `${id}.target0`),
        target1: asBigInt(node.target1, `${id}.target1`),
        maxSkewBps: asNumber(node.maxSkewBps, `${id}.maxSkewBps`),
      };
    case "ifInventoryAbove":
      return {
        id,
        kind,
        target0: asBigInt(node.target0, `${id}.target0`),
        target1: asBigInt(node.target1, `${id}.target1`),
      };
    case "ifDirection":
      return { id, kind, token: asAddress(node.token, `${id}.token`) };
    case "holderGate":
      return {
        id,
        kind,
        token: asAddress(node.token, `${id}.token`),
        minBalance: asBigInt(node.minBalance, `${id}.minBalance`),
      };
    default:
      throw new ProposalError(`node ${id}: unknown kind "${kind}"`);
  }
}

function reviveEdge(raw: unknown, index: number, ids: Set<string>): Edge {
  if (typeof raw !== "object" || raw === null) throw new ProposalError(`edge ${index} is not an object`);
  const edge = raw as Record<string, unknown>;
  const from = asString(edge.from, `edge ${index} from`);
  const to = asString(edge.to, `edge ${index} to`);
  // Dangling edges would survive validate() as a silently unreachable node.
  if (!ids.has(from)) throw new ProposalError(`edge ${index}: no node "${from}"`);
  if (!ids.has(to)) throw new ProposalError(`edge ${index}: no node "${to}"`);
  if (edge.port === undefined || edge.port === null) return { from, to };
  const port = asString(edge.port, `edge ${index} port`);
  if (port !== "then" && port !== "else") throw new ProposalError(`edge ${index}: port must be "then" or "else"`);
  return { from, to, port };
}

export function reviveGraph(raw: unknown): StrategyGraph {
  if (typeof raw !== "object" || raw === null) throw new ProposalError("proposal is not an object");
  const { nodes, edges } = raw as Record<string, unknown>;
  if (!Array.isArray(nodes) || nodes.length === 0) throw new ProposalError("proposal has no nodes");
  if (!Array.isArray(edges)) throw new ProposalError("proposal has no edges array");

  const revived = nodes.map(reviveNode);
  const ids = new Set(revived.map((n) => n.id));
  if (ids.size !== revived.length) throw new ProposalError("proposal has duplicate node ids");

  return { nodes: revived, edges: edges.map((e, i) => reviveEdge(e, i, ids)) };
}
