# Bacalhau — Block Catalog

The blocks users can compose on the canvas. Each block maps 1:1 to one
strategy instruction; this file defines the *user-facing* contract: name,
purpose, parameters, ordering rules, and plain-language copy. Implementation
mapping lives outside the specs.

Priority tiers: **[D1]** must exist for the demo · **[D2]** if time allows ·
**[S]** stretch.

## Rules of composition (enforced by the canvas)

1. A pipeline has exactly **one Pricing block**, always first.
2. Modifiers and Fees go between Pricing and Guards; Guards close the pipeline.
   The canvas auto-slots blocks into the right zone; users reorder only
   *within* a zone (order still matters and is preserved).
3. Blocks that cannot coexist (marked below) dim each other in the palette.
4. Advisory warnings (non-blocking) for risky-but-legal compositions.

```
[ Pricing ] → [ Modifiers* ] → [ Fees* ] → [ Guards* ]     * = zero or more
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

## Guards (optional, close the pipeline)

### Deadline [D1]
Strategy stops quoting at a set time.
- Params: expiry (datetime or duration)
- Copy: "Expires {when}." Advisory when absent on any pipeline: "No expiry —
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

## Templates (empty-state shortcuts)

| Template | Pipeline |
|---|---|
| Limit order | Fixed Rate → One-Shot → Deadline |
| Passive AMM | Constant-Product → Flat Fee |
| Self-balancing MM | Constant-Product → Inventory Skew → Flat Fee → Deadline |
| Dutch auction | Fixed Rate → Dutch Auction → Deadline |

The demo uses **Self-balancing MM**: it exercises the custom block, the fee,
the live dashboard and the rebalance flow in one strategy.

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
