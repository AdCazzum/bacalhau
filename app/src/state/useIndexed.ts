import { useEffect, useState } from "react";

import { fetchIndexed, hasSubgraph, type IndexedState } from "../lib/subgraph";

/** Subgraph poll interval: indexing lags the chain, so a slower cadence than
 *  the RPC poll is honest and keeps the query budget low. Studio rate-limits
 *  the free tier, so one loop is shared by every subscriber - two panels
 *  polling independently earned an HTTP 429. */
const POLL_MS = 10000;
/** A rate-limited endpoint stays rate-limited if we keep knocking, so failures
 *  back off geometrically up to a minute and reset on the first good answer. */
const MAX_POLL_MS = 60000;

export interface IndexedResult {
  enabled: boolean;
  data: IndexedState | null;
  error: string | null;
}

type Snapshot = { data: IndexedState | null; error: string | null };

let snapshot: Snapshot = { data: null, error: null };
let timer: ReturnType<typeof setTimeout> | null = null;
let delay = POLL_MS;
const subscribers = new Set<(s: Snapshot) => void>();

function publish(next: Snapshot) {
  snapshot = next;
  for (const notify of subscribers) notify(next);
}

function schedule() {
  timer = setTimeout(run, delay);
}

function run() {
  // A backgrounded tab still burns the Studio quota, and the answer is stale
  // by the time anyone looks - skip it.
  if (typeof document !== "undefined" && document.hidden) {
    schedule();
    return;
  }
  fetchIndexed()
    .then((data) => {
      delay = POLL_MS;
      publish({ data, error: null });
    })
    .catch((e) => {
      delay = Math.min(delay * 2, MAX_POLL_MS);
      publish({ data: snapshot.data, error: e instanceof Error ? e.message : String(e) });
    })
    .finally(() => {
      if (subscribers.size > 0) schedule();
      else timer = null;
    });
}

function subscribe(notify: (s: Snapshot) => void): () => void {
  subscribers.add(notify);
  if (timer === null) {
    delay = POLL_MS;
    run();
  }
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0 && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

export function useIndexed(): IndexedResult {
  const enabled = hasSubgraph();
  const [state, setState] = useState<Snapshot>(snapshot);

  useEffect(() => {
    if (!enabled) return;
    return subscribe(setState);
  }, [enabled]);

  return { enabled, data: state.data, error: state.error };
}
