import { useEffect, useState } from "react";

import { demoAccount } from "../lib/chain";
import { fetchMarketPrice, hasUniswapKey, type MarketPrice } from "../lib/uniswap";

const POLL_MS = 10_000; // 06 freshness contract, kept polite on API quota

export interface MarketPriceState {
  market: MarketPrice | null;
  /** Seconds since the last successful fetch, for the "as of Ns ago" label. */
  ageSeconds: number | null;
  enabled: boolean;
  error: string | null;
}

export function useMarketPrice(): MarketPriceState {
  const enabled = hasUniswapKey();
  const [market, setMarket] = useState<MarketPrice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!enabled) return;
    let alive = true;

    const pull = () =>
      fetchMarketPrice(demoAccount.address)
        .then((m) => {
          if (!alive) return;
          setMarket(m);
          setError(null);
        })
        .catch((e) => alive && setError(String(e)));

    pull();
    const poll = setInterval(pull, POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [enabled]);

  return {
    market,
    ageSeconds: market ? Math.round((now - market.fetchedAt) / 1000) : null,
    enabled,
    error,
  };
}
