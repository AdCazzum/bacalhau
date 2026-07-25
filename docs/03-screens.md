# QilinSwap — Screens

Layout and behavior of each screen. Visual language: dark, "ocean" palette
(deep blues, aqua accents), generous motion on live data (pulses, ripples) —
the product should *feel* alive because the data is live.

## S1 — Canvas (strategy builder)

The flagship screen. Three zones:

```
┌────────────┬──────────────────────────────┬─────────────────┐
│ Templates  │        Graph canvas          │  Preview panel  │
│     +      │   [If Direction]─then─▶[Fee] │  side switch    │
│  Palette   │        └──else──▶[Fee]──▶[×] │  curve + market │
│ (by zone)  │   drag to wire, two outputs  │  summary + bytes│
├────────────┴──────────────────────────────┴─────────────────┤
│ Allocation (WETH / USDC) · [Ship strategy →]                │
└──────────────────────────────────────────────────────────────┘
```

- **Templates** (left, top): one click loads a complete strategy, laid out
  left-to-right with branches stacked. Ones whose behaviour changes with
  direction or inventory are marked ✦ — not because they are impossible
  elsewhere, but because elsewhere they are a deployed contract.
- **Palette** (left, below): blocks as cards with zone, name, one-line
  description. Our own SwapVM instructions carry a star — the custom opcodes are
  the technical claim, so they should be visible, not buried.
- **Graph canvas** (center): a node editor, not a chain. Steps have one output;
  branch nodes have two, labelled `then` and `else`, and are drawn dashed so a
  fork is recognisable at a glance. Parameters are edited inline on the node.
  Blocks that fail validation get an amber border and the reason underneath.
  Nodes on the **live path** — the ones that would actually run for the
  previewed direction — are ringed in aqua.
- **Preview panel** (right):
  - a direction switch phrased from the maker's side ("they sell you WETH"),
    since everything else on screen addresses the maker
  - price-vs-size chart for the live path, with the live market reference line;
    divergence called out in words ("+7.8% vs market — arbitrageurs will close
    this gap")
  - plain-language summary of the live path
  - the compiled bytecode, collapsed to its size and expandable to the bytes:
    proof that a drawing became a program
  - allocation inputs, with the note that funds stay in the wallet
- **Ship button**: disabled until the graph validates and amounts are set.

## S2 — Dashboard

```
┌──────────────────────────────────────────────────────────────┐
│ Header: wallet · network · aggregate stats (TVL, 24h volume) │
├───────────────────────────────┬──────────────────────────────┤
│  Strategy list (cards/table)  │   Live activity feed         │
│  status · pair · balances ·   │   streaming swap events,     │
│  volume · inventory gauge     │   newest on top, row pulse   │
├───────────────────────────────┴──────────────────────────────┤
│ Optional "ocean map" toggle: strategies as floating bubbles, │
│ size = allocated value, pulse on every fill                  │
└──────────────────────────────────────────────────────────────┘
```

- Strategy card: pair icons, status pill, virtual balances, sparkline of
  volume, **inventory gauge** (horizontal bi-color bar with target marker),
  quick actions (view / rebalance / dock).
- Activity feed item: time-ago, strategy name, direction arrow, amounts,
  realized price. New items slide in; the source card flashes once.
- Empty state: friendly push to the Canvas with template shortcuts.

## S3 — Strategy detail (private) / public page

Same layout; public page hides actions and wallet-level data.

- Header: name, pair, status, share button (public link), actions
  (**Rebalance**, **Dock**, **Re-ship**).
- KPI row: allocated value, lifetime volume, fills, captured edge vs market.
- Charts (tabbed): fills on price timeline (strategy price vs market price),
  inventory over time, cumulative volume.
- **Graph viewer**: the strategy's blocks and branches, read-only, same visual
  as the canvas — this is what makes a shared link self-explanatory, and it
  shows a reader which leg their trade would take.
- Fill table: time, direction, in/out amounts, realized price, vs-market delta.
- **Execute test swap** panel (owner only): direction, size, quoted result,
  execute button. Results append to feed/table live.

## S4 — Rebalance sheet (modal over S2/S3)

- Current split vs target split (draggable target slider).
- Proposed corrective swap: sell X for Y, quoted market rate, price impact,
  post-trade split preview.
- Auto-rebalance toggle: threshold slider, plain-language recap
  ("If inventory drifts past 70/30, propose a corrective swap").
- Confirm button with quote-freshness countdown; expired quote re-fetches.

## S5 — Onboarding / first run

- One screen, three panels, skippable: "Your funds stay in your wallet" /
  "Compose, don't code" / "Watch it live". No account creation; connect wallet
  is the only entry gate, and browsing dashboards/public pages works without
  connecting.

## Cross-cutting

- **Live-ness is a feature**: any number that can change on-chain updates
  without refresh, with a subtle animation. Never a spinner over stale data.
- **Plain language everywhere**: every block, warning and review sheet has a
  one-sentence human explanation. Jargon in tooltips, not in the main path.
- **Danger affordances**: shipping and docking are explicit, reviewable,
  reversible-by-design actions; nothing executes on a single misclick.
- Responsive down to tablet; the canvas is desktop-first (hackathon demo runs
  on a laptop + projector).
