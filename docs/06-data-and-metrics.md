# Bacalhau — Data Model & Metrics

Precise definitions for every number the UI shows. If a metric is not defined
here, it does not appear on screen. All quantities are per-strategy unless
stated; wallet-level views aggregate over the wallet's strategies.

## Entities

### Strategy
| Field | Definition |
|---|---|
| id | stable unique identifier (derived from its on-chain identity) |
| owner | maker wallet address |
| pair | the two tokens quoted |
| pipeline | ordered list of blocks + parameters (as composed) |
| status | `live` · `expired` (deadline passed) · `docked` |
| shippedAt / dockedAt | timestamps |
| allocated | initial virtual balance per token |
| balances | current virtual balance per token (allocated ± fills) |

### Fill (one executed swap against a strategy)
| Field | Definition |
|---|---|
| time, txRef | when and where it happened on-chain |
| direction | which token the taker bought |
| amountIn / amountOut | taker's in/out amounts |
| realizedPrice | amountOut / amountIn, normalized to the pair's quote convention |
| marketPriceAtFill | reference market mid-price at fill time |
| edgeBps | (realizedPrice − marketPriceAtFill) / marketPriceAtFill, signed, in bps, from the maker's perspective |

### Draft
Stored locally in the browser (name, pipeline, amounts). Never leaves the
user's machine; no server-side persistence in v1.

## Metrics

### Inventory split & drift
- **split** = value share of each token in `balances`, valued at current
  market price: `value(A) / (value(A)+value(B))`.
- **target** = the strategy's target split (from Inventory Skew block if
  present, else 50/50 for curve strategies; N/A for single-direction ones).
- **drift** = |split − target|, shown as the gauge. Thresholds: green < 10pp,
  amber 10–25pp, red > 25pp (pp = percentage points). Auto-rebalance proposals
  trigger at the user-set threshold (default 20pp).

### Volume
- **fill volume** = value of amountIn at `marketPriceAtFill`, in the quote
  currency (USD-equivalent). 24h and lifetime sums shown.

### Captured edge
- per fill: `edgeBps` (defined above). Positive = maker sold above / bought
  below market.
- **strategy captured edge** = volume-weighted mean of `edgeBps` over fills.
  This is the headline "is this strategy any good" number.
- Fees are included in realizedPrice (the taker paid them), so edge already
  accounts for fee income.

### Earnings (approximation, labeled as such)
- **mark-to-market P&L** = current value of `balances` + value already
  withdrawn − value of `allocated`, all at current market price. Shown with
  an info tooltip: includes inventory revaluation, not only fees.

## Freshness contract (drives the "live" feel)

| Data | Source of truth | Max staleness on screen |
|---|---|---|
| Fills / activity feed | indexer stream | ~2 s from on-chain inclusion |
| Strategy balances | indexer | same as fills |
| Market reference price | market API | 5 s (polled), visibly ticking |
| Quotes in rebalance sheet | market API | 15 s, then forced re-quote |
| Wallet token balances | chain via wallet connection | on focus + after any action |

Rule: a value that fails to refresh shows its age ("as of 12s ago"), never
silently freezes.

## Public vs private

Public strategy page shows: pair, pipeline, status, volume, fills, captured
edge. It hides: wallet-level aggregates, earnings, drafts, rebalance controls.
Owner sees everything.
