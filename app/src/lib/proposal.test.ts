import { describe, expect, it } from "vitest";

import { validate, type GraphNode, type StrategyGraph } from "../compiler/graph";
import { ProposalError, reviveGraph } from "./proposal";

/**
 * `reviveGraph` is the airlock between a model that can emit anything and a
 * compiler that mints programs moving real funds. Its successes are cheap; its
 * refusals are the product. So these tests are mostly about what does NOT get
 * through, and about the two things the compiler silently depends on:
 *
 *  - amounts arrive as `bigint` (they are encoded as 16/32-byte words) and
 *    numeric parameters as integers (they are encoded as fixed-width uints);
 *  - only declared parameters cross the boundary, so a model cannot smuggle a
 *    key into a node the compiler will later read.
 *
 * Rejections are asserted as `ProposalError` — never merely "it threw" — since
 * the UI distinguishes a malformed proposal from a crash, and a `TypeError`
 * escaping the parser would mean an unguarded coercion.
 */

const TOKEN = "0x2222222222222222222222222222222222222222";

/**
 * 2**53 + 1: the smallest integer a double cannot hold. Any amount that takes
 * a detour through `Number` comes back as 2**53 and reddens the assertion.
 */
const BIG_AMOUNT = 9_007_199_254_740_993n;

// ---------- helpers ----------

/** Runs the parser expecting a refusal, and hands the error back for inspection. */
function rejection(raw: unknown): ProposalError {
  try {
    reviveGraph(raw);
  } catch (error) {
    if (error instanceof ProposalError) return error;
    throw new Error(`expected a ProposalError, got ${String(error)}`);
  }
  throw new Error("expected reviveGraph to refuse this proposal, but it was accepted");
}

/** The smallest proposal carrying `node`, so a single node can be judged alone. */
function proposalWith(node: Record<string, unknown>): unknown {
  return { nodes: [node], edges: [] };
}

/**
 * The single node of a one-node proposal, seen as plain fields: what these
 * tests assert is which runtime types the fields hold, so narrowing by `kind`
 * would only hide the question.
 */
function fieldsOf(node: Record<string, unknown>): Record<string, unknown> {
  const parsed = reviveGraph(proposalWith(node)).nodes[0];
  if (!parsed) throw new Error("the parser returned an empty node list");
  return parsed as unknown as Record<string, unknown>;
}

/** A node whose only interesting parameter is an amount. */
function amountNode(minBalance: unknown): Record<string, unknown> {
  return { id: "gate", kind: "holderGate", token: TOKEN, minBalance };
}

/** A node whose only interesting parameter is an address. */
function addressNode(token: unknown): Record<string, unknown> {
  return { id: "dir", kind: "ifDirection", token };
}

// ---------- a proposal an agent would actually return ----------

/**
 * flatFee -> ifInventoryAbove -> {inventorySkew | flowDecay} -> constantProduct.
 * Written as JSON text on purpose: that is the transport, so no bigint can
 * sneak in and the amounts arrive in the mixed forms a model emits.
 */
const PROPOSAL_JSON = `{
  "nodes": [
    { "id": "fee", "kind": "flatFee", "feeBps": 3000000 },
    { "id": "inventory", "kind": "ifInventoryAbove", "target0": "${BIG_AMOUNT}", "target1": 2000000000 },
    { "id": "skew", "kind": "inventorySkew", "target0": "${BIG_AMOUNT}", "target1": "2000000000", "maxSkewBps": "50000000" },
    { "id": "decay", "kind": "flowDecay", "periodSeconds": 3600 },
    { "id": "swap", "kind": "constantProduct" }
  ],
  "edges": [
    { "from": "fee", "to": "inventory" },
    { "from": "inventory", "to": "skew", "port": "then" },
    { "from": "inventory", "to": "decay", "port": "else" },
    { "from": "skew", "to": "swap" },
    { "from": "decay", "to": "swap" }
  ]
}`;

const FULL_GRAPH: StrategyGraph = {
  nodes: [
    { id: "fee", kind: "flatFee", feeBps: 3_000_000 },
    { id: "inventory", kind: "ifInventoryAbove", target0: BIG_AMOUNT, target1: 2_000_000_000n },
    { id: "skew", kind: "inventorySkew", target0: BIG_AMOUNT, target1: 2_000_000_000n, maxSkewBps: 50_000_000 },
    { id: "decay", kind: "flowDecay", periodSeconds: 3_600 },
    { id: "swap", kind: "constantProduct" },
  ],
  edges: [
    { from: "fee", to: "inventory" },
    { from: "inventory", to: "skew", port: "then" },
    { from: "inventory", to: "decay", port: "else" },
    { from: "skew", to: "swap" },
    { from: "decay", to: "swap" },
  ],
};

describe("a complete proposal", () => {
  it("rebuilds every node and edge of a branching strategy", () => {
    expect(reviveGraph(JSON.parse(PROPOSAL_JSON))).toEqual(FULL_GRAPH);
  });

  it("hands the compiler a graph validate() has nothing to say about", () => {
    // The two layers must agree on what "well-formed" means: if the parser let
    // a shape through that validate() then calls structurally broken, the user
    // gets an error about their strategy for a bug in the airlock.
    const graph = reviveGraph(JSON.parse(PROPOSAL_JSON));
    expect(validate(graph).map((error) => error.message)).toEqual([]);
  });
});

// ---------- node kinds ----------

interface KindCase {
  name: string;
  raw: Record<string, unknown>;
  expected: GraphNode;
  /** Fields the encoder writes as multi-byte words: they must be bigint. */
  bigints?: string[];
  /** Fields the encoder writes as fixed-width uints: they must be integers. */
  integers?: string[];
}

const KINDS: KindCase[] = [
  {
    name: "constantProduct takes no parameters",
    raw: { id: "swap", kind: "constantProduct" },
    expected: { id: "swap", kind: "constantProduct" },
  },
  {
    name: "flatFee keeps feeBps as an integer",
    raw: { id: "fee", kind: "flatFee", feeBps: "250000" },
    expected: { id: "fee", kind: "flatFee", feeBps: 250_000 },
    integers: ["feeBps"],
  },
  {
    name: "flowDecay keeps periodSeconds as an integer",
    raw: { id: "decay", kind: "flowDecay", periodSeconds: "600" },
    expected: { id: "decay", kind: "flowDecay", periodSeconds: 600 },
    integers: ["periodSeconds"],
  },
  {
    name: "deadline keeps timestamp as an integer",
    raw: { id: "expiry", kind: "deadline", timestamp: 2_000_000_000 },
    expected: { id: "expiry", kind: "deadline", timestamp: 2_000_000_000 },
    integers: ["timestamp"],
  },
  {
    name: "priceRange reads both sqrt bounds as bigint",
    raw: { id: "range", kind: "priceRange", sqrtPriceMinX18: "1000000000000000000", sqrtPriceMaxX18: BIG_AMOUNT },
    expected: {
      id: "range",
      kind: "priceRange",
      sqrtPriceMinX18: 1_000_000_000_000_000_000n,
      sqrtPriceMaxX18: BIG_AMOUNT,
    },
    bigints: ["sqrtPriceMinX18", "sqrtPriceMaxX18"],
  },
  {
    name: "inventorySkew mixes bigint targets with an integer cap",
    raw: { id: "skew", kind: "inventorySkew", target0: BIG_AMOUNT.toString(), target1: 7, maxSkewBps: "1000" },
    expected: { id: "skew", kind: "inventorySkew", target0: BIG_AMOUNT, target1: 7n, maxSkewBps: 1_000 },
    bigints: ["target0", "target1"],
    integers: ["maxSkewBps"],
  },
  {
    name: "ifInventoryAbove reads both targets as bigint",
    raw: { id: "inventory", kind: "ifInventoryAbove", target0: 5, target1: BIG_AMOUNT.toString() },
    expected: { id: "inventory", kind: "ifInventoryAbove", target0: 5n, target1: BIG_AMOUNT },
    bigints: ["target0", "target1"],
  },
  {
    name: "ifDirection keeps the token address verbatim",
    raw: { id: "dir", kind: "ifDirection", token: TOKEN },
    expected: { id: "dir", kind: "ifDirection", token: TOKEN as `0x${string}` },
  },
  {
    name: "holderGate pairs an address with a bigint balance",
    raw: { id: "gate", kind: "holderGate", token: TOKEN, minBalance: BIG_AMOUNT.toString() },
    expected: { id: "gate", kind: "holderGate", token: TOKEN as `0x${string}`, minBalance: BIG_AMOUNT },
    bigints: ["minBalance"],
  },
];

describe("node kinds (the shape the compiler is allowed to see)", () => {
  it.each(KINDS)("$name", ({ raw, expected, bigints = [], integers = [] }) => {
    const fields = fieldsOf(raw);
    expect(fields).toEqual(expected);
    // toEqual already separates 7n from 7, but say it out loud: these two lines
    // are the whole reason the parser exists.
    for (const field of bigints) expect(typeof fields[field]).toBe("bigint");
    for (const field of integers) expect(Number.isInteger(fields[field])).toBe(true);
  });

  it("carries no key the kind does not declare", () => {
    // A model that appends fields (or a rewrite that spreads the raw object)
    // would otherwise hand the compiler attacker-chosen properties.
    const fields = fieldsOf({
      id: "fee",
      kind: "flatFee",
      feeBps: 250_000,
      token: TOKEN,
      minBalance: "5",
      target0: "1",
      note: "cheap on the way in",
      position: { x: 12, y: 40 },
    });
    expect(Object.keys(fields).sort()).toEqual(["feeBps", "id", "kind"]);
  });
});

// ---------- amounts ----------

const ACCEPTED_AMOUNTS: { name: string; value: unknown; expected: bigint }[] = [
  { name: "a JSON number", value: 12, expected: 12n },
  { name: "a decimal string", value: "12", expected: 12n },
  { name: "a bigint that never went through JSON", value: 12n, expected: 12n },
  { name: "a whole float, which is how JSON spells 12.0", value: 12.0, expected: 12n },
  { name: "a string padded with whitespace", value: "  12  ", expected: 12n },
  // Falsy but perfectly legal: a "missing value" shortcut would swallow it.
  { name: "zero", value: 0, expected: 0n },
  { name: "zero as a string", value: "0", expected: 0n },
  // Structural layer only: validate() is what refuses a negative balance.
  { name: "a negative amount", value: "-3", expected: -3n },
  { name: "an amount past 2**53", value: BIG_AMOUNT.toString(), expected: BIG_AMOUNT },
];

const REJECTED_AMOUNTS: { name: string; value: unknown }[] = [
  { name: "a fractional string", value: "12.5" },
  { name: "a fractional number", value: 12.5 },
  { name: "prose", value: "abc" },
  { name: "an empty string", value: "" },
  { name: "whitespace", value: "   " },
  { name: "null", value: null },
  { name: "undefined", value: undefined },
  { name: "NaN", value: Number.NaN },
  { name: "Infinity", value: Number.POSITIVE_INFINITY },
  { name: "-Infinity", value: Number.NEGATIVE_INFINITY },
  { name: "an object", value: { amount: 12 } },
  { name: "an array holding the amount", value: [12] },
  { name: "a boolean", value: true },
  { name: "hex notation", value: "0x10" },
  { name: "exponent notation", value: "1e3" },
  { name: "a thousands separator", value: "1,000" },
  { name: "a trailing unit", value: "12 wei" },
];

describe("amount coercion", () => {
  it.each(ACCEPTED_AMOUNTS)("accepts $name", ({ value, expected }) => {
    const minBalance = fieldsOf(amountNode(value)).minBalance;
    expect(minBalance).toBe(expected);
    expect(typeof minBalance).toBe("bigint");
  });

  it('reads 12, "12" and 12n as one and the same amount', () => {
    const parsed = [12, "12", 12n].map((form) => fieldsOf(amountNode(form)).minBalance);
    expect(parsed).toEqual([12n, 12n, 12n]);
  });

  it.each(REJECTED_AMOUNTS)("refuses $name", ({ value }) => {
    // The message must name the field, or the canvas cannot badge the node.
    expect(rejection(proposalWith(amountNode(value))).message).toMatch(/gate\.minBalance must be an integer/);
  });

  it("refuses an amount that is absent altogether", () => {
    const raw = proposalWith({ id: "gate", kind: "holderGate", token: TOKEN });
    expect(rejection(raw).message).toMatch(/gate\.minBalance/);
  });
});

// ---------- numeric parameters ----------

describe("numeric parameters", () => {
  it("hands the encoder an integer even when the model sends a fraction", () => {
    // feeBps is written as a fixed-width uint, and validate() rejects a
    // non-integer outright: a fraction surviving here becomes a strategy error
    // the user cannot act on. The rounding direction is not the contract, so
    // this asserts integrality plus "still the value that was asked for".
    const feeBps = fieldsOf({ id: "fee", kind: "flatFee", feeBps: 2.6 }).feeBps as number;
    expect(Number.isInteger(feeBps)).toBe(true);
    expect(Math.abs(feeBps - 2.6)).toBeLessThan(1);
  });

  // `""` is missing from this table on purpose: `Number("")` is 0, so a blank
  // fee currently parses as a zero-fee node that validate() then waves through.
  // Reported rather than pinned — a test here would encode the hole.
  it.each([
    { name: "prose", value: "high" },
    { name: "null", value: null },
    { name: "undefined", value: undefined },
    { name: "an object", value: { bps: 30 } },
    { name: "a boolean", value: true },
    { name: "NaN", value: Number.NaN },
    { name: "Infinity", value: Number.POSITIVE_INFINITY },
  ])("refuses $name", ({ value }) => {
    const raw = proposalWith({ id: "fee", kind: "flatFee", feeBps: value });
    expect(rejection(raw).message).toMatch(/fee\.feeBps must be a number/);
  });
});

// ---------- kinds the parser does not know ----------

const BAD_KINDS: { name: string; kind: unknown; match: RegExp }[] = [
  { name: "an invented instruction", kind: "selfDestruct", match: /unknown kind "selfDestruct"/ },
  // Kinds are matched exactly; near-misses are the common hallucination.
  { name: "the right kind in the wrong case", kind: "constantproduct", match: /unknown kind "constantproduct"/ },
  { name: "a kind with trailing space", kind: "flatFee ", match: /unknown kind/ },
  { name: "a UI label instead of a kind", kind: "Flat Fee", match: /unknown kind/ },
  { name: "an empty kind", kind: "", match: /kind must be a non-empty string/ },
  { name: "a numeric kind", kind: 3, match: /kind must be a non-empty string/ },
  { name: "a null kind", kind: null, match: /kind must be a non-empty string/ },
];

describe("unknown node kinds", () => {
  it.each(BAD_KINDS)("refuses $name", ({ kind, match }) => {
    const error = rejection({ nodes: [{ id: "pricer", kind }], edges: [] });
    expect(error.message).toMatch(match);
    // The id, not the array index: the canvas highlights nodes by id.
    expect(error.message).toContain("pricer");
  });

  it("names the offending node even when a valid node precedes it", () => {
    const error = rejection({
      nodes: [{ id: "swap", kind: "constantProduct" }, { id: "rug", kind: "transferAll" }],
      edges: [],
    });
    expect(error.message).toContain("rug");
    expect(error.message).not.toContain("swap");
  });
});

// ---------- addresses ----------

const ACCEPTED_ADDRESSES: { name: string; value: string }[] = [
  { name: "20 lowercase bytes", value: TOKEN },
  { name: "a checksummed address", value: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
  { name: "the zero address", value: `0x${"0".repeat(40)}` },
];

const REJECTED_ADDRESSES: { name: string; value: unknown }[] = [
  { name: "19 bytes", value: `0x${"11".repeat(19)}` },
  { name: "21 bytes", value: `0x${"11".repeat(21)}` },
  { name: "one nibble short", value: `0x${"1".repeat(39)}` },
  { name: "one nibble long", value: `0x${"1".repeat(41)}` },
  { name: "no 0x prefix", value: "1".repeat(40) },
  { name: "an uppercase 0X prefix", value: `0X${"1".repeat(40)}` },
  { name: "a non-hex digit", value: `0x${"1".repeat(39)}g` },
  { name: "an ENS name", value: "vitalik.eth" },
  { name: "a bare 0x", value: "0x" },
  { name: "surrounding whitespace", value: ` ${TOKEN} ` },
  { name: "an empty string", value: "" },
  { name: "a number", value: 291 },
  { name: "null", value: null },
  { name: "an object", value: { address: TOKEN } },
];

describe("addresses", () => {
  it.each(ACCEPTED_ADDRESSES)("accepts $name", ({ value }) => {
    expect(fieldsOf(addressNode(value)).token).toBe(value);
  });

  it.each(REJECTED_ADDRESSES)("refuses $name", ({ value }) => {
    const error = rejection(proposalWith(addressNode(value)));
    expect(error.message).toMatch(/dir\.token must be (a 20-byte address|a non-empty string)/);
  });

  it("checks the address on holderGate too, not only on ifDirection", () => {
    const raw = proposalWith({ id: "gate", kind: "holderGate", token: "0xdead", minBalance: "1" });
    expect(rejection(raw).message).toMatch(/gate\.token must be a 20-byte address/);
  });
});

// ---------- edges ----------

/** Two nodes, so an edge has somewhere to come from and go to. */
function edgeProposal(...edges: unknown[]): unknown {
  return {
    nodes: [
      { id: "inventory", kind: "ifInventoryAbove", target0: "1", target1: "1" },
      { id: "swap", kind: "constantProduct" },
    ],
    edges,
  };
}

const BAD_PORTS: { name: string; port: unknown; match: RegExp }[] = [
  { name: "the boolean spelling", port: "true", match: /port must be "then" or "else"/ },
  { name: "shouting", port: "THEN", match: /port must be "then" or "else"/ },
  { name: "title case", port: "Then", match: /port must be "then" or "else"/ },
  { name: "a padded port", port: " then", match: /port must be "then" or "else"/ },
  { name: "the string null", port: "null", match: /port must be "then" or "else"/ },
  { name: "a yes", port: "yes", match: /port must be "then" or "else"/ },
  { name: "a number", port: 1, match: /port must be a non-empty string/ },
  { name: "a boolean", port: true, match: /port must be a non-empty string/ },
  { name: "an empty string", port: "", match: /port must be a non-empty string/ },
];

describe("edges", () => {
  it.each(["then", "else"] as const)("keeps the %s port on a branch edge", (port) => {
    const graph = reviveGraph(edgeProposal({ from: "inventory", to: "swap", port }));
    expect(graph.edges).toEqual([{ from: "inventory", to: "swap", port }]);
  });

  it.each(BAD_PORTS)("refuses $name", ({ port, match }) => {
    const error = rejection(edgeProposal({ from: "inventory", to: "swap", port }));
    expect(error.message).toMatch(match);
    expect(error.message).toContain("edge 0");
  });

  it.each([
    { name: "omits the port entirely", edge: { from: "inventory", to: "swap" } },
    { name: "spells the absent port as null", edge: { from: "inventory", to: "swap", port: null } },
  ])("a step edge that $name carries no port", ({ edge }) => {
    const [parsed] = reviveGraph(edgeProposal(edge)).edges;
    expect(parsed).toEqual({ from: "inventory", to: "swap" });
    // validate() reads `e.port === "then"`, so an explicit null must not survive.
    expect(parsed && "port" in parsed).toBe(false);
  });

  it.each([
    {
      name: "starts at a node that does not exist",
      edge: { from: "ghost", to: "swap" },
      match: /edge 1: no node "ghost"/,
    },
    {
      name: "ends at a node that does not exist",
      edge: { from: "swap", to: "ghost" },
      match: /edge 1: no node "ghost"/,
    },
    { name: "is missing a from", edge: { to: "swap" }, match: /edge 1 from must be a non-empty string/ },
    { name: "is missing a to", edge: { from: "swap" }, match: /edge 1 to must be a non-empty string/ },
    { name: "is a string", edge: "inventory -> swap", match: /edge 1 is not an object/ },
    { name: "is null", edge: null, match: /edge 1 is not an object/ },
  ])("refuses an edge that $name", ({ edge, match }) => {
    // A first, valid edge pins the index reported for the second.
    expect(rejection(edgeProposal({ from: "inventory", to: "swap", port: "then" }, edge)).message).toMatch(match);
  });
});

// ---------- the proposal envelope ----------

describe("the proposal envelope", () => {
  it.each([
    { name: "null", raw: null, match: /proposal is not an object/ },
    { name: "undefined", raw: undefined, match: /proposal is not an object/ },
    { name: "the JSON text instead of the parsed value", raw: '{"nodes":[]}', match: /proposal is not an object/ },
    { name: "a number", raw: 7, match: /proposal is not an object/ },
    { name: "an empty nodes array", raw: { nodes: [], edges: [] }, match: /no nodes/ },
    { name: "a missing nodes field", raw: { edges: [] }, match: /no nodes/ },
    { name: "nodes as an object map", raw: { nodes: { swap: {} }, edges: [] }, match: /no nodes/ },
    {
      name: "a missing edges field",
      raw: { nodes: [{ id: "swap", kind: "constantProduct" }] },
      match: /no edges array/,
    },
    {
      name: "edges as an object map",
      raw: { nodes: [{ id: "swap", kind: "constantProduct" }], edges: { a: {} } },
      match: /no edges array/,
    },
    {
      name: "edges as null",
      raw: { nodes: [{ id: "swap", kind: "constantProduct" }], edges: null },
      match: /no edges array/,
    },
    { name: "a node that is null", raw: { nodes: [null], edges: [] }, match: /node 0 is not an object/ },
    { name: "a node that is a bare string", raw: { nodes: ["constantProduct"], edges: [] }, match: /node 0 is not/ },
    {
      name: "a node without an id",
      raw: { nodes: [{ kind: "constantProduct" }], edges: [] },
      match: /node 0 id must be a non-empty string/,
    },
    {
      name: "a node whose id is empty",
      raw: { nodes: [{ id: "", kind: "constantProduct" }], edges: [] },
      match: /node 0 id must be a non-empty string/,
    },
    {
      name: "a node whose id is a number",
      raw: { nodes: [{ id: 1, kind: "constantProduct" }], edges: [] },
      match: /node 0 id must be a non-empty string/,
    },
    {
      name: "two nodes sharing an id",
      raw: {
        nodes: [
          { id: "swap", kind: "constantProduct" },
          { id: "swap", kind: "flatFee", feeBps: 1 },
        ],
        edges: [],
      },
      match: /duplicate node ids/,
    },
  ])("refuses $name", ({ raw, match }) => {
    expect(rejection(raw).message).toMatch(match);
  });

  it("accepts a lone node with no edges", () => {
    // The smallest strategy a user can draw: an empty edge list is not an error.
    expect(reviveGraph({ nodes: [{ id: "swap", kind: "constantProduct" }], edges: [] })).toEqual({
      nodes: [{ id: "swap", kind: "constantProduct" }],
      edges: [],
    });
  });
});

// ---------- where the parser stops and validate() starts ----------

describe("the division of labour with validate()", () => {
  it("passes a semantically broken but well-typed graph to validate()", () => {
    // The branch has no 'else' edge. That is a strategy mistake, not bad JSON:
    // the parser must let it through so the user gets the actionable message.
    const graph = reviveGraph({
      nodes: [
        { id: "inventory", kind: "ifInventoryAbove", target0: "1", target1: "1" },
        { id: "swap", kind: "constantProduct" },
      ],
      edges: [{ from: "inventory", to: "swap", port: "then" }],
    });
    expect(validate(graph).map((error) => error.message)).toContain(
      "a branch needs exactly one 'then' and one 'else' path",
    );
  });

  it("leaves a negative balance for validate() to reject", () => {
    const graph = reviveGraph({
      nodes: [
        { id: "gate", kind: "holderGate", token: TOKEN, minBalance: "-1" },
        { id: "swap", kind: "constantProduct" },
      ],
      edges: [{ from: "gate", to: "swap" }],
    });
    expect(validate(graph).map((error) => error.message)).toContain("minimum balance cannot be negative");
  });
});
