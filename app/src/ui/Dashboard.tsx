import { useState } from "react";
import { parseUnits, type Address } from "viem";

import { aquaAbi, erc20Abi, routerAbi, takerAbi } from "../lib/abi";
import { canWrite, publicClient, walletClient } from "../lib/chain";
import { takerData } from "../lib/order";
import { fmtAmount, USDC_DECIMALS, WETH_DECIMALS, wethValueInUsdc } from "../lib/units";
import type { DemoState, Strategy } from "../state/useDemo";
import { useMarketPrice } from "../state/useMarketPrice";
import { useIndexed } from "../state/useIndexed";
import {
  executeRebalance,
  quoteRebalance,
  type RebalancePlan,
} from "../lib/rebalance";

interface DashboardProps {
  demo: DemoState;
}

export function Dashboard({ demo }: DashboardProps) {
  const marketState = useMarketPrice();

  return (
    <div className="dashboard">
      <section className="strategies">
        <h2>Strategies</h2>
        {demo.wallet && marketState.market && (
          <WalletInventory demo={demo} wallet={demo.wallet} marketPrice={marketState.market.price} />
        )}
        {demo.strategies.length === 0 && (
          <div className="empty">No strategies yet — compose one on the Canvas.</div>
        )}
        {demo.strategies.map((s) => (
          <StrategyCard key={s.hash} strategy={s} demo={demo} marketPrice={marketState.market?.price ?? null} />
        ))}
      </section>

      <aside className="feed">
        <h2>Live activity</h2>
        {demo.fills.length === 0 && <div className="empty">No fills yet.</div>}
        {demo.fills.map((f) => (
          <div key={`${f.txHash}-${f.strategyHash}`} className="fill">
            <span className="dir">
              {f.tokenIn === demo.deployment!.weth ? "WETH → USDC" : "USDC → WETH"}
            </span>
            <span>
              {f.tokenIn === demo.deployment!.weth
                ? `${fmtAmount(f.amountIn, WETH_DECIMALS)} WETH → ${fmtAmount(f.amountOut, USDC_DECIMALS)} USDC`
                : `${fmtAmount(f.amountIn, USDC_DECIMALS)} USDC → ${fmtAmount(f.amountOut, WETH_DECIMALS)} WETH`}
            </span>
            <small>block {f.blockNumber.toString()} · {f.txHash.slice(0, 10)}…</small>
          </div>
        ))}
        <IndexedPanel />
      </aside>
    </div>
  );
}

/**
 * The Graph pillar: the deployed subgraph's view of Aqua on a public chain
 * (Base Sepolia). Only rendered when a subgraph is configured — the anvil-fork
 * walkthrough has no indexer, so the local demo is unaffected.
 *
 * Fills carry their own token, so amounts are formatted per token rather than
 * with one blanket decimals guess.
 */
function IndexedPanel() {
  const { enabled, data, error } = useIndexed();
  if (!enabled) return null;

  return (
    <div className="indexed">
      <h3>
        Indexed by The Graph
        {data?.indexedBlock != null && <small> · block {data.indexedBlock}</small>}
      </h3>
      {error && <p className="warn">{error}</p>}
      {!error && !data && <p className="hint">querying subgraph…</p>}
      {data?.strategies.length === 0 && <p className="hint">no strategies indexed yet</p>}
      {data?.strategies.map((s) => (
        <div key={s.id} className="fill">
          <span className="dir">
            {s.id.slice(0, 10)}… <span className={`pill ${s.status.toLowerCase()}`}>{s.status}</span>
          </span>
          <span>
            {s.fillCount} {s.fillCount === 1 ? "swap" : "swaps"} indexed
          </span>
        </div>
      ))}
      {data && data.fills.length > 0 && (
        <>
          <h3 className="sub">Recent indexed movements</h3>
          {data.fills.slice(0, 6).map((f) => {
            const decimals = knownDecimals(f.token);
            return (
              <div key={f.id} className="fill">
                <span className="dir">{f.direction === "PULL" ? "maker → taker" : "taker → maker"}</span>
                <span>
                  {decimals === null
                    ? f.amount
                    : `${fmtAmount(BigInt(f.amount), decimals)} ${decimals === WETH_DECIMALS ? "WETH" : "USDC"}`}
                </span>
                <small>{f.txHash.slice(0, 10)}…</small>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

/**
 * Token decimals for the Base Sepolia demo pair (deployments/sepolia.json).
 * Returns null for anything else so amounts degrade to raw units instead of
 * being silently mis-scaled.
 */
function knownDecimals(token: string): number | null {
  const t = token.toLowerCase();
  if (t === "0x0f599727f37d4fc8ab5dbd3afe86c3ebf4a892f7") return WETH_DECIMALS;
  if (t === "0xb6ec46c767b71a5aa4b51bad4a40827560d63e55") return USDC_DECIMALS;
  return null;
}

function StrategyCard({ strategy, demo, marketPrice }: { strategy: Strategy; demo: DemoState; marketPrice: bigint | null }) {
  const dep = demo.deployment!;
  const wethValue = marketPrice !== null ? wethValueInUsdc(strategy.balanceWeth, marketPrice) : 0n;
  const total = wethValue + strategy.balanceUsdc;
  const wethShare = total > 0n ? Number((wethValue * 1000n) / total) / 10 : 0;

  return (
    <div className={`card ${strategy.status}`}>
      <header>
        <strong>WETH/USDC · {strategy.hash.slice(0, 10)}…</strong>
        <span className={`pill ${strategy.status}`}>{strategy.status}</span>
      </header>
      <div className="balances">
        <span>{fmtAmount(strategy.balanceWeth, WETH_DECIMALS)} WETH</span>
        <span>{fmtAmount(strategy.balanceUsdc, USDC_DECIMALS)} USDC</span>
        <span>{strategy.fills.length} fills</span>
      </div>
      <div className="gauge" title={`inventory: ${wethShare}% WETH by value`}>
        <div className="gauge-fill" style={{ width: `${Math.min(wethShare, 100)}%` }} />
      </div>
      {strategy.status === "live" && <TestSwap strategy={strategy} demo={demo} />}
      {strategy.status === "live" && <DockButton strategy={strategy} dep={dep} demo={demo} />}
    </div>
  );
}

function WalletInventory({
  demo,
  wallet,
  marketPrice,
}: {
  demo: DemoState;
  wallet: { weth: bigint; usdc: bigint };
  marketPrice: bigint;
}) {
  const dep = demo.deployment!;
  const [state, setState] = useState<"idle" | "quoting" | "executing">("idle");
  const [plan, setPlan] = useState<RebalancePlan | null>(null);
  const [error, setError] = useState<string | null>(null);

  const wethValue = wethValueInUsdc(wallet.weth, marketPrice);
  const totalValue = wethValue + wallet.usdc;
  const wethShare = totalValue > 0n ? Number((wethValue * 1000n) / totalValue) / 10 : 0;
  const drifted = Math.abs(wethShare - 50) > 5;

  const wethOverweight = wethShare > 50;
  const sellToken = wethOverweight ? dep.weth : dep.usdc;
  const buyToken = wethOverweight ? dep.usdc : dep.weth;
  const sellDecimals = wethOverweight ? WETH_DECIMALS : USDC_DECIMALS;

  // Sell half the value gap so the wallet lands near 50/50, capped to a size
  // a single Uniswap pool absorbs without excessive impact (demo executes via
  // exactInputSingle; production would tranche or route multi-pool).
  const MAX_USDC_PER_REBALANCE = 100_000n * 10n ** 6n;
  const gapValue = totalValue / 2n - (wethOverweight ? wallet.usdc : wethValue);
  const rawSellValue = gapValue > 0n ? gapValue : -gapValue;
  const sellValueUsdc = rawSellValue > MAX_USDC_PER_REBALANCE ? MAX_USDC_PER_REBALANCE : rawSellValue;
  const sellAmount = wethOverweight
    ? (sellValueUsdc * 10n ** 18n) / (marketPrice / 10n ** 12n)
    : sellValueUsdc;

  async function preview() {
    setState("quoting");
    setError(null);
    try {
      const { plan } = await quoteRebalance(sellToken, buyToken, sellAmount, dep.maker);
      setPlan(plan);
    } catch (e) {
      setError(short(e));
    } finally {
      setState("idle");
    }
  }

  async function execute() {
    if (!plan) return;
    setState("executing");
    setError(null);
    try {
      await executeRebalance(plan, plan.feeTier);
      setPlan(null);
      demo.refresh();
    } catch (e) {
      setError(short(e));
    } finally {
      setState("idle");
    }
  }

  return (
    <div className={drifted ? "wallet-inv rebalance" : "wallet-inv"}>
      <header>
        Wallet inventory: {wethShare.toFixed(0)}% WETH / {(100 - wethShare).toFixed(0)}% USDC
      </header>
      <div className="gauge">
        <div className="gauge-fill" style={{ width: `${Math.min(wethShare, 100)}%` }} />
      </div>
      <div className="balances">
        <span>{fmtAmount(wallet.weth, WETH_DECIMALS)} WETH</span>
        <span>{fmtAmount(wallet.usdc, USDC_DECIMALS)} USDC</span>
      </div>
      {drifted && (
        <>
          <p className="hint">
            Sell {fmtAmount(sellAmount, sellDecimals)} {wethOverweight ? "WETH" : "USDC"} via Uniswap to
            restore ~50/50.
          </p>
          {plan && (
            <p className="quote">
              → receive ~{fmtAmount(plan.expectedBuyAmount, wethOverweight ? USDC_DECIMALS : WETH_DECIMALS)}{" "}
              {wethOverweight ? "USDC" : "WETH"} · route {plan.routeString || "best"}
            </p>
          )}
          <div className="row">
            <button onClick={preview} disabled={state !== "idle"}>
              {state === "quoting" ? "Quoting…" : "Preview"}
            </button>
            <button className="go" onClick={execute} disabled={!canWrite || state !== "idle" || !plan}>
              {state === "executing" ? "Rebalancing…" : "Rebalance via Uniswap"}
            </button>
          </div>
        </>
      )}
      {error && <p className="warn">{error}</p>}
    </div>
  );
}

function TestSwap({ strategy, demo }: { strategy: Strategy; demo: DemoState }) {
  const dep = demo.deployment!;
  const [amount, setAmount] = useState("1");
  const [sellWeth, setSellWeth] = useState(true);
  const [quoted, setQuoted] = useState<bigint | null>(null);
  const [state, setState] = useState<"idle" | "quoting" | "swapping">("idle");
  const [error, setError] = useState<string | null>(null);
  const tokenIn: Address = sellWeth ? dep.weth : dep.usdc;
  const tokenOut: Address = sellWeth ? dep.usdc : dep.weth;
  const inDecimals = sellWeth ? WETH_DECIMALS : USDC_DECIMALS;
  const outDecimals = sellWeth ? USDC_DECIMALS : WETH_DECIMALS;
  async function getQuote() {
    setState("quoting");
    setError(null);
    try {
      const [, amountOut] = await publicClient.readContract({
        address: dep.router,
        abi: routerAbi,
        functionName: "quote",
        args: [strategy.order, tokenIn, tokenOut, parseUnits(amount, inDecimals), takerData(true)],
      });
      setQuoted(amountOut);
    } catch (e) {
      setError(short(e));
    } finally {
      setState("idle");
    }
  }

  async function executeSwap() {
    setState("swapping");
    setError(null);
    try {
      // Only the local fork record carries a taker contract; the public
      // Sepolia deployment has none, and the button is disabled there.
      const taker = dep.taker;
      if (!taker) throw new Error("fill simulation needs the local demo deployment");
      const amountIn = parseUnits(amount, inDecimals);
      const balance = await publicClient.readContract({
        address: tokenIn, abi: erc20Abi, functionName: "balanceOf", args: [taker],
      });
      if (balance < amountIn) {
        throw new Error(`taker underfunded: has ${fmtAmount(balance, inDecimals)}, needs ${amount}`);
      }
      const tx = await walletClient.writeContract({
        address: taker,
        abi: takerAbi,
        functionName: "swap",
        args: [strategy.order, tokenIn, tokenOut, amountIn, takerData(true)],
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      setQuoted(null);
      demo.refresh();
    } catch (e) {
      setError(short(e));
    } finally {
      setState("idle");
    }
  }

  return (
    <div className="testswap">
      <header>Execute test swap — play the counterparty against your own strategy</header>
      <div className="row">
        <button className="dir-toggle" onClick={() => { setSellWeth(!sellWeth); setQuoted(null); }}>
          {sellWeth ? "sell WETH" : "sell USDC"}
        </button>
        <input value={amount} onChange={(e) => { setAmount(e.target.value); setQuoted(null); }} />
        <button onClick={getQuote} disabled={state !== "idle"}>Quote</button>
        <button onClick={executeSwap} disabled={!canWrite || state !== "idle"} className="go">
          {state === "swapping" ? "Swapping…" : "Swap"}
        </button>
      </div>
      {quoted !== null && (
        <p className="quote">→ you would receive {fmtAmount(quoted, outDecimals)} {sellWeth ? "USDC" : "WETH"}</p>
      )}
      {error && <p className="warn">{error}</p>}
    </div>
  );
}

function DockButton({ strategy, dep, demo }: { strategy: Strategy; dep: NonNullable<DemoState["deployment"]>; demo: DemoState }) {
  const [busy, setBusy] = useState(false);
  async function dock() {
    setBusy(true);
    try {
      const tx = await walletClient.writeContract({
        address: dep.aqua,
        abi: aquaAbi,
        functionName: "dock",
        args: [dep.router, strategy.hash, [dep.weth, dep.usdc]],
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      demo.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <button className="dock" onClick={dock} disabled={!canWrite || busy}>
      {busy ? "Docking…" : "Dock strategy"}
    </button>
  );
}

function fmt(wei: bigint): string {
  return fmtAmount(wei, WETH_DECIMALS);
}

function short(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "error";
}
