# Bacalhau — Core User Flows

Functional description of what the user does and sees. No implementation detail.

## Flow 1 — Compose a strategy

**Actor:** maker (LP). **Goal:** design a strategy and understand its behavior
before committing anything.

1. User lands on the **Canvas** with an empty strategy and a token-pair picker
   (e.g. WETH/USDC).
2. A **block palette** lists available building blocks, grouped:
   - *Pricing* (required, pick one): fixed rate, constant-product curve,
     oracle-pegged rate
   - *Price modifiers*: dutch auction (price improves over time),
     gas-responsive adjustment
   - *Fees*: flat fee, progressive fee (grows with trade size)
   - *Guards*: deadline, minimum rate, one-shot order, min taker balance
3. User drags blocks into a **pipeline** (ordered left→right). Order is
   meaningful and the UI says so: reordering changes behavior; incompatible
   orders are flagged inline with a plain-language explanation.
4. Each block has a small parameter form (fee %, deadline, amounts...).
   Validation is immediate; errors are attached to the block, not a global
   toast.
5. The **preview panel** (always visible, right side) updates on every change:
   - price curve: execution price vs trade size, both directions
   - live **market reference line** for the same pair, so the user sees at a
     glance where their quote sits relative to the market ("you are quoting
     1.8% below market — arbitrageurs will drain this")
   - a plain-language summary sentence: "Sells WETH from 2000 USDC/WETH,
     price improves 0.1%/min, 0.3% fee, expires in 24h."
6. Strategy can be **saved as draft** (named) at any time.

**Edge cases**
- No pricing block → ship button disabled, palette hints what is missing.
- Dangerous compositions (e.g. no deadline on an auction) → non-blocking
  warning badge with explanation.

## Flow 2 — Ship a strategy

**Actor:** maker. **Goal:** make the strategy live using own wallet funds.

1. From the canvas, user clicks **Ship**. A review sheet shows: pipeline
   summary, token amounts to allocate, the fact that **funds stay in the
   wallet** (first-run explainer), and network.
2. First time per token: an approval step, clearly labeled as one-time.
3. User confirms; wallet prompts; progress states: signing → pending → live.
4. On success the user is taken to the strategy's **detail page**, already
   showing it as active with its allocated (virtual) balances.

**Edge cases**
- Insufficient wallet balance → inline error before wallet prompt.
- User rejects signature → return to review sheet, nothing lost.

## Flow 3 — Observe (dashboard)

**Actor:** maker (own strategies) or visitor (public view).

1. The **Dashboard** lists the connected wallet's strategies: status
   (live/expired/docked), pair, virtual balances, 24h volume, fill count,
   inventory gauge.
2. A **live activity feed** streams swap events across the user's strategies
   the moment they land on-chain; the affected strategy row flashes.
3. Clicking a strategy opens the **detail page**:
   - full fill history (time, direction, size, realized price)
   - realized price plotted against market price at fill time ("edge captured")
   - inventory over time chart
   - the strategy's pipeline, rendered read-only
4. Every strategy has a **public shareable page** (read-only detail view).

## Flow 4 — Rebalance inventory

**Actor:** maker. **Goal:** correct one-sided inventory without leaving the app.

1. The inventory gauge on a strategy (or wallet-level, aggregated) shows drift,
   e.g. "78% USDC / 22% WETH — target 50/50".
2. User clicks **Rebalance**. The app proposes a corrective swap: amount, the
   best obtainable market rate, expected post-trade inventory. User can adjust
   the target split.
3. Confirm → wallet signs → swap executes at market → gauge updates.
4. Optional **auto-rebalance**: user sets a drift threshold (e.g. ±20%); the
   app monitors and proposes (or executes, if pre-authorized) corrective swaps.

**Edge cases**
- Quoted rate moves beyond tolerance before confirmation → re-quote, ask again.
- Rebalance would exceed wallet balance → cap and explain.

## Flow 5 — Retire (dock) a strategy

1. From detail page: **Dock strategy**. Review sheet explains: strategy stops
   quoting, virtual balances return, tokens were never locked anyway.
2. Confirm → wallet signs → strategy marked docked, kept in history.
3. Docked strategies can be **re-shipped** with edited parameters in two
   clicks (prefilled canvas).

## Flow 6 — Taker simulation (demo/testing aid)

For demos and strategy testing: on a strategy detail page, an **"Execute test
swap"** panel lets the user act as the taker against their own strategy:
pick direction and size, see the exact amounts the strategy would give, and
execute it for real. The dashboard must visibly react in real time — this is
the money shot of the demo.
