import { useEffect, useState } from "react";

import { fetchIndexed, hasSubgraph, type IndexedState } from "../lib/subgraph";

/** Subgraph poll interval: indexing lags the chain, so a slower cadence than
 *  the RPC poll is honest and keeps the query budget low. */
const POLL_MS = 5000;

export interface IndexedResult {
  enabled: boolean;
  data: IndexedState | null;
  error: string | null;
}

export function useIndexed(): IndexedResult {
  const enabled = hasSubgraph();
  const [data, setData] = useState<IndexedState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () => {
      fetchIndexed()
        .then((d) => {
          if (!alive) return;
          setData(d);
          setError(null);
        })
        .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [enabled]);

  return { enabled, data, error };
}
