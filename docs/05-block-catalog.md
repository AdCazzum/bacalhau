# QilinSwap — Block Catalog

The blocks users can compose on the canvas. Each block maps 1:1 to one
strategy instruction; this file defines the *user-facing* contract: name,
purpose, parameters, ordering rules, and plain-language copy. Implementation
mapping lives outside the specs.

Priority tiers: **[D1]** must exist for the demo · **[D2]** if time allows ·
**[S]** stretch.

**What actually shipped** (the palette in `app/src/ui/nodeKinds.ts`): Constant-
Product, Price Range, Inventory Skew ★, Flow Decay, Flat Fee, Deadline, Holder
Gate, If Direction, If Inventory Above ★. ★ = our own SwapVM instruction.

Blocks below without a shipped counterpart — Fixed Rate, Dutch Auction, Min
Rate, One-Shot, Progressive Fee, Oracle-Pegged — are **not** in the product.
They belong to SwapVM's *limit-order* opcode table, which needs
signature-based balances and a different router; our strategies are Aqua-backed
(`useAquaInsteadOfSignature`), so those instructions are unreachable from this
app. The tier markers on them record the original plan, not reality; they are
kept because the catalog is also the design record.

## Rules of composition (enforced by the compiler, surfaced by the canvas)

A strategy is a graph, so the rules are about **every path through it**, not
about one ordered list. `app/src/compiler/graph.ts` is the authority; the canvas
only renders what it reports.

1. Every path prices **exactly once**. Zero pricing blocks on a path is an
   error, and so are two.
2. Everything that touches balances or fees — Inventory Skew, Price Range, Flow
   Decay, Flat Fee — must come **before** the pricing block on its path. This is
   the audited order the official builders use, and the reason `xycConcentrate`
   reverts if amounts are already computed.
3. A branch that reads inventory (`If Inventory Above`) must come **before**
   anything that shifts the balances it tests, or it would read a tilted book.
4. **No cycles.** The Aqua opcode table has no arithmetic or register
   comparison, so a back edge could never compute an exit condition; it would
   just burn gas. (Backward jumps do appear in the emitted bytecode where two
   legs rejoin a shared block — a join, not a loop.)
5. Single entry, everything reachable from it.

```
                   ┌─ then ─▶ [ Modifiers* ] → [ Fees* ] ─┐
[ Guards* ] → [ Branch ]                                  ├─▶ [ Pricing ]
                   └─ else ─▶ [ Modifiers* ] → [ Fees* ] ─┘
                                                     * = zero or more
```

## Pricing (pick one, required)

### Fixed Rate [D1]
Sell one token for another at a rate you set. One direction.
- Params: sell token, buy token, rate, total amount offered
- Copy: "Sell {amount} {A} at {rate} {B} per {A}."
- Notes: the "limit order" primitive. Supports partial fills by default;
  see One-Shot guard to force all-or-nothing.

### Constant-Product Curve [D1]
Quote both directions along an x·y=k curve backed by your allocated balances.
- Params: token pair, allocation per token
- Copy: "Passive market making on {A}/{B}: price moves with your inventory."
- Notes: the "passive AMM" primitive. Bidirectional; inventory gauge and
  rebalance flows apply mainly to this block.

### Oracle-Pegged Rate [D2]
Quote at the live external market price, plus an offset you choose.
- Params: token pair, oracle feed, offset (bps), allocation
- Copy: "Always quote market price {±offset}."
- Warning if offset ≤ 0: "You are quoting at or below market with no spread —
  you will be arbitraged."

## Modifiers (optional, stack in order)

### Dutch Auction [D1]
Price improves for takers over time until someone fills.
- Params: start rate, end rate, duration
- Copy: "Starts at {start}, improves to {end} over {duration}."
- Requires: a Deadline guard (auto-suggested; advisory if missing).
- Incompatible with: Constant-Product Curve.

### Gas-Responsive Pricing [S]
Quote adjusts with network congestion so fills stay profitable when gas spikes.
- Params: sensitivity
- Copy: "Charge more when the network is busy."

### Inventory Skew [D1] ★ custom block
Automatically tilts your quote to favor trades that rebalance your inventory:
the further your holdings drift from target, the better the price offered to
takers who push you back toward it (and the worse for those who worsen it).
- Params: target split (default 50/50), max skew (bps)
- Copy: "Self-balancing: discounts trades that restore your target inventory."
- Requires: Constant-Product Curve.
- **This is the flagship custom instruction** — it does not exist in the stock
  instruction set. Product story: the strategy *resists* drift on its own;
  the Rebalance flow handles what skew alone cannot. Demo beat: show skew
  reducing drift, then rebalance closing the gap.

## Fees (optional, stack in order)

### Flat Fee [D1]
A fixed percentage on every trade, kept by you.
- Params: fee (bps), charged on input or output
- Copy: "Earn {fee}% on every trade."

### Progressive Fee [D2]
Fee grows with trade size — small trades cheap, large trades pay for impact.
- Params: base fee (bps), slope
- Copy: "Bigger trades pay a bigger fee."

## Guards (optional, run before pricing)

### Deadline [D1]
Strategy stops quoting at a set time.
- Params: expiry (datetime or duration)
- Copy: "Expires {when}." Advisory when absent on any path: "No expiry —
  this strategy quotes until you dock it."

### One-Shot [D1]
Order fills exactly once, entirely or not at all.
- Params: none
- Copy: "All-or-nothing, single fill."
- Requires: Fixed Rate. Incompatible with: partial-fill dependent modifiers.

### Minimum Rate [D2]
Refuse any fill below a floor price, no matter what modifiers computed.
- Params: floor rate
- Copy: "Never sell below {rate}."

### Taker Balance Gate [S]
Only takers holding at least X of a given token can fill (allowlist-by-stake).
- Params: token, minimum balance
- Copy: "Only takers holding ≥ {amount} {token}."

## Templates (one click, from the canvas)

Shipped in `app/src/lib/templates.ts`, built as a function of the live
allocation so the numbers always match what is about to be shipped. ✦ marks the
ones whose behaviour changes with direction or inventory instead of being one
static curve — expressible in a v4 hook too, but there as a deployed contract.

| Template | Graph | What it is |
|---|---|---|
| Passive AMM | Flat Fee → Constant-Product | a Uniswap-style LP position without the pool |
| Self-balancing MM ✦ | Deadline → Inventory Skew → Flat Fee → Constant-Product | quotes tilt to defend the current mix |
| Accumulate ETH ✦ | Inventory Skew (70%) → Flat Fee → Constant-Product | pay up to buy ETH, charge up to sell it |
| Concentrated desk | Price Range (±8%) → Flat Fee → Constant-Product | all liquidity in a band, far deeper quotes |
| Two-sided desk ✦ | If Direction → {0.05% \| 0.5%} → Constant-Product | cheap on the side you want, expensive on the other |
| Adaptive desk ✦ | If Inventory Above 70% → {distribute \| accumulate} → Constant-Product | a state machine over inventory |

The demo uses **Two-sided desk** to show that a strategy is a graph, then
**Adaptive desk** as the centrepiece: it exercises both custom opcodes, and the
branch flip is observable on-chain by quoting before and after a large swap.

## Scope change: branching is in

Conditional jumps were listed out of scope here. They are now the centre of the
product: SwapVM lets any instruction rewrite the program counter, so a strategy
is a control-flow graph, and the strategies worth showing — asymmetric two-sided
quoting, an accumulate/distribute state machine — cannot be expressed without a
fork. The canvas is a node graph (`app/src/ui/Canvas.tsx`), the compiler is a
two-pass assembler (`app/src/compiler/graph.ts`), and branching uses
`_jumpIfTokenIn` (0x0b) plus our second custom opcode
`_jumpIfInventoryAboveXD` (0x23).

## Still out of scope

TWAP execution, multi-strategy nesting, oracle-triggered invalidation, and
**loops**: the Aqua opcode table has no arithmetic or register comparison, so a
back edge cannot have a computed exit condition and would only burn gas. The
validator rejects cycles for that reason. (Backward jumps do appear in emitted
bytecode where two legs rejoin a shared node — that is a join, not a loop, and
the graph stays acyclic.)
