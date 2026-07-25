/**
 * Strategy canvas: a control-flow graph, compiled to SwapVM bytecode.
 *
 * SwapVM lets any instruction rewrite the program counter, so a strategy is a
 * graph rather than a list — that is what makes direction-dependent quoting and
 * inventory state machines expressible at all. The compiler owns correctness
 * (see compiler/graph.ts); this file owns making the graph drawable and showing
 * what it would do before any funds move.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge as FlowEdge,
  type EdgeChange,
  type Node as FlowNode,
  type NodeChange,
} from "@xyflow/react";
import { formatUnits } from "viem";
import "@xyflow/react/dist/style.css";

import {
  compile,
  isBranch,
  resolvePath,
  validate,
  type GraphNode,
  type StrategyGraph,
} from "../compiler/graph";
import { BPS } from "../compiler/opcodes";
import { aquaAbi } from "../lib/abi";
import { canWrite, publicClient, walletClient } from "../lib/chain";
import { buildAquaOrder, encodeOrder } from "../lib/order";
import { previewAmountOut } from "../lib/preview";
import { TEMPLATES } from "../lib/templates";
import { USDC_DECIMALS, WETH_DECIMALS, fmtAmount, parseAmount } from "../lib/units";
import type { DemoState } from "../state/useDemo";
import { useMarketPrice } from "../state/useMarketPrice";
import { PALETTE, seedNode, type NodeKind } from "./nodeKinds";
import { StrategyNode, type StrategyNodeData } from "./StrategyNode";

interface CanvasProps {
  demo: DemoState;
  onShipped: () => void;
}

const nodeTypes = { strategy: StrategyNode };

/** Column-ish placement for a freshly added node, so it lands somewhere sane. */
let dropIndex = 0;
const nextDrop = () => {
  const i = dropIndex++;
  return { x: 40 + (i % 3) * 210, y: 40 + Math.floor(i / 3) * 150 };
};

export function Canvas({ demo, onShipped }: CanvasProps) {
  const dep = demo.deployment;
  const [flowNodes, setFlowNodes] = useState<FlowNode[]>([]);
  const [flowEdges, setFlowEdges] = useState<FlowEdge[]>([]);
  const [amountWeth, setAmountWeth] = useState("10");
  const [amountUsdc, setAmountUsdc] = useState("18500");
  const [previewSide, setPreviewSide] = useState<"sellWeth" | "buyWeth">("sellWeth");
  const [shipState, setShipState] = useState<"idle" | "signing" | "pending">("idle");
  const [shipError, setShipError] = useState<string | null>(null);

  const allocWeth = parseAmount(amountWeth, WETH_DECIMALS);
  const allocUsdc = parseAmount(amountUsdc, USDC_DECIMALS);
  const marketState = useMarketPrice();

  const base = useMemo(
    () => ({ address: dep?.weth ?? "0x", decimals: WETH_DECIMALS }),
    [dep?.weth],
  );
  const quote = useMemo(
    () => ({ address: dep?.usdc ?? "0x", decimals: USDC_DECIMALS }),
    [dep?.usdc],
  );

  /** Targets are keyed to the address-sorted pair, like the on-chain args. */
  const sorted = useMemo(() => {
    if (!dep) return { target0: 1n, target1: 1n };
    return dep.weth.toLowerCase() < dep.usdc.toLowerCase()
      ? { target0: allocWeth, target1: allocUsdc }
      : { target0: allocUsdc, target1: allocWeth };
  }, [dep, allocWeth, allocUsdc]);

  const graph: StrategyGraph = useMemo(
    () => ({
      nodes: flowNodes.map((n) => (n.data as StrategyNodeData).node),
      edges: flowEdges.map((e) => ({
        from: e.source,
        to: e.target,
        ...(e.sourceHandle === "then" || e.sourceHandle === "else"
          ? { port: e.sourceHandle }
          : {}),
      })),
    }),
    [flowNodes, flowEdges],
  );

  const errors = useMemo(() => (graph.nodes.length > 0 ? validate(graph) : []), [graph]);
  const problemsByNode = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const e of errors) {
      if (e.nodeId === null) continue;
      map.set(e.nodeId, [...(map.get(e.nodeId) ?? []), e.message]);
    }
    return map;
  }, [errors]);

  /** The leg the VM would take for the previewed direction and allocation. */
  const livePath = useMemo(() => {
    if (!dep || graph.nodes.length === 0) return [];
    return resolvePath(graph, {
      tokenIn: previewSide === "sellWeth" ? dep.weth : dep.usdc,
      balance0: sorted.target0,
      balance1: sorted.target1,
    });
  }, [graph, dep, previewSide, sorted]);
  const liveIds = useMemo(() => new Set(livePath.map((n) => n.id)), [livePath]);

  /**
   * Price the nodes read targets against. Market when we have it, otherwise the
   * price the allocation itself implies — so shares stay meaningful offline.
   */
  const nodePrice = useMemo(() => {
    if (marketState.market) return Number(formatUnits(marketState.market.price, 18));
    const weth = Number(formatUnits(allocWeth, WETH_DECIMALS));
    const usdc = Number(formatUnits(allocUsdc, USDC_DECIMALS));
    return weth > 0 ? usdc / weth : 0;
  }, [marketState.market, allocWeth, allocUsdc]);

  // Keep node data in sync with validation, the previewed path and the price.
  useEffect(() => {
    setFlowNodes((ns) =>
      ns.map((n) => {
        const data = n.data as StrategyNodeData;
        const problems = problemsByNode.get(n.id) ?? [];
        const live = liveIds.has(n.id);
        if (
          data.problems.length === problems.length &&
          data.live === live &&
          data.base === base &&
          data.price === nodePrice
        ) {
          return n;
        }
        return { ...n, data: { ...data, problems, live, base, quote, price: nodePrice } };
      }),
    );
  }, [problemsByNode, liveIds, base, quote, nodePrice]);

  const updateNode = useCallback((node: GraphNode) => {
    setFlowNodes((ns) =>
      ns.map((n) => (n.id === node.id ? { ...n, data: { ...(n.data as StrategyNodeData), node } } : n)),
    );
  }, []);

  const removeNode = useCallback((id: string) => {
    setFlowNodes((ns) => ns.filter((n) => n.id !== id));
    setFlowEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
  }, []);

  const toFlowNode = useCallback(
    (node: GraphNode, position: { x: number; y: number }): FlowNode => ({
      id: node.id,
      type: "strategy",
      position,
      data: {
        node,
        problems: [],
        live: false,
        base,
        quote,
        price: nodePrice,
        onChange: updateNode,
        onRemove: removeNode,
      } satisfies StrategyNodeData,
    }),
    [base, quote, nodePrice, updateNode, removeNode],
  );

  const addNode = (kind: NodeKind) => {
    if (!dep) return;
    const id = `${kind}-${Math.random().toString(36).slice(2, 7)}`;
    const node = seedNode(kind, id, { weth: dep.weth, usdc: dep.usdc, ...sorted });
    setFlowNodes((ns) => [...ns, toFlowNode(node, nextDrop())]);
  };

  const loadTemplate = (id: string) => {
    if (!dep) return;
    const template = TEMPLATES.find((t) => t.id === id);
    if (!template) return;
    const built = template.build({
      weth: dep.weth,
      usdc: dep.usdc,
      allocWeth,
      allocUsdc,
      marketPrice: marketState.market?.price ?? null,
    });
    // Lay a template out left to right, branches stacked, so it reads at a glance.
    const depth = new Map<string, number>();
    const walk = (id: string, d: number) => {
      if ((depth.get(id) ?? -1) >= d) return;
      depth.set(id, d);
      for (const e of built.edges.filter((x) => x.from === id)) walk(e.to, d + 1);
    };
    const incoming = new Set(built.edges.map((e) => e.to));
    const entry = built.nodes.find((n) => !incoming.has(n.id));
    if (entry) walk(entry.id, 0);
    const lane = new Map<number, number>();

    setFlowNodes(
      built.nodes.map((node) => {
        const d = depth.get(node.id) ?? 0;
        const row = lane.get(d) ?? 0;
        lane.set(d, row + 1);
        return toFlowNode(node, { x: 30 + d * 205, y: 30 + row * 165 });
      }),
    );
    setFlowEdges(
      built.edges.map((e, i) => ({
        id: `e${i}`,
        source: e.from,
        target: e.to,
        ...(e.port ? { sourceHandle: e.port, label: e.port } : {}),
      })),
    );
  };

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setFlowNodes((ns) => applyNodeChanges(changes, ns)),
    [],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setFlowEdges((es) => applyEdgeChanges(changes, es)),
    [],
  );
  const onConnect = useCallback(
    (c: Connection) =>
      setFlowEdges((es) =>
        addEdge({ ...c, ...(c.sourceHandle ? { label: c.sourceHandle } : {}) }, es),
      ),
    [],
  );

  // Preview curve along the live path only: a fork's other leg prices differently.
  const curve = useMemo(() => {
    if (allocWeth === 0n || allocUsdc === 0n || livePath.length === 0) return [];
    const skew = livePath.find((n) => n.kind === "inventorySkew");
    const fee = livePath.find((n) => n.kind === "flatFee");
    const sellingWeth = previewSide === "sellWeth";
    const balanceIn = sellingWeth ? allocWeth : allocUsdc;
    const balanceOut = sellingWeth ? allocUsdc : allocWeth;
    const inDecimals = sellingWeth ? WETH_DECIMALS : USDC_DECIMALS;
    const outDecimals = sellingWeth ? USDC_DECIMALS : WETH_DECIMALS;
    const params = {
      balanceIn,
      balanceOut,
      targetIn: skew?.kind === "inventorySkew" ? (sellingWeth ? skew.target0 : skew.target1) : 0n,
      targetOut: skew?.kind === "inventorySkew" ? (sellingWeth ? skew.target1 : skew.target0) : 0n,
      maxSkewBps: BigInt(skew?.kind === "inventorySkew" ? skew.maxSkewBps : 0),
      feeBps: BigInt(fee?.kind === "flatFee" ? fee.feeBps : 0),
    };
    const points: { size: number; price: number }[] = [];
    for (let i = 1; i <= 40; i++) {
      const size = (balanceIn * BigInt(i)) / 80n;
      const out = previewAmountOut(size, params);
      const sizeF = Number(formatUnits(size, inDecimals));
      const outF = Number(formatUnits(out, outDecimals));
      const price = sizeF > 0 ? (sellingWeth ? outF / sizeF : sizeF / outF) : 0;
      points.push({ size: sellingWeth ? sizeF : outF, price });
    }
    return points;
  }, [livePath, allocWeth, allocUsdc, previewSide]);

  const marketPrice = marketState.market ? Number(formatUnits(marketState.market.price, 18)) : null;
  const bytecode = useMemo(() => {
    if (errors.length > 0 || graph.nodes.length === 0) return null;
    try {
      return compile(graph).bytecode;
    } catch {
      return null;
    }
  }, [graph, errors]);

  const summary = useMemo(() => {
    if (livePath.length === 0) return "Pick a template or drop a Pricing block to start.";
    const parts = [`On ${amountWeth} WETH + ${amountUsdc} USDC`];
    const branches = graph.nodes.filter(isBranch).length;
    if (branches > 0) parts.push(`${branches} branch${branches > 1 ? "es" : ""}`);
    const fee = livePath.find((n) => n.kind === "flatFee");
    if (fee?.kind === "flatFee") parts.push(`${((fee.feeBps / BPS) * 100).toFixed(3)}% fee this leg`);
    if (livePath.some((n) => n.kind === "inventorySkew")) parts.push("self-balancing");
    if (livePath.some((n) => n.kind === "priceRange")) parts.push("concentrated range");
    if (livePath.some((n) => n.kind === "flowDecay")) parts.push("decaying flow penalty");
    return parts.join(" · ");
  }, [livePath, graph, amountWeth, amountUsdc]);

  async function ship() {
    if (!dep) return;
    setShipError(null);
    setShipState("signing");
    try {
      const { bytecode } = compile(graph);
      const order = buildAquaOrder(walletClient.account.address, bytecode);
      const txHash = await walletClient.writeContract({
        address: dep.aqua,
        abi: aquaAbi,
        functionName: "ship",
        args: [dep.router, encodeOrder(order), [dep.weth, dep.usdc], [allocWeth, allocUsdc]],
      });
      setShipState("pending");
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      demo.refresh();
      onShipped();
    } catch (e) {
      setShipError(e instanceof Error ? (e.message.split("\n")[0] ?? String(e)) : String(e));
    } finally {
      setShipState("idle");
    }
  }

  return (
    <div className="canvas">
      <aside className="palette">
        <h2>Templates</h2>
        {TEMPLATES.map((t) => (
          <button key={t.id} className="template" onClick={() => loadTemplate(t.id)}>
            <strong>
              {t.label}
              {t.novel && <em title="not expressible in a constant-product pool"> ✦</em>}
            </strong>
            <small>{t.blurb}</small>
          </button>
        ))}

        <h2>Blocks</h2>
        {PALETTE.map((p) => (
          <button key={p.kind} className="palette-block" onClick={() => addNode(p.kind)}>
            <span className="zone">{p.zone}</span>
            <strong>
              {p.label}
              {p.custom && <em title="custom SwapVM instruction"> ★</em>}
            </strong>
            <small>{p.blurb}</small>
          </button>
        ))}
      </aside>

      <section className="graph">
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={18} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
        {flowNodes.length === 0 && (
          <p className="empty-graph">
            Click a template on the left, or add blocks and wire them up. Branch blocks have two
            outputs: <code>then</code> and <code>else</code>.
          </p>
        )}
      </section>

      <aside className="preview">
        <h2>Preview</h2>

        <div className="side-toggle">
          <button
            className={previewSide === "sellWeth" ? "on" : ""}
            onClick={() => setPreviewSide("sellWeth")}
          >
            taker sells WETH
          </button>
          <button
            className={previewSide === "buyWeth" ? "on" : ""}
            onClick={() => setPreviewSide("buyWeth")}
          >
            taker buys WETH
          </button>
        </div>

        <CurveChart points={curve} market={marketPrice} />

        <p className="summary">{summary}</p>

        {errors.length > 0 && (
          <ul className="errors">
            {errors.slice(0, 4).map((e, i) => (
              <li key={i} className="warn">
                {e.message}
              </li>
            ))}
          </ul>
        )}

        {bytecode && (
          <details className="bytes">
            <summary>{(bytecode.length - 2) / 2} bytes of SwapVM bytecode</summary>
            <code>{bytecode}</code>
          </details>
        )}

        <div className="alloc">
          <label>
            WETH
            <input value={amountWeth} onChange={(e) => setAmountWeth(e.target.value)} />
          </label>
          <label>
            USDC
            <input value={amountUsdc} onChange={(e) => setAmountUsdc(e.target.value)} />
          </label>
        </div>
        <p className="hint">
          Funds stay in your wallet — Aqua only tracks the allocation
          {allocWeth > 0n && marketPrice
            ? `; ${fmtAmount(allocWeth, WETH_DECIMALS)} WETH ≈ ${(
                Number(formatUnits(allocWeth, WETH_DECIMALS)) * marketPrice
              ).toLocaleString(undefined, { maximumFractionDigits: 0 })} USDC at market`
            : ""}
          .
        </p>

        <button
          className="ship"
          disabled={!canWrite || shipState !== "idle" || errors.length > 0 || graph.nodes.length === 0 || !dep}
          onClick={ship}
        >
          {shipState === "idle" ? "Ship strategy" : shipState === "signing" ? "Signing…" : "Shipping…"}
        </button>
        {shipError && <p className="warn">{shipError}</p>}
      </aside>
    </div>
  );
}

function CurveChart({ points, market }: { points: { size: number; price: number }[]; market: number | null }) {
  if (points.length === 0) return <div className="chart empty">no executable path yet</div>;
  const w = 280;
  const h = 140;
  const prices = points.map((p) => p.price);
  const withMarket = market !== null ? [...prices, market] : prices;
  const minP = Math.min(...withMarket) * 0.98;
  const maxP = Math.max(...withMarket) * 1.02;
  const maxSize = points[points.length - 1]?.size ?? 1;
  const path = points
    .map((p, i) => {
      const x = (p.size / maxSize) * w;
      const y = h - ((p.price - minP) / (maxP - minP)) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const marketY = market !== null ? h - ((market - minP) / (maxP - minP)) * h : null;

  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`}>
      <path d={path} fill="none" stroke="var(--aqua)" strokeWidth="2" />
      {marketY !== null && (
        <line x1="0" y1={marketY} x2={w} y2={marketY} className="axis market" strokeDasharray="4 3" />
      )}
      <text x="4" y="12" className="axis">
        execution price vs trade size
      </text>
    </svg>
  );
}
