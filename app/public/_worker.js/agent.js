/**
 * The copilot's server half: an LLM tool loop that answers questions about
 * live strategies and proposes new ones.
 *
 * Server-side because it holds two secrets (the model key and the Graph key)
 * and because the browser cannot speak MCP's JSON-RPC to a third-party origin
 * without CORS. Shared verbatim by the Vite dev middleware and the Cloudflare
 * worker, so there is one implementation of the loop rather than two that
 * drift.
 *
 * Plain JS with no imports for the same reason as public/_worker.js: it has to
 * run unbundled inside the worker.
 *
 * The model never signs anything. Its only write is `propose_strategy`, which
 * returns a strategy graph as JSON; the browser validates it with the same
 * compiler the canvas uses and the user ships it by hand. A hallucinated graph
 * fails validation like any other malformed input.
 */

/** OpenAI-compatible by default: works with OpenAI, Groq, OpenRouter, Together,
 *  or anything else that speaks /chat/completions. */
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
/** A tool loop that cannot terminate burns the key; four rounds is enough for
 *  "look it up, look up the market, then answer". */
const MAX_ROUNDS = 4;

const SYSTEM_PROMPT = `You are the QilinSwap copilot, embedded in a dapp for composing market-making strategies on 1inch Aqua.

A strategy is a graph of SwapVM instructions that compiles to bytecode. The maker's funds stay in their own wallet; Aqua only tracks a virtual balance allocated to each strategy.

Node kinds you may use in a proposal:
- constantProduct: the x*y=k pricing core. Every runnable path needs exactly one.
- flatFee { feeBps }: a fixed fee. Despite the name the unit is 1e9 = 100%, matching SwapVM's Fee.sol: 0.3% is feeBps = 3000000, 0.05% is 500000.
- flowDecay { periodSeconds }: fee that grows with trade size and decays over the period.
- inventorySkew { target0, target1, maxSkewBps }: custom opcode 0x22, tilts the quote toward a target inventory split. target0/target1 are RAW token amounts (token0 has 18 decimals, token1 has 6), and only their ratio matters: a 30/70 value split at 3000 USDC per WETH is target0 = 1000000000000000000, target1 = 7000000000. maxSkewBps uses the same 1e9 basis and must not exceed 100000000 (10%).
- ifDirection { token }: branch, true when the taker pays that token in.
- ifInventoryAbove { target0, target1 }: custom opcode 0x23, branch on the current inventory split.
- deadline { timestamp }: unix seconds after which the strategy stops quoting.
- holderGate { token, minBalance }: the taker must hold at least minBalance.

Edges are { from, to } and are directed. An edge leaving a BRANCH node must carry port: "then" or port: "else" — those two strings exactly, and a branch needs one of each. An edge leaving any other node must omit port entirely.

Ordering rules the compiler enforces: fees, skew, range and gates run BEFORE the constantProduct node on their path; an inventory branch must come before anything that moves balances; the graph must be acyclic and every path must terminate.

Answer questions about live strategies using the tools, never from memory. Quote real numbers you fetched. Be concise: a trader is reading, not a student.

If a tool returns an error, do not call it again with the same arguments. Say plainly which source failed and answer from what you do have, including the app state given to you.

When the user asks for a strategy, call propose_strategy with the full graph. Explain in one sentence what it does differently from a plain pool. Never claim a strategy is profitable.`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "query_strategies",
      description:
        "Run a GraphQL query against QilinSwap's own subgraph (Aqua strategies and fills on Base Sepolia, indexed by The Graph). Use it for anything about the user's live strategies: status, fill counts, volumes, recent movements.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "GraphQL query. Entities: strategies(first, orderBy, orderDirection) { id maker program status shippedAt dockedAt fillCount volume { token pulled pushed } }, fills(first, orderBy, orderDirection) { id direction token amount timestamp txHash strategy { id } }, protocol(id: \"aqua\") { strategyCount fillCount }, _meta { block { number } }. PULL means tokens LEFT the maker's wallet (the taker received them); PUSH means tokens ARRIVED in the maker's wallet. Amounts are raw units of the token named beside them: WETH 0x0f599727f37d4fc8ab5dbd3afe86c3ebf4a892f7 has 18 decimals, USDC 0xb6ec46c767b71a5aa4b51bad4a40827560d63e55 has 6. Scale per token before quoting a figure, and never add two tokens together.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_public_subgraphs",
      description:
        "Search The Graph Network for public subgraphs by keyword or contract address, via the official Subgraph MCP server. Use it to find market context the project's own subgraph does not have, such as Uniswap pool liquidity on Base.",
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "Search term, e.g. \"uniswap v3 base\"." },
        },
        required: ["keyword"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_public_subgraph",
      description:
        "Execute a GraphQL query against a public subgraph deployment found with search_public_subgraphs, via the official Subgraph MCP server.",
      parameters: {
        type: "object",
        properties: {
          deploymentId: { type: "string", description: "The Qm... deployment id returned by the search." },
          query: { type: "string", description: "GraphQL query to run against that deployment." },
        },
        required: ["deploymentId", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_strategy",
      description:
        "Propose a strategy for the user to review on the canvas. The graph is validated by the compiler before it is shown; nothing is signed or shipped automatically.",
      parameters: {
        type: "object",
        properties: {
          label: { type: "string", description: "Short name, e.g. \"Fee-heavy two-sided desk\"." },
          rationale: { type: "string", description: "One sentence: what this does that a plain pool cannot." },
          graph: {
            type: "object",
            description: "StrategyGraph: { nodes: [{ id, kind, ...params }], edges: [{ from, to, port? }] }.",
            properties: {
              nodes: { type: "array", items: { type: "object" } },
              edges: { type: "array", items: { type: "object" } },
            },
            required: ["nodes", "edges"],
          },
        },
        required: ["label", "rationale", "graph"],
      },
    },
  },
];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** GraphQL against our own Studio deployment. */
async function queryStrategies(env, args) {
  const url = env.GRAPH_SUBGRAPH_URL;
  if (!url) return { error: "GRAPH_SUBGRAPH_URL is not configured" };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: args.query }),
  });
  if (!res.ok) return { error: `subgraph HTTP ${res.status}` };
  return await res.json();
}

/**
 * A session against the hosted Subgraph MCP server.
 *
 * The server speaks MCP's HTTP+SSE transport, not the newer streamable one:
 * `GET /sse` returns a stream whose first frame names a `/messages?sessionId=`
 * endpoint, POSTs there are answered with 202, and the actual JSON-RPC results
 * arrive back on the open stream. So a call is only meaningful inside a live
 * session, and the session has to outlive the POST — hence this object rather
 * than a stateless helper.
 */
class McpSession {
  constructor(base, key) {
    this.base = base;
    this.key = key;
    this.endpoint = null;
    this.reader = null;
    this.buffer = "";
    /** id -> { resolve, reject }, for results that arrive out of order on one stream. */
    this.pending = new Map();
    /** Set by fail(): the stream died, so no reply can ever arrive again. */
    this.dead = null;
  }

  async open() {
    const res = await fetch(`${this.base}/sse`, {
      headers: { Accept: "text/event-stream", Authorization: `Bearer ${this.key}` },
    });
    if (!res.ok || !res.body) throw new Error(`MCP stream HTTP ${res.status}`);
    this.reader = res.body.getReader();
    this.decoder = new TextDecoder();
    this.pump();
    this.endpoint = await this.awaitEndpoint();
    // Register the waiter before POSTing: the reply arrives on the SSE
    // stream and can beat the POST's 202, in which case pump() would find
    // no one to wake and drop it.
    const ready = this.result(1);
    try {
      await this.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "qilinswap-copilot", version: "1.0" },
        },
      });
    } catch (e) {
      this.pending.delete(1);
      throw e;
    }
    await ready;
    await this.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }

  /** Reads frames forever; each frame's `data:` lines form one JSON-RPC message. */
  async pump() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.buffer += this.decoder.decode(value, { stream: true });
        let match;
        // Frames end at a blank line; servers may frame with LF or CRLF. A
        // partial delimiter at the buffer's tail cannot match (both newlines
        // are required), so splitting is safe across chunk boundaries.
        while ((match = this.buffer.match(/\r?\n\r?\n/))) {
          const frame = this.buffer.slice(0, match.index);
          this.buffer = this.buffer.slice(match.index + match[0].length);
          const lines = frame.split(/\r?\n/);
          // Multi-line data is one payload the server split across lines:
          // rejoin with the newlines SSE framing removed, minus the one
          // optional space after each "data:".
          const data = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
          if (data === "") continue;
          if (lines.some((line) => /^event: ?endpoint\s*$/.test(line))) {
            this.endpointResolve?.(data.trim());
            continue;
          }
          try {
            const message = JSON.parse(data);
            const waiter = this.pending.get(message.id);
            if (waiter) {
              this.pending.delete(message.id);
              waiter.resolve(message);
            }
          } catch {
            // a keep-alive or a frame we do not model: nothing to do
          }
        }
      }
      this.fail(new Error("MCP stream closed"));
    } catch (e) {
      // A dead stream can never answer: fail in-flight calls now instead of
      // letting each one ride its 45s timeout.
      this.fail(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /** Reject every in-flight waiter and mark the session unusable. */
  fail(err) {
    this.dead = err;
    this.endpointReject?.(err);
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  awaitEndpoint() {
    return new Promise((resolve, reject) => {
      this.endpointResolve = resolve;
      this.endpointReject = reject;
      setTimeout(() => reject(new Error("MCP did not announce an endpoint")), 10000);
    });
  }

  async send(message) {
    const res = await fetch(`${this.base}${this.endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.key}` },
      body: JSON.stringify(message),
    });
    // 202 Accepted: the answer comes back on the stream, not here.
    if (res.status >= 400) throw new Error(`MCP POST HTTP ${res.status}`);
  }

  result(id) {
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`MCP call ${id} timed out`));
      }, 45000);
    });
  }

  async call(name, args) {
    if (this.dead) throw this.dead;
    const id = this.nextId();
    // Register the waiter before POSTing: the reply arrives on the SSE
    // stream and can beat the POST's 202, in which case pump() would find
    // no one to wake and drop it.
    const reply = this.result(id);
    try {
      await this.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    } catch (e) {
      this.pending.delete(id);
      throw e;
    }
    const message = await reply;
    if (message.error) return { error: message.error.message ?? "MCP error" };
    // Tool results are content blocks; the text block is the payload.
    const text = (message.result?.content ?? []).map((c) => c.text ?? "").join("\n");
    return text === "" ? message.result : { result: text };
  }

  nextId() {
    this.counter = (this.counter ?? 1) + 1;
    return this.counter;
  }

  close() {
    this.reader?.cancel().catch(() => {});
  }
}

/** One session per request, opened only if the model actually reaches for it. */
async function mcpCall(state, env, name, args) {
  const key = env.GRAPH_API_KEY;
  if (!key) return { error: "GRAPH_API_KEY is not configured" };
  try {
    // A session whose stream died mid-request cannot answer again: drop it
    // so this call opens a fresh one instead of riding timeouts.
    if (state.mcp?.dead) {
      state.mcp.close();
      state.mcp = null;
    }
    if (!state.mcp) {
      const session = new McpSession(env.GRAPH_MCP_URL || "https://subgraphs.mcp.thegraph.com", key);
      try {
        await session.open();
      } catch (e) {
        session.close();
        throw e;
      }
      // Cache only after the handshake succeeds: a session that failed to
      // open never reaches `state`, so the next tool call retries fresh.
      state.mcp = session;
    }
    return await state.mcp.call(name, args);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function runTool(state, env, name, args) {
  switch (name) {
    case "query_strategies":
      return await queryStrategies(env, args);
    case "search_public_subgraphs":
      return await mcpCall(state, env, "search_subgraphs_by_keyword", { keyword: args.keyword });
    case "query_public_subgraph":
      return await mcpCall(state, env, "execute_query_by_deployment_id", {
        deployment_id: args.deploymentId,
        query: args.query,
      });
    default:
      return { error: `unknown tool ${name}` };
  }
}

/**
 * Handle POST /agent. Body: { messages: [{ role, content }], context? }.
 * Returns { reply, proposal, trace } — `trace` names every tool the model
 * called, so the UI can show which integration answered rather than asking
 * anyone to trust the prose.
 */
export async function handleAgent(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (!env.LLM_API_KEY) return json({ error: "LLM_API_KEY is not configured" }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const history = Array.isArray(body.messages) ? body.messages : [];
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  if (body.context) {
    messages.push({ role: "system", content: `Current app state:\n${body.context}` });
  }
  messages.push(...history);

  const base = env.LLM_BASE_URL || DEFAULT_BASE_URL;
  const model = env.LLM_MODEL || DEFAULT_MODEL;
  const trace = [];
  let proposal = null;
  // Holds the MCP session, opened lazily and closed on every exit path below.
  const state = {};

  const finish = (payload, status) => {
    state.mcp?.close();
    return json(payload, status);
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.LLM_API_KEY}`,
      },
      body: JSON.stringify({ model, messages, tools: TOOLS, temperature: 0.2 }),
    });

    if (!res.ok) {
      const detail = await res.text();
      return finish({ error: `model HTTP ${res.status}: ${detail.slice(0, 300)}` }, 502);
    }

    const completion = await res.json();
    const choice = completion.choices?.[0]?.message;
    if (!choice) return finish({ error: "model returned no message" }, 502);
    messages.push(choice);

    const calls = choice.tool_calls ?? [];
    if (calls.length === 0) {
      return finish({ reply: choice.content ?? "", proposal, trace });
    }

    for (const call of calls) {
      const name = call.function?.name;
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch {
        // fall through with empty args: the tool reports the problem back to
        // the model, which can retry with a well-formed call
      }
      trace.push(name);

      // The proposal is not fetched from anywhere: it is the model's answer,
      // handed to the client for validation.
      const result =
        name === "propose_strategy"
          ? ((proposal = { label: args.label, rationale: args.rationale, graph: args.graph }),
            { ok: true, note: "shown to the user for review" })
          : await runTool(state, env, name, args);

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result).slice(0, 8000),
      });
    }
  }

  return finish({
    reply: "I could not finish that within the tool budget — try a narrower question.",
    proposal,
    trace,
  });
}
