/**
 * Subgraph client (docs/04: The Graph is the observability layer).
 *
 * The dashboard's primary source on a public chain is the substreams-powered
 * subgraph: it carries aggregates (fill counts, cumulative volume) that the
 * app would otherwise have to fold from raw logs, and it is not bound by the
 * RPC's eth_getLogs range cap.
 *
 * The local-fork demo keeps reading logs directly (no indexer can see anvil),
 * so this module is additive: `hasSubgraph()` gates the UI.
 */

/**
 * Studio dev endpoint (what we deploy to): fully-qualified, no key needed.
 * A published subgraph would instead be queried through the decentralized
 * gateway with an API key; both are supported so the demo works either way.
 */
const studioUrl = import.meta.env.VITE_GRAPH_SUBGRAPH_URL as string | undefined;
const apiKey = import.meta.env.VITE_GRAPH_API_KEY as string | undefined;
const subgraphId = import.meta.env.VITE_GRAPH_SUBGRAPH_ID as string | undefined;

function endpoint(): string | null {
  if (studioUrl) return studioUrl;
  if (apiKey && subgraphId) {
    return `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/${subgraphId}`;
  }
  return null;
}

export function hasSubgraph(): boolean {
  return endpoint() !== null;
}

/** The endpoint and query, shown verbatim on the Indexed page so a reader can
 *  paste them into the Studio playground and get the same rows back. */
export function subgraphEndpoint(): string | null {
  return endpoint();
}

/** Cumulative movement for one token, in that token's own raw units. */
export interface IndexedVolume {
  token: string;
  pulled: string;
  pushed: string;
}

export interface IndexedStrategy {
  id: string;
  maker: string;
  program: string;
  status: "LIVE" | "DOCKED";
  shippedAt: string;
  fillCount: number;
  volume: IndexedVolume[];
}

export interface IndexedFill {
  id: string;
  direction: "PULL" | "PUSH";
  token: string;
  amount: string;
  timestamp: string;
  txHash: string;
  strategy: { id: string };
}

export interface IndexedState {
  strategies: IndexedStrategy[];
  fills: IndexedFill[];
  /** Head block the indexer has processed — proves liveness in the demo. */
  indexedBlock: number | null;
}

export const QUERY = `{
  strategies(first: 50, orderBy: shippedAt, orderDirection: desc) {
    id maker program status shippedAt fillCount volume { token pulled pushed }
  }
  fills(first: 50, orderBy: timestamp, orderDirection: desc) {
    id direction token amount timestamp txHash strategy { id }
  }
  _meta { block { number } }
}`;

export async function fetchIndexed(): Promise<IndexedState> {
  const url = endpoint();
  if (url === null) {
    throw new Error("subgraph not configured (VITE_GRAPH_SUBGRAPH_URL)");
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: QUERY }),
  });
  if (!res.ok) {
    throw new Error(`subgraph query failed: HTTP ${res.status}`);
  }
  const body = await res.json();
  if (body.errors?.length) {
    throw new Error(`subgraph error: ${body.errors[0].message}`);
  }
  return {
    strategies: body.data.strategies ?? [],
    fills: body.data.fills ?? [],
    indexedBlock: body.data._meta?.block?.number ?? null,
  };
}
