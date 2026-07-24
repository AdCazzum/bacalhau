import { useState } from "react";
import { formatEther, parseEther, type Address } from "viem";

import { aquaAbi, erc20Abi, routerAbi, takerAbi } from "../lib/abi";
import { publicClient, walletClient } from "../lib/chain";
import { takerData } from "../lib/order";
import type { DemoState, Strategy } from "../state/useDemo";

interface DashboardProps {
  demo: DemoState;
}

export function Dashboard({ demo }: DashboardProps) {
  if (!demo.deployment) return <div className="empty">Loading deployment…</div>;

  return (
    <div className="dashboard">
      <section className="strategies">
        <h2>Strategies</h2>
        {demo.strategies.length === 0 && (
          <div className="empty">No strategies yet — compose one on the Canvas.</div>
        )}
        {demo.strategies.map((s) => (
          <StrategyCard key={s.hash} strategy={s} demo={demo} />
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
              {fmt(f.amountIn)} in / {fmt(f.amountOut)} out
            </span>
            <small>block {f.blockNumber.toString()} · {f.txHash.slice(0, 10)}…</small>
          </div>
        ))}
      </aside>
    </div>
  );
}

function StrategyCard({ strategy, demo }: { strategy: Strategy; demo: DemoState }) {
  const dep = demo.deployment!;
  const total = strategy.balanceWeth + strategy.balanceUsdc;
  const wethShare = total > 0n ? Number((strategy.balanceWeth * 1000n) / total) / 10 : 0;

  return (
    <div className={`card ${strategy.status}`}>
      <header>
        <strong>WETH/USDC · {strategy.hash.slice(0, 10)}…</strong>
        <span className={`pill ${strategy.status}`}>{strategy.status}</span>
      </header>
      <div className="balances">
        <span>{fmt(strategy.balanceWeth)} WETH</span>
        <span>{fmt(strategy.balanceUsdc)} USDC</span>
        <span>{strategy.fills.length} fills</span>
      </div>
      <div className="gauge" title={`inventory: ${wethShare}% WETH by amount`}>
        <div className="gauge-fill" style={{ width: `${Math.min(wethShare, 100)}%` }} />
      </div>
      {strategy.status === "live" && <TestSwap strategy={strategy} demo={demo} />}
      {strategy.status === "live" && <DockButton strategy={strategy} dep={dep} demo={demo} />}
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

  async function getQuote() {
    setState("quoting");
    setError(null);
    try {
      const [, amountOut] = await publicClient.readContract({
        address: dep.router,
        abi: routerAbi,
        functionName: "quote",
        args: [strategy.order, tokenIn, tokenOut, parseEther(amount), takerData(true)],
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
      const amountIn = parseEther(amount);
      // Demo plumbing: make sure the taker holds tokenIn (mock tokens).
      const balance = await publicClient.readContract({
        address: tokenIn, abi: erc20Abi, functionName: "balanceOf", args: [dep.taker],
      });
      if (balance < amountIn) {
        const mintTx = await walletClient.writeContract({
          address: tokenIn, abi: erc20Abi, functionName: "mint", args: [dep.taker, amountIn],
        });
        await publicClient.waitForTransactionReceipt({ hash: mintTx });
      }
      const tx = await walletClient.writeContract({
        address: dep.taker,
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
      <header>Execute test swap (you are the taker)</header>
      <div className="row">
        <button className="dir-toggle" onClick={() => { setSellWeth(!sellWeth); setQuoted(null); }}>
          {sellWeth ? "sell WETH" : "sell USDC"}
        </button>
        <input value={amount} onChange={(e) => { setAmount(e.target.value); setQuoted(null); }} />
        <button onClick={getQuote} disabled={state !== "idle"}>Quote</button>
        <button onClick={executeSwap} disabled={state !== "idle"} className="go">
          {state === "swapping" ? "Swapping…" : "Swap"}
        </button>
      </div>
      {quoted !== null && (
        <p className="quote">→ you would receive {fmt(quoted)} {sellWeth ? "USDC" : "WETH"}</p>
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
    <button className="dock" onClick={dock} disabled={busy}>
      {busy ? "Docking…" : "Dock strategy"}
    </button>
  );
}

function fmt(wei: bigint): string {
  const n = Number(formatEther(wei));
  return n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function short(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "error";
}
