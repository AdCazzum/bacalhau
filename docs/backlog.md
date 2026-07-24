# Backlog — deferred ideas (not in scope now)

Parking lot. Nothing here is planned for the hackathon base build; revisit
only after the D1 catalog works end to end.

## TradFi-inspired strategies (narrative or light additions)

- **Cash-secured put synthetic** — Oracle-Pegged(−offset) + Min Rate +
  Deadline. Zero new blocks; it is a framing of an existing pipeline.
- **Covered call synthetic** — Oracle-Pegged(+offset) sell-side + Flat Fee +
  Deadline. Pairs with the put into a self-custodial collar.
- **Iceberg order** — show only a tranche; Studio re-ships the next tranche
  when one fills. App-level orchestration (dock/ship), no new instruction.
- **Block-trade / RFQ tier** — Taker Balance Gate + size-*decreasing* fee:
  large trades get desk treatment instead of being punished.

## Additional custom instructions (beyond Inventory Skew)

- **Avellaneda-Stoikov time term** — extend skew with time-decay: spread
  tightens as deadline approaches. "First self-custodial A-S MM on-chain."
- **Volatility-adaptive spread** — widen fees on realized oracle moves.
  Strong product case (anti toxic-flow), delicate implementation.

## Larger features

- Grid trading (needs conditional jumps; N parallel Fixed Rate strategies on
  shared Aqua balance is a viable approximation already)
- CPPI / portfolio insurance (keeper-driven, not instruction-driven)
- True TWAP / VWAP execution
- Auto-rebalance as always-on service (needs a persistent backend process)
- ENS naming for strategies (subnames + text records) — was evaluated as a
  4th sponsor; dropped for the 3-sponsor cap

## Stock SwapVM instructions discovered in PROGRAMS.md (free future blocks)

- `XYCConcentrate` — Uniswap v3-style concentrated liquidity (price range)
- `PeggedSwap` — Curve-style stable-pair curve
- `Decay` — Mooniswap-style virtual-balance decay (MEV resistance)
- `Extruction` — external branch selector (multi-strategy best-route)
