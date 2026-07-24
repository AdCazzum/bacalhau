import { useMemo, useState } from "react";
import { parseEther, formatEther } from "viem";

import { compile, validate, type Block } from "../compiler/compile";
import { BPS as BPS_N, MAX_SKEW_CAP } from "../compiler/opcodes";
import { aquaAbi } from "../lib/abi";
import { publicClient, walletClient } from "../lib/chain";
import { buildAquaOrder, encodeOrder } from "../lib/order";
import { previewAmountOut, BPS } from "../lib/preview";
import type { DemoState } from "../state/useDemo";

interface CanvasProps {
  demo: DemoState;
  onShipped: () => void;
}

/** Palette entries for the D1 Aqua-backed set (docs/05). */
const PALETTE = [
  { kind: "constantProduct", label: "Constant-Product", zone: "Pricing", blurb: "x·y=k on your allocated balances" },
  { kind: "inventorySkew", label: "Inventory Skew ★", zone: "Modifiers", blurb: "self-balancing price tilt (custom opcode)" },
  { kind: "flatFee", label: "Flat Fee", zone: "Fees", blurb: "earn a fixed % on every trade" },
  { kind: "deadline", label: "Deadline", zone: "Guards", blurb: "stop quoting at a set time" },
] as const;

function defaultBlock(kind: (typeof PALETTE)[number]["kind"]): Block {
  switch (kind) {
    case "constantProduct":
      return { kind };
    case "inventorySkew":
      return { kind, target0: 0n, target1: 0n, maxSkewBps: BPS_N / 20 };
    case "flatFee":
      return { kind, feeBps: (3 * BPS_N) / 1000 };
    case "deadline":
      return { kind, timestamp: Math.floor(Date.now() / 1000) + 24 * 3600 };
  }
}

export function Canvas({ demo, onShipped }: CanvasProps) {
  const [blocks, setBlocks] = useState<Block[]>([{ kind: "constantProduct" }]);
  const [amountWeth, setAmountWeth] = useState("10");
  const [amountUsdc, setAmountUsdc] = useState("20000");
  const [shipState, setShipState] = useState<"idle" | "signing" | "pending">("idle");
  const [shipError, setShipError] = useState<string | null>(null);

  const allocWeth = safeParse(amountWeth);
  const allocUsdc = safeParse(amountUsdc);

  // Skew targets follow the allocation (target split = shipped split).
  const effective = useMemo(
    () =>
      blocks.map((b) =>
        b.kind === "inventorySkew" ? { ...b, target0: allocWeth, target1: allocUsdc } : b,
      ),
    [blocks, allocWeth, allocUsdc],
  );

  const errors = validate(effective);
  const feeBps = blocks.find((b) => b.kind === "flatFee")?.feeBps ?? 0;
  const hasSkew = blocks.some((b) => b.kind === "inventorySkew");

  const curve = useMemo(() => {
    if (allocWeth === 0n || allocUsdc === 0n) return [];
    const params = {
      balanceIn: allocWeth,
      balanceOut: allocUsdc,
      targetIn: hasSkew ? allocWeth : 0n,
      targetOut: hasSkew ? allocUsdc : 0n,
      maxSkewBps: BigInt(blocks.find((b) => b.kind === "inventorySkew")?.maxSkewBps ?? 0),
      feeBps: BigInt(feeBps),
    };
    const points: { size: number; price: number }[] = [];
    for (let i = 1; i <= 40; i++) {
      const size = (allocWeth * BigInt(i)) / 80n; // up to 50% of reserve
      const out = previewAmountOut(size, params);
      points.push({ size: Number(formatEther(size)), price: Number(formatEther((out * 10n ** 18n) / size)) });
    }
    return points;
  }, [blocks, allocWeth, allocUsdc, feeBps, hasSkew]);

  const summary = useMemo(() => {
    const parts = [`Market-make WETH/USDC on ${amountWeth} WETH + ${amountUsdc} USDC`];
    if (hasSkew) parts.push("self-balancing toward the shipped split");
    if (feeBps > 0) parts.push(`${(feeBps / BPS_N) * 100}% fee on every trade`);
    const dl = blocks.find((b) => b.kind === "deadline");
    if (dl && dl.kind === "deadline") {
      parts.push(`expires ${new Date(dl.timestamp * 1000).toLocaleString()}`);
    }
    return parts.join(" · ");
  }, [blocks, amountWeth, amountUsdc, feeBps, hasSkew]);

  async function ship() {
    if (!demo.deployment) return;
    setShipError(null);
    setShipState("signing");
    try {
      const { bytecode } = compile(effective);
      const order = buildAquaOrder(walletClient.account.address, bytecode);
      const txHash = await walletClient.writeContract({
        address: demo.deployment.aqua,
        abi: aquaAbi,
        functionName: "ship",
        args: [
          demo.deployment.router,
          encodeOrder(order),
          [demo.deployment.weth, demo.deployment.usdc],
          [allocWeth, allocUsdc],
        ],
      });
      setShipState("pending");
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      demo.refresh();
      onShipped();
    } catch (e) {
      setShipError(e instanceof Error ? e.message.split("\n")[0] ?? String(e) : String(e));
    } finally {
      setShipState("idle");
    }
  }

  return (
    <div className="canvas">
      <aside className="palette">
        <h2>Blocks</h2>
        {PALETTE.map((p) => {
          const used = blocks.some((b) => b.kind === p.kind);
          return (
            <button
              key={p.kind}
              className="palette-block"
              disabled={used}
              onClick={() => setBlocks((bs) => [...bs, defaultBlock(p.kind)])}
            >
              <span className="zone">{p.zone}</span>
              <strong>{p.label}</strong>
              <small>{p.blurb}</small>
            </button>
          );
        })}
      </aside>

      <section className="pipeline">
        <h2>Pipeline</h2>
        <div className="chain">
          {blocks.map((b, i) => (
            <div key={i} className="block-node">
              <header>
                <strong>{PALETTE.find((p) => p.kind === b.kind)?.label}</strong>
                {b.kind !== "constantProduct" && (
                  <button className="x" onClick={() => setBlocks((bs) => bs.filter((_, j) => j !== i))}>
                    ×
                  </button>
                )}
              </header>
              <BlockParams block={b} onChange={(nb) => setBlocks((bs) => bs.map((o, j) => (j === i ? nb : o)))} />
            </div>
          ))}
        </div>
        {errors.map((e, i) => (
          <p key={i} className="warn">{e.message}</p>
        ))}
      </section>

      <aside className="preview">
        <h2>Preview</h2>
        <CurveChart points={curve} />
        <p className="summary">{summary}</p>
        <div className="alloc">
          <label>
            WETH <input value={amountWeth} onChange={(e) => setAmountWeth(e.target.value)} />
          </label>
          <label>
            USDC <input value={amountUsdc} onChange={(e) => setAmountUsdc(e.target.value)} />
          </label>
        </div>
        <p className="hint">Funds stay in your wallet — Aqua only tracks the allocation.</p>
        <button
          className="ship"
          disabled={errors.length > 0 || allocWeth === 0n || allocUsdc === 0n || shipState !== "idle"}
          onClick={ship}
        >
          {shipState === "idle" ? "Ship strategy" : shipState === "signing" ? "Signing…" : "Pending…"}
        </button>
        {shipError && <p className="warn">{shipError}</p>}
      </aside>
    </div>
  );
}

function BlockParams({ block, onChange }: { block: Block; onChange: (b: Block) => void }) {
  switch (block.kind) {
    case "flatFee":
      return (
        <label>
          fee %
          <input
            type="number"
            step="0.05"
            min="0"
            value={(block.feeBps / BPS_N) * 100}
            onChange={(e) => onChange({ ...block, feeBps: Math.round(Number(e.target.value) * BPS_N / 100) })}
          />
        </label>
      );
    case "inventorySkew":
      return (
        <label>
          max skew %
          <input
            type="number"
            step="0.5"
            min="0"
            max={(MAX_SKEW_CAP / BPS_N) * 100}
            value={(block.maxSkewBps / BPS_N) * 100}
            onChange={(e) => onChange({ ...block, maxSkewBps: Math.round(Number(e.target.value) * BPS_N / 100) })}
          />
        </label>
      );
    case "deadline":
      return (
        <label>
          expires
          <input
            type="datetime-local"
            value={new Date(block.timestamp * 1000).toISOString().slice(0, 16)}
            onChange={(e) => onChange({ ...block, timestamp: Math.floor(new Date(e.target.value).getTime() / 1000) })}
          />
        </label>
      );
    default:
      return <small>uses your allocated balances</small>;
  }
}

function CurveChart({ points }: { points: { size: number; price: number }[] }) {
  if (points.length === 0) return <div className="chart empty">set allocations</div>;
  const w = 280;
  const h = 140;
  const maxSize = points[points.length - 1]!.size;
  const prices = points.map((p) => p.price);
  const minP = Math.min(...prices) * 0.98;
  const maxP = Math.max(...prices) * 1.02;
  const path = points
    .map((p, i) => {
      const x = (p.size / maxSize) * w;
      const y = h - ((p.price - minP) / (maxP - minP)) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`}>
      <path d={path} fill="none" stroke="var(--aqua)" strokeWidth="2" />
      <text x="4" y="12" className="axis">execution price (USDC/WETH) vs trade size</text>
    </svg>
  );
}

function safeParse(v: string): bigint {
  try {
    return parseEther(v === "" ? "0" : v);
  } catch {
    return 0n;
  }
}
