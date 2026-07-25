/**
 * One canvas node. Renders its own parameters inline and exposes typed ports:
 * a single output for steps, `then`/`else` for branches — so an invalid shape is
 * hard to draw in the first place, and the compiler's validation is the backstop
 * rather than the only line of defence.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { formatUnits, parseUnits } from "viem";

import { BPS } from "../compiler/opcodes";
import { isBranch, type GraphNode } from "../compiler/graph";
import { fromSqrtPriceX18, toSqrtPriceX18, type Token } from "../lib/price";
import { PALETTE } from "./nodeKinds";

export interface StrategyNodeData extends Record<string, unknown> {
  node: GraphNode;
  /** Validation messages for this node, if any. */
  problems: string[];
  /** True when this node runs for the direction currently previewed. */
  live: boolean;
  base: Token;
  quote: Token;
  /** Quote units per base unit, used to read targets as a share of VALUE. */
  price: number;
  onChange: (node: GraphNode) => void;
  onRemove: (id: string) => void;
}

const label = (kind: GraphNode["kind"]) => PALETTE.find((p) => p.kind === kind);

/**
 * Targets are raw amounts of two tokens with different decimals, so a share has
 * to be computed on VALUE — comparing raw units would report ~100% WETH for any
 * sane split, since 1e18 dwarfs 1e6.
 */
function splitOf(
  target0: bigint,
  target1: bigint,
  base: Token,
  quote: Token,
  price: number,
): { baseUnits: number; quoteUnits: number; baseValue: number; quoteValue: number } {
  const baseIsToken0 = base.address.toLowerCase() < quote.address.toLowerCase();
  const baseRaw = baseIsToken0 ? target0 : target1;
  const quoteRaw = baseIsToken0 ? target1 : target0;
  const baseUnits = Number(baseRaw) / 10 ** base.decimals;
  const quoteUnits = Number(quoteRaw) / 10 ** quote.decimals;
  return { baseUnits, quoteUnits, baseValue: baseUnits * price, quoteValue: quoteUnits };
}

function sharePercent(
  target0: bigint,
  target1: bigint,
  base: Token,
  quote: Token,
  price: number,
): string {
  const s = splitOf(target0, target1, base, quote, price);
  const total = s.baseValue + s.quoteValue;
  return total > 0 ? ((s.baseValue / total) * 100).toFixed(0) : "0";
}

/**
 * Inverse of {@link sharePercent}: rotate the mix to the requested share while
 * holding total value constant, so editing the number never silently resizes
 * the strategy.
 */
function retarget(
  node: { target0: bigint; target1: bigint },
  percent: string,
  base: Token,
  quote: Token,
  price: number,
): { target0: bigint; target1: bigint } {
  const share = Math.min(Math.max(Number(percent) || 0, 1), 99) / 100;
  const s = splitOf(node.target0, node.target1, base, quote, price);
  const total = s.baseValue + s.quoteValue;
  if (total <= 0 || price <= 0) return { target0: node.target0, target1: node.target1 };

  const wantBase = (total * share) / price;
  const wantQuote = total * (1 - share);
  const baseRaw = BigInt(Math.max(1, Math.round(wantBase * 10 ** base.decimals)));
  const quoteRaw = BigInt(Math.max(1, Math.round(wantQuote * 10 ** quote.decimals)));
  return base.address.toLowerCase() < quote.address.toLowerCase()
    ? { target0: baseRaw, target1: quoteRaw }
    : { target0: quoteRaw, target1: baseRaw };
}

export function StrategyNode({ data, id }: NodeProps & { data: StrategyNodeData }) {
  const { node, problems, live, onChange, onRemove, base, quote, price } = data;
  const meta = label(node.kind);
  const branch = isBranch(node);
  const classes = ["node", branch ? "branch" : "step"];
  if (problems.length > 0) classes.push("invalid");
  if (live) classes.push("live");

  return (
    <div className={classes.join(" ")}>
      <Handle type="target" position={Position.Left} />
      <header>
        <span>
          {meta?.label ?? node.kind}
          {meta?.custom && <em title="custom SwapVM instruction"> ★</em>}
        </span>
        <button className="x" onClick={() => onRemove(id)} title="remove">
          ×
        </button>
      </header>

      {node.kind === "flatFee" && (
        <label>
          fee %
          <input
            value={((node.feeBps / BPS) * 100).toString()}
            onChange={(e) =>
              onChange({ ...node, feeBps: Math.round((Number(e.target.value) / 100) * BPS) || 0 })
            }
          />
        </label>
      )}

      {node.kind === "inventorySkew" && (
        <>
          <label>
            target % WETH by value
            <input
              value={sharePercent(node.target0, node.target1, base, quote, price)}
              onChange={(e) =>
                onChange({ ...node, ...retarget(node, e.target.value, base, quote, price) })
              }
            />
          </label>
          <label>
            max tilt %
            <input
              value={((node.maxSkewBps / BPS) * 100).toString()}
              onChange={(e) =>
                onChange({
                  ...node,
                  maxSkewBps: Math.round((Number(e.target.value) / 100) * BPS) || 0,
                })
              }
            />
          </label>
        </>
      )}

      {node.kind === "ifInventoryAbove" && (
        <label>
          above % WETH by value
          <input
            value={sharePercent(node.target0, node.target1, base, quote, price)}
            onChange={(e) =>
              onChange({ ...node, ...retarget(node, e.target.value, base, quote, price) })
            }
          />
        </label>
      )}

      {node.kind === "priceRange" && (
        <>
          <label>
            min price
            <input
              value={fromSqrtPriceX18(node.sqrtPriceMinX18, base, quote).toFixed(2)}
              onChange={(e) => onChange({ ...node, sqrtPriceMinX18: safeBound(e.target.value, base, quote, node.sqrtPriceMinX18) })}
            />
          </label>
          <label>
            max price
            <input
              value={fromSqrtPriceX18(node.sqrtPriceMaxX18, base, quote).toFixed(2)}
              onChange={(e) => onChange({ ...node, sqrtPriceMaxX18: safeBound(e.target.value, base, quote, node.sqrtPriceMaxX18) })}
            />
          </label>
        </>
      )}

      {node.kind === "flowDecay" && (
        <label>
          heals over (s)
          <input
            value={node.periodSeconds.toString()}
            onChange={(e) => onChange({ ...node, periodSeconds: Number(e.target.value) || 0 })}
          />
        </label>
      )}

      {node.kind === "deadline" && (
        <label>
          expires
          <input
            type="datetime-local"
            value={toLocalInput(node.timestamp)}
            onChange={(e) =>
              onChange({ ...node, timestamp: Math.floor(new Date(e.target.value).getTime() / 1000) })
            }
          />
        </label>
      )}

      {node.kind === "holderGate" && (
        <>
          <label>
            token
            <input
              value={node.token}
              onChange={(e) => onChange({ ...node, token: e.target.value as `0x${string}` })}
            />
          </label>
          <label>
            min balance
            <input
              value={formatUnits(node.minBalance, quote.decimals)}
              onChange={(e) => onChange({ ...node, minBalance: safeParse(e.target.value, quote.decimals, node.minBalance) })}
            />
          </label>
        </>
      )}

      {node.kind === "ifDirection" && (
        <label>
          taker pays in
          <select
            value={node.token}
            onChange={(e) => onChange({ ...node, token: e.target.value as `0x${string}` })}
          >
            <option value={base.address}>WETH</option>
            <option value={quote.address}>USDC</option>
          </select>
        </label>
      )}

      {node.kind === "constantProduct" && <p className="hint">prices the swap</p>}

      {problems.length > 0 && <p className="warn">{problems[0]}</p>}

      {branch ? (
        <div className="ports">
          <span className="port then">
            then
            <Handle type="source" id="then" position={Position.Right} />
          </span>
          <span className="port else">
            else
            <Handle type="source" id="else" position={Position.Right} />
          </span>
        </div>
      ) : (
        <Handle type="source" position={Position.Right} />
      )}
    </div>
  );
}

function safeBound(input: string, base: Token, quote: Token, fallback: bigint): bigint {
  try {
    return toSqrtPriceX18(input, base, quote);
  } catch {
    return fallback; // mid-typing values must not blow up the canvas
  }
}

function safeParse(input: string, decimals: number, fallback: bigint): bigint {
  try {
    return parseUnits(input === "" ? "0" : input, decimals);
  } catch {
    return fallback;
  }
}

function toLocalInput(unix: number): string {
  const d = new Date(unix * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
