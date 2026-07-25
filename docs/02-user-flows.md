# QilinSwap — Core User Flows

Functional description of what the user does and sees. No implementation detail.

**What actually shipped** (cut plan in docs/08): Flows 1, 2 and 6 in full, the
dashboard and indexed views of Flow 3, manual rebalance from Flow 4, and dock
from the Dashboard rather than a detail page; strategy detail/public pages and
auto-rebalance are the design record.

## Flow 1 — Compose a strategy

**Actor:** maker (LP). **Goal:** design a strategy and understand its behavior
before committing anything.

1. User lands on the **Canvas**. It opens with an empty graph and a row of
   **templates** — an empty canvas is a bad first experience, and the templates
   double as the strategies worth showing.
2. A **block palette** lists the building blocks, grouped by the zone they
   belong to:
   - *Pricing* (required, exactly one per path): constant-product curve
   - *Modifiers*: inventory skew (tilt toward a target split), price range
     (concentrate liquidity into a band), flow decay (repeat trades pay worse,
     the penalty heals over time)
   - *Fees*: flat fee
   - *Guards*: deadline, holder gate
   - *Branches*: on trade direction, or on how much of the pair is held
3. User wires blocks into a **graph**, not a list. A strategy is a program with
   branches, because that is what the VM executes: a branch has two outputs,
   `then` and `else`, and both legs may rejoin the same downstream block.
   Order is meaningful and enforced — modifiers and fees must precede pricing,
   and a branch that reads inventory must precede anything that shifts it.
4. Each block carries its parameters inline. Validation is immediate and
   attached to the offending block, never a global toast; the ship button
   disables while anything is invalid.
5. The **preview panel** (always visible, right side) updates on every change:
   - a direction switch — *they sell you WETH* / *they buy WETH from you* —
     because a graph can quote each side differently
   - **live path highlighting**: the blocks that would actually run for the
     previewed direction and current inventory, resolved the same way the VM
     resolves them
   - price curve for that path: execution price vs trade size
   - live **market reference line** for the same pair, so the user sees where
     their quote sits ("you are quoting 1.8% below market — arbitrageurs will
     drain this")
   - a plain-language summary of the live path, and the compiled bytecode size
     (expandable to the bytes themselves)

**Edge cases**
- No pricing block on some path → ship disabled, the error names the path.
- A cycle → rejected: the VM has no arithmetic, so a loop could never compute
  an exit condition.
- Dangerous but legal compositions (e.g. no deadline) → non-blocking warning.

## Flow 2 — Ship a strategy

**Actor:** maker. **Goal:** make the strategy live using own wallet funds.

1. From the canvas, user clicks **Ship**. What is committed is the compiled
   graph: the summary names the live path, the token amounts to allocate, and
   the fact that **funds stay in the wallet** (first-run explainer).
2. First time per token: an approval step, clearly labeled as one-time.
3. User confirms; wallet prompts; progress states: signing → pending → live.
4. On success the user lands on the **Dashboard**, the new strategy already
   showing as active with its allocated (virtual) balances.

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
   - the strategy's graph, rendered read-only
4. Every strategy has a **public shareable page** (read-only detail view).
5. An **indexed view** shows the same strategies as the subgraph sees them —
   including a head block, so it is visible that the data is indexed rather
   than read straight off the node.

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
