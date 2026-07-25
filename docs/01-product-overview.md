# QilinSwap — Product Overview

> One-liner: **compose your own market-making strategy from visual blocks, ship it
> from your wallet, and watch it live — no code, no deployed contracts.**

**What actually shipped** (cut plan in docs/08): Canvas, Dashboard (test swap,
dock, manual rebalance), the Indexed-by-The-Graph panel and the Copilot; the
strategy detail/public pages and auto-rebalance described below are the design
record.

## Problem

Providing liquidity with a custom strategy today means writing, auditing and
deploying a smart contract. That locks strategy design behind Solidity skills,
and locks capital inside pools. New programmable-liquidity primitives make
custom strategies possible *without* deploying contracts — but they are only
accessible to developers comfortable composing low-level instructions by hand.
There is no interface: no way to see what a strategy will do before shipping
it, and no way to see what it is doing after.

## Solution

QilinSwap is a visual workspace for liquidity strategies, in three acts:

1. **Compose** — build a strategy by chaining blocks (pricing, fees, time
   limits, auctions...) on a canvas. The app shows, live, the price curve the
   strategy produces and how it compares to the current market price.
2. **Ship** — one click allocates liquidity to the strategy directly from the
   user's wallet. Funds never leave the wallet until a trade actually executes.
3. **Observe & act** — a live dashboard shows every shipped strategy: volume,
   fills, inventory balance, earnings. When inventory drifts too far to one
   side, the user rebalances with one click (or lets the app do it
   automatically) at the best available market rate.

## Target users

| Persona | Need | What Studio gives them |
|---|---|---|
| **Advanced DeFi user / "pro-sumer" LP** | wants custom exposure, can't write Solidity | full strategy design power, zero code |
| **Quant / power trader** | iterates on strategies fast | compose → simulate → ship in minutes, not days |
| **Protocol / DAO treasury operator** | deploys treasury liquidity with rules & limits | explicit, inspectable strategies with deadlines and caps |

## Value proposition

- **Self-custody first**: capital stays in the user's wallet; the same capital
  can back multiple strategies at once.
- **See before you ship**: every strategy is simulated and plotted against the
  live market price before any on-chain action.
- **See after you ship**: real-time visibility on fills, volume and inventory —
  data updates the moment a trade happens, not minutes later.
- **Close the loop**: the product does not stop at observing — it lets the user
  correct course (rebalance inventory) without leaving the app.

## What this is NOT (scope guards)

- Not an aggregator or a swap UI for retail traders. The user is the *maker*.
- Not a vault: Studio never takes custody, never pools user funds.
- Not a backtesting suite. Simulation is instantaneous shape-preview, not
  historical replay (possible future work).

## Demo storyline (3 minutes)

1. Open canvas, drag: constant-product pricing → progressive fee → deadline.
   Curve renders; market price line overlays it. Tweak fee, curve moves.
2. Click **Ship**. Wallet signs. Strategy appears on the dashboard as live.
3. Execute a taker swap against it (built-in "simulate taker" button). The
   dashboard bubble pulses in real time; fill and volume counters move.
4. Inventory gauge shows drift. Click **Rebalance** — a corrective market swap
   executes at the best route; gauge returns to green.
5. Share the strategy's public page link.
