# Bacalhau — Screens

Layout and behavior of each screen. Visual language: dark, "ocean" palette
(deep blues, aqua accents), generous motion on live data (pulses, ripples) —
the product should *feel* alive because the data is live.

## S1 — Canvas (strategy builder)

The flagship screen. Three zones:

```
┌────────────┬──────────────────────────────┬─────────────────┐
│  Palette   │        Pipeline canvas       │  Preview panel  │
│ (blocks by │  [Pricing]→[Fee]→[Deadline]  │  curve + market │
│  category) │   drag / connect / reorder   │  line + summary │
├────────────┴──────────────────────────────┴─────────────────┤
│ Footer bar: pair picker · draft name · [Save] [Ship →]      │
└──────────────────────────────────────────────────────────────┘
```

- **Palette** (left, collapsible): blocks as cards with icon, name, one-line
  description. Search box. Blocks not compatible with current pipeline are
  dimmed with a tooltip explaining why.
- **Pipeline canvas** (center): horizontal chain of connected block nodes.
  Selected block opens its parameter form in a side popover. Badges on blocks:
  error (red, blocking), warning (amber, advisory). Empty state shows 3
  one-click **templates**: "Limit order", "Passive AMM", "Dutch auction".
- **Preview panel** (right):
  - top: price-vs-size chart, one curve per direction, market reference line
    (live, subtly animated). Divergence from market highlighted with a shaded
    band and a caption ("−1.8% vs market").
  - middle: plain-language strategy summary (auto-generated sentence).
  - bottom: allocation inputs (amount per token) + projected quote at 3 sample
    sizes.
- **Ship button**: disabled until pipeline valid + amounts set; on click opens
  the review sheet (see Flow 2).

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
- **Pipeline viewer**: the strategy's blocks, read-only, same visual as canvas
  — this is what makes a shared link self-explanatory.
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
