# Bacalhau — Demo Script (video ≤ 4 min, live pitch 3 min)

One script serves both the recorded video and the live judging table. Every
beat names what is on screen and what is said. No beat depends on luck: all
on-chain actions run against our prepared environment, rehearsed.

## Cast & setup (before recording)

- Wallet funded with WETH + USDC, approvals already granted (approval flow is
  *mentioned*, not performed — it burns 20 boring seconds).
- One older strategy already live with a few fills, so the dashboard is not
  empty at first sight.
- Market price feed live; indexer synced; a terminal is NEVER shown.

## Script

### Beat 0 — Cold open (0:00–0:20)
Screen: dashboard of the pre-existing strategy, feed pulsing with a fill.
Line: "This is a market-making strategy earning fees right now. Its owner
wrote zero code, deployed zero contracts, and the funds are still sitting in
their own wallet. Let me build one from scratch."

### Beat 1 — Compose (0:20–1:10)
Screen: Canvas. Pick WETH/USDC → template "Self-balancing MM" → pipeline
appears: Constant-Product → Inventory Skew → Flat Fee → Deadline.
Actions: tweak fee 0.3%, watch curve move against the live market line.
Line: "Each block is a real on-chain instruction. The curve is my strategy;
the moving line is the live market. And this block — Inventory Skew — is an
instruction we built ourselves: it makes the strategy fight its own
imbalance."

### Beat 2 — Ship (1:10–1:40)
Screen: review sheet → wallet signature → strategy live on dashboard.
Line: "One signature. No deposit — my tokens haven't moved; I've granted the
strategy a budget it can draw on only when a trade actually executes."

### Beat 3 — Trade against it, live (1:40–2:30)
Screen: detail page, "Execute test swap" panel; execute a taker swap.
The activity feed pulses, fill appears, counters move. Execute a second,
larger swap in the opposite balance direction.
Line: "I'll play the taker. Watch the dashboard — that pulse is the swap
landing on-chain, indexed and streamed back in about a second. Volume, fills,
captured edge: everything you see is live chain data, nothing is mocked."

### Beat 4 — Drift & rebalance (2:30–3:20)
Screen: inventory gauge amber after the swaps. Open Rebalance sheet: proposed
corrective swap at best market rate, post-trade preview → confirm → gauge
back to green.
Line: "Selling all day leaves you lopsided. The skew block softens it; what
remains, I fix in one click — the app routes the corrective trade at the best
market price. Compose, observe, correct: the full loop, no code."

### Beat 5 — Close (3:20–3:50)
Screen: public strategy page + quick pan over the repo README.
Line: "Every strategy has a public page anyone can audit. Under the hood:
strategies compile to 1inch SwapVM programs on Aqua, the live data is a
Substreams-powered subgraph — the first indexer for Aqua, reusable by anyone —
and rebalancing routes through the Uniswap API. Bacalhau: liquidity
strategies for people who don't write Solidity."

## Judge Q&A prep (live table only)

Likely questions, one-line answers ready:
- "What exactly is your custom instruction?" → Inventory Skew: price tilt
  proportional to distance from target inventory; show the block's params.
- "Is the dashboard real data?" → yes: open the subgraph playground and run
  the same query judges can run.
- "What happens with two strategies on the same funds?" → that's Aqua's core
  feature: same wallet balance can back both; show two strategies sharing one
  wallet if asked.
- "Why would 1inch want this?" → it's the missing application layer their
  track is asking for + a reusable indexer their ecosystem lacks.

## Recording rules

- 1080p minimum, cursor visible, no dead air > 2 s, captions for key terms.
- Record beats separately; cut together. Keep a full uncut fallback take.
- Absolute cap 3:50 — Graph's limit is 4:00 and we do not gamble the buffer.
