/**
 * The copilot: ask about live strategies, get a strategy back.
 *
 * The model runs server-side (/agent) because it holds the model key and the
 * Graph key. This half is deliberately thin: it sends the conversation, shows
 * the answer, and — when the agent proposes a strategy — runs the proposal
 * through the same `validate()` the canvas uses before offering to load it.
 *
 * That validation is the point. A proposal is untrusted text until the
 * compiler agrees it is a runnable program, so a hallucinated graph shows its
 * errors here instead of becoming a shipped strategy.
 */
import { useState } from "react";

import { validate, type StrategyGraph } from "../compiler/graph";
import { reviveGraph } from "../lib/proposal";
import { strategyName } from "../lib/name";
import { fmtAmount, USDC_DECIMALS, WETH_DECIMALS } from "../lib/units";
import type { DemoState } from "../state/useDemo";

interface Proposal {
  label: string;
  rationale: string;
  graph: StrategyGraph;
}

/** A proposal the compiler rejected: kept in the thread so the user sees the
 *  agent was caught, rather than the answer silently vanishing. */
interface Rejected {
  label: string;
  reasons: string[];
}

interface Turn {
  role: "user" | "assistant";
  content: string;
  /** Which integrations answered, so the source is visible, not asserted. */
  trace?: string[];
  proposal?: Proposal;
  rejected?: Rejected;
}

const TOOL_LABELS: Record<string, string> = {
  query_strategies: "our subgraph",
  search_public_subgraphs: "Subgraph MCP · search",
  query_public_subgraph: "Subgraph MCP · query",
  propose_strategy: "proposal",
};

const EXAMPLES = [
  "Which of my strategies has taken the most flow?",
  "How much has been pulled from me today?",
  "Build me a desk that leans out of ETH above 70%",
];

/**
 * What the app can see right now, in plain text.
 *
 * The subgraph is the copilot's source for history, but the demo runs on a
 * local fork no indexer can reach, and Studio's free tier rate-limits. Handing
 * over the state the UI already has keeps the agent useful in both cases, and
 * it is honest: the reply names the subgraph only when the subgraph answered.
 *
 * The token addresses and the allocation are here because a proposal is
 * unusable without them — every branch and gate names a token, and the skew
 * targets are raw amounts the model has to scale itself.
 */
function appState(demo: DemoState, alloc: { weth: bigint; usdc: bigint }, marketPrice: bigint | null): string {
  const lines: string[] = [];
  const dep = demo.deployment;
  if (dep) {
    lines.push(`Pair: token0 WETH ${dep.weth} (18 decimals), token1 USDC ${dep.usdc} (6 decimals).`);
  }
  lines.push(
    `Allocation being composed on the canvas: ${fmtAmount(alloc.weth, WETH_DECIMALS)} WETH + ` +
      `${fmtAmount(alloc.usdc, USDC_DECIMALS)} USDC (raw: ${alloc.weth} / ${alloc.usdc}).`,
  );
  if (marketPrice !== null) {
    lines.push(`Market price from the Uniswap Trading API: ${fmtAmount(marketPrice, 18)} USDC per WETH.`);
  }
  if (demo.strategies.length === 0) {
    lines.push("No strategies are live in the connected wallet.");
  } else {
    lines.push("Strategies in the connected wallet (read over RPC, not the subgraph):");
    for (const s of demo.strategies) {
      lines.push(
        `- ${strategyName(s.hash)} (${s.hash.slice(0, 10)}…): ${s.status}, ` +
          `${fmtAmount(s.balanceWeth, WETH_DECIMALS)} WETH + ${fmtAmount(s.balanceUsdc, USDC_DECIMALS)} USDC allocated, ` +
          `${s.fills.length} fills`,
      );
    }
  }
  return lines.join("\n");
}

export function Copilot({
  demo,
  alloc,
  marketPrice,
  onLoad,
}: {
  demo: DemoState;
  alloc: { weth: bigint; usdc: bigint };
  marketPrice: bigint | null;
  onLoad: (graph: StrategyGraph) => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** One request to the agent. Returns the answer plus the raw reply text, so
   *  the caller can decide whether the conversation needs another round. */
  async function ask(messages: { role: string; content: string }[]): Promise<Turn> {
    const res = await fetch("/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, context: appState(demo, alloc, marketPrice) }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);

    const answer: Turn = { role: "assistant", content: body.reply ?? "", trace: body.trace ?? [] };
    if (!body.proposal) return answer;

    const { label = "Proposed strategy", rationale = "" } = body.proposal;
    try {
      const graph = reviveGraph(body.proposal.graph);
      const problems = validate(graph);
      if (problems.length === 0) answer.proposal = { label, rationale, graph };
      else answer.rejected = { label, reasons: problems.map((p) => p.message) };
    } catch (e) {
      answer.rejected = { label, reasons: [e instanceof Error ? e.message : String(e)] };
    }
    return answer;
  }

  async function send(text: string) {
    const question = text.trim();
    if (question === "" || busy) return;
    setDraft("");
    setError(null);
    setBusy(true);

    // Only the prose goes back to the model: proposals and traces are UI state.
    const history = [...turns, { role: "user" as const, content: question }];
    setTurns(history);

    try {
      const wire = history.map((t) => ({ role: t.role, content: t.content }));
      let answer = await ask(wire);

      // The compiler is in the loop: a rejected graph goes back with its
      // errors, once. The model fixes its own mistake far more often than the
      // user could, and one retry cannot become a loop.
      if (answer.rejected) {
        const complaint =
          `The compiler rejected that graph:\n${answer.rejected.reasons.map((r) => `- ${r}`).join("\n")}\n` +
          `Fix exactly those problems and call propose_strategy again.`;
        const repaired = await ask([...wire, { role: "assistant", content: answer.content }, { role: "user", content: complaint }]);
        // Keep the repair only if it actually compiled; otherwise the first
        // rejection is the more honest thing to show.
        if (repaired.proposal) answer = repaired;
      }

      setTurns([...history, answer]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="copilot">
      <h2>Copilot</h2>
      <p className="hint">
        Grounded in the subgraph, not in the model's memory — every answer names
        the tools it used.
      </p>

      <div className="thread">
        {turns.length === 0 &&
          EXAMPLES.map((q) => (
            <button key={q} className="example" onClick={() => send(q)}>
              {q}
            </button>
          ))}

        {turns.map((turn, i) => (
          <div key={i} className={`turn ${turn.role}`}>
            <p>{turn.content}</p>

            {turn.trace && turn.trace.length > 0 && (
              <div className="trace">
                {turn.trace.map((t, j) => (
                  <span key={j} className="pill">{TOOL_LABELS[t] ?? t}</span>
                ))}
              </div>
            )}

            {turn.proposal && (
              <div className="proposal">
                <strong>{turn.proposal.label}</strong>
                <small>{turn.proposal.rationale}</small>
                <button
                  className="go"
                  onClick={() => onLoad(turn.proposal!.graph)}
                >
                  Load on canvas
                </button>
              </div>
            )}

            {turn.rejected && (
              <div className="proposal invalid">
                <strong>{turn.rejected.label}</strong>
                <small>The compiler rejected this program, so it is not offered:</small>
                <ul className="errors">
                  {turn.rejected.reasons.map((reason, j) => (
                    <li key={j} className="warn">{reason}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}

        {busy && <div className="turn assistant"><p className="hint">thinking…</p></div>}
        {error && <p className="warn">{error}</p>}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask about your strategies…"
          disabled={busy}
        />
        <button type="submit" disabled={busy || draft.trim() === ""}>
          Ask
        </button>
      </form>
    </aside>
  );
}
