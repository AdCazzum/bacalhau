/**
 * The Graph, shown as itself: the live subgraph log, next to the endpoint and
 * the exact query that produced it. A reader can paste both into the Studio
 * playground and get the same rows back — the page is an invitation to check
 * us, not a screenshot of a claim.
 *
 * Nothing here reads the chain: every row on this page came back over GraphQL
 * from the indexer, which is the whole point of showing it separately from the
 * dashboard's RPC-fed view.
 */
import { QUERY, subgraphEndpoint } from "../lib/subgraph";
import { fmtAmount, indexedDecimals, WETH_DECIMALS } from "../lib/units";
import { useIndexed } from "../state/useIndexed";

export function Indexed() {
  const { enabled, data, error } = useIndexed();
  const url = subgraphEndpoint();

  if (!enabled) {
    return (
      <div className="indexed-page">
        <h2>Indexed by The Graph</h2>
        <p className="hint">
          No subgraph configured. The local fork has no indexer — this page reads the
          deployed subgraph, which follows the public Base Sepolia deployment.
        </p>
      </div>
    );
  }

  return (
    <div className="indexed-page">
      <header className="idx-head">
        <h2>Indexed by The Graph</h2>
        <span className="net">
          {data?.indexedBlock != null ? `indexer at block ${data.indexedBlock}` : "querying…"}
        </span>
      </header>

      <p className="hint">
        Everything below arrived over GraphQL from the subgraph, not from an RPC node.
        The endpoint and query are the ones the app uses; paste them anywhere and the
        rows should match.
      </p>

      <div className="idx-source">
        <label>endpoint</label>
        <code>{url}</code>
        <label>query</label>
        <pre>{QUERY}</pre>
      </div>

      {error && <p className="warn">{error}</p>}

      <h3>Strategies ({data?.strategies.length ?? 0})</h3>
      {data?.strategies.length === 0 && <p className="hint">none indexed yet</p>}
      {data && data.strategies.length > 0 && (
        <table className="log">
          <thead>
            <tr>
              <th>strategy</th>
              <th>maker</th>
              <th>status</th>
              <th>fills</th>
              <th>pulled</th>
              <th>pushed</th>
            </tr>
          </thead>
          <tbody>
            {data.strategies.map((s) => (
              <tr key={s.id}>
                <td><code>{s.id.slice(0, 14)}…</code></td>
                <td><code>{s.maker.slice(0, 10)}…</code></td>
                <td><span className={`pill ${s.status.toLowerCase()}`}>{s.status}</span></td>
                <td>{s.fillCount}</td>
                <td>{s.totalPulled}</td>
                <td>{s.totalPushed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Movements ({data?.fills.length ?? 0})</h3>
      {data?.fills.length === 0 && <p className="hint">no movements indexed yet</p>}
      {data && data.fills.length > 0 && (
        <table className="log">
          <thead>
            <tr>
              <th>time</th>
              <th>direction</th>
              <th>amount</th>
              <th>strategy</th>
              <th>tx</th>
            </tr>
          </thead>
          <tbody>
            {data.fills.map((f) => (
              <tr key={f.id}>
                <td>{new Date(Number(f.timestamp) * 1000).toLocaleString()}</td>
                <td>{f.direction === "PULL" ? "maker → taker" : "taker → maker"}</td>
                <td>{amount(f.token, f.amount)}</td>
                <td><code>{f.strategy.id.slice(0, 12)}…</code></td>
                <td><code>{f.txHash.slice(0, 12)}…</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Fills carry their own token, so scale per token and fall back to raw units
 * rather than guessing 18 decimals for a token we do not know.
 */
function amount(token: string, raw: string): string {
  const decimals = indexedDecimals(token);
  if (decimals === null) return raw;
  return `${fmtAmount(BigInt(raw), decimals)} ${decimals === WETH_DECIMALS ? "WETH" : "USDC"}`;
}

const WETH_HINT = "";
