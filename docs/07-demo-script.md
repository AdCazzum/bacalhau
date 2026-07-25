# QilinSwap — Demo Script (video ≤ 4 min, live pitch 3 min)

One script serves both the recorded video and the live judging table. Every
beat names what is on screen and what is said. No beat depends on luck: all
on-chain actions run against our prepared environment, rehearsed.

## Cast & setup (before recording)

- `nix run .#dev` running: Base fork, contracts deployed, seed strategy live so
  the dashboard is never empty. A terminal is NEVER shown.
- Demo wallet is the anvil account the app already signs with — no extension,
  no approval theatre (mention approvals, never perform them).
- Market overlay live. If the Uniswap proxy is flaky, the curve still renders;
  don't wait for the dashed line on camera.
- Browser at 1080p+, the app opens on the Canvas.

## Script

### Beat 0 — Cold open (0:00–0:15)
Screen: Dashboard, seed strategy with fills in the feed.
Line: "This is a market-making strategy earning fees right now. Its owner wrote
zero code, deployed zero contracts, and the funds are still in their own wallet.
Here's how it's built."

### Beat 1 — It's a graph, not a form (0:15–1:00)
Screen: Canvas → template **Two-sided desk**. Then click the two preview
buttons — *they sell you WETH* / *they buy WETH from you* — and let the
highlighted path and the fee in the summary flip: 0.05% one way, 0.5% the other.
Line: "A strategy here is a program with branches. This one quotes each side of
the book differently: cheap for whoever sells me ETH, expensive for whoever buys
it. You could write that as a Uniswap v4 hook — but then it's a contract you
deploy, and it binds every LP in the pool. This is bytecode, it's mine alone,
and the highlight is the path the VM would actually run."

### Beat 2 — Our own instruction (1:00–1:40)
Screen: template **Adaptive desk**, six nodes. Point at `If Inventory Above 70%`
and its two legs. Open the bytecode disclosure and point at the leading `23`.
Line: "Branching on the trade is one thing; branching on *state* needs an
instruction that doesn't exist. So we wrote it. Opcode 0x23 asks 'am I holding
more than 70% ETH?' — below, accumulate at five basis points; above, flip to
distributing at fifty. That's our bytecode, and 0x23 is our opcode, running on
1inch's VM."

### Beat 3 — Ask for it in English (1:40–2:20)
Screen: the Copilot panel on the Canvas.
1. Click *"How does my 0.05% fee compare to the real WETH/USDC pools on Base?"*
   — ~10s, comes back with the four Uniswap V3 fee tiers, their TVL and volume.
   Point at the two **Subgraph MCP** pills under the answer.
2. Click *"Build me a desk that leans out of ETH above 70%"*, then **Load on
   canvas** — the graph appears, the bytecode counter fills, Ship lights up.
Line: "First question is market research: it went out to The Graph Network
through the official Subgraph MCP and came back with real Base liquidity —
those tags name the source, live, right now. Second one writes the strategy.
It doesn't sign anything: it hands back a program, our compiler checks it, and
only then can I ship it. A graph it gets wrong is rejected right here."

### Beat 4 — Ship it (2:20–2:35)
Screen: Ship strategy → lands on the Dashboard, new card beside the seed one.
Line: "One signature, no deposit. My tokens haven't moved — Aqua just recorded a
budget it can draw on when a trade actually executes."

### Beat 5 — The state machine flips, on-chain (2:35–3:15)
**The money shot.** Screen: test-swap panel on the new card.
1. Quote 1 WETH → say the number out loud.
2. Swap 6 WETH → balances move, the inventory bar crosses 70%.
3. Quote 1 WETH again → visibly worse.
Line: "I'll play the counterparty. First quote, accumulation mode. Now I sell it
six ETH — watch the inventory bar cross seventy percent. Same quote again, and
the price is worse: the strategy took the other branch. That decision happened
inside the VM, on-chain, in our own instruction."

### Beat 6 — Correct the drift (3:15–3:37)
Screen: Wallet inventory banner amber → Preview (Uniswap route appears) →
Rebalance → gauge moves.
Line: "Trading all day leaves me lopsided. The Uniswap API quotes and routes the
corrective swap, and it executes against real Base liquidity — that's a live
route, not a mock."

### Beat 7 — Close (3:37–3:58)
Screen: the Indexed page (endpoint + query + rows), then a quick pan over the
README.
Line: "Aqua had no indexer, so we built one: a reusable Substreams module and a
subgraph over the same events, both live — and an agent that reads them. Here's
the endpoint and the exact query, so you can run it yourself. QilinSwap:
liquidity strategies for people who don't write Solidity."

## Judge Q&A prep (live table only)

Likely questions, one-line answers ready:
- "What are your custom instructions?" → two: **0x22 Inventory Skew** (price
  tilt proportional to distance from the target split) and **0x23 If Inventory
  Above** (the state branch). Both appended to the official Aqua opcode table,
  never inserted, so existing bytecode keeps its meaning.
- **"Isn't this just a v4 hook?"** — the question to want, especially from the
  Uniswap table. Concede immediately: a hook expresses everything we show, and
  more. Three differences, in order of strength: a hook is **per-pool**, so its
  rules bind every LP in it, while a program here is **per-maker** — two makers
  on the same pair can run opposite strategies; a hook is a **contract you
  deploy and own the risk of**, ours is data run by an already-audited VM; and
  the funds stay in the maker's wallet, backing several strategies at once.
  Never claim we can do something Uniswap cannot — we cannot, and they know it.
- "Why is the dashboard showing different numbers from the canvas?" → two
  chains on purpose: the live demo runs on a local Base fork, while the Graph
  panel indexes our real Base Sepolia deployment. An indexer cannot see anvil.
- "Is the indexed data real?" → yes, and we generated the on-chain traffic
  ourselves because Aqua has no organic testnet volume; offer the Studio
  endpoint so they can run the query themselves.
- "Did you really compose two Graph products?" → Substreams module plus a
  subgraph over the same events. Be upfront: we planned a substreams-powered
  subgraph, and Studio now rejects those outright — quote the error.
- **"Does the copilot use the Subgraph MCP on your own data?"** — no, and say
  so first: the MCP resolves deployments published to the Network, ours is on
  Studio, so our strategies come over GraphQL and the MCP brings market context
  from public subgraphs. Both are named in the UI under every answer. Offer the
  reason we did not publish: it needs Arbitrum gas plus GRT signal to get an
  indexer, and unindexed publishing would have been theatre.
- "What stops the model hallucinating a strategy?" → nothing stops it
  proposing one; the compiler stops it shipping. Every proposal is rebuilt
  field by field (`app/src/lib/proposal.ts`, 112 tests) and then run through
  the same `validate()` the canvas uses. A rejected graph is sent back once
  with those errors, and if it still fails we show the rejection instead of a
  Load button. The model never signs — the user presses Ship.
- "Aren't loops missing?" → deliberate. The Aqua opcode table has no arithmetic
  or register comparison, so a back edge could never compute an exit condition;
  the validator rejects cycles. Backward jumps in the emitted bytecode are joins.
- "How do you know the bytecode is right?" → a golden vector pinned identically
  in Solidity and TypeScript, plus a test that walks every jump target and
  proves it lands on an instruction boundary.
- "What happens with two strategies on the same funds?" → that's Aqua's core
  feature: the same wallet balance backs both; show it if asked.
- "Why would 1inch want this?" → the missing application layer their track asks
  for, plus a reusable indexer their ecosystem lacks.

## Recording rules

- 1080p minimum, cursor visible, no dead air > 2 s, captions for key terms.
- Record beats separately; cut together. Keep a full uncut fallback take.
- Absolute cap 3:50 — Graph's limit is 4:00 and we do not gamble the buffer.
