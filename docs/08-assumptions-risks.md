# Bacalhau — Assumptions, Risks & Cut Plan

Decided cold, before the weekend. When time pressure hits, we execute this
file instead of debating.

## Assumptions (PoC posture)

- **This is a proof of concept.** No hardening, no backend: the app talks
  directly to the chain and the indexer from the browser, and the Graph key
  ships client-side — acceptable for a hackathon build, noted as such in the
  README. The one exception is the Uniswap key: the public Cloudflare Pages
  deployment would expose it to anyone, so market API calls go through a
  same-origin `/uniswap` proxy that attaches it server-side.
- **Demo environment:** local fork for everything shown live (shipping,
  swaps, rebalance). The indexer additionally tracks the real chain (Base) —
  where we generate a handful of real transactions — because the Graph track
  requires live network data, not fork data. Two environments, one app,
  clearly labeled in the UI.
- **Drafts** live in the browser. No accounts, no persistence beyond that.
- **One pair (WETH/USDC)** is enough for demo and judging. Multi-pair is a
  dropdown, not a design problem — skipped without guilt.
- **Auto-rebalance** = proposal while the app is open. Unattended execution
  is backlog (needs a persistent process).

## Top risks & mitigations

| # | Risk | Odds | Mitigation / fallback |
|---|---|---|---|
| R1 | **Inventory Skew opcode** misbehaves (register math, direction edge cases) | med | Fallback ready: approximate skew by composing stock instructions (asymmetric per-direction fees). Feature survives, "custom opcode" claim is dropped. Decide by Saturday noon. |
| R2 | **Indexer pipeline** (streams → indexed data) slower to stand up than hoped | med | Fallback: plain subgraph without the streaming layer. Costs the "compose 2 products" qualification — decide by Saturday evening; if triggered, dashboard still works, Graph submission becomes best-effort. |
| R3 | **No organic Aqua traffic on Base** → indexer has nothing real to show | high | Planned, not a surprise: we generate real ship + swap transactions ourselves (cents in gas). Do it Saturday, not Sunday. |
| R4 | **Canvas scope creep** (node editor is a time sink) | high | ~~The pipeline is a *linear* chain~~ — **revised**: the canvas is now a React Flow node graph, a deliberate call since branching is what makes the interesting strategies expressible at all. Mitigations kept: no undo stack, no custom edge routing, and six one-click templates that cover every demo beat, so a live wiring mistake never blocks the pitch. |
| R5 | Market API quota/latency during demo | low | Cache last good quote, show its age (per 06 freshness contract). Rebalance demo rehearsed against recorded-then-live sequence. |
| R6 | Wallet/fork weirdness on stage | med | Demo wallet pre-funded, approvals pre-granted, full rehearsal Saturday night; video recorded before Sunday as the safety net. |

## Cut order (first to go → last)

1. Oracle-Pegged block and all D2/S blocks (catalog says D1 is enough)
2. Auto-rebalance proposal (manual rebalance stays — it is a demo beat)
3. Ocean-map dashboard toggle (list view carries the demo)
4. Public shareable pages (detail page screenshot in README instead)
5. Inventory Skew as *custom opcode* → stock-composition fallback (R1)
6. Streaming layer of the indexer → plain subgraph (R2)

Never cut (the demo dies without them): canvas with D1 blocks, ship, live
dashboard with feed, test-swap panel, manual rebalance.

## Decision checkpoints

- **Sat 12:00** — skew opcode go/no-go (R1)
- **Sat 19:00** — streaming layer go/no-go (R2); real Base transactions done (R3)
- **Sat night** — full demo rehearsal on fork
- **Sun morning** — record video; freeze features, polish only
