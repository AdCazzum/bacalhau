# QilinSwap — Architecture Spec

Technical companion to specs 01–08. Sources of truth: `swap-vm/docs/PROGRAMS.md`
and the SwapVM/Aqua repos (verified 2026-07-24).

## Repo layout (monorepo)

```
bacalhau/
├── flake.nix            # dev environment (foundry, node, rust, protobuf)
├── contracts/           # Foundry: custom instruction + fork tests + demo scripts
├── app/                 # frontend (canvas, dashboard, compiler)
├── indexer/
│   ├── substreams/      # Rust module: Aqua events -> entity changes
│   └── subgraph/        # substreams-powered subgraph manifest + schema
└── docs/                # these specs
```

Workstreams are parallel after this file is agreed: contracts, indexer and app
only meet at two interfaces — the **bytecode ABI** (block map below) and the
**GraphQL schema** (06 entities).

## Block → instruction map (verified against PROGRAMS.md)

| Block (05) | SwapVM opcode(s) | Notes |
|---|---|---|
| Fixed Rate | `StaticBalances` + `LimitSwap` | balances arg = [amountIn, amountOut] fixes the rate; partial fills need `InvalidateTokenOut` appended |
| Fixed Rate + One-Shot | `InvalidateBit` + `StaticBalances` + `LimitSwapOnlyFull` | ⚠️ invalidator goes FIRST in canonical order (PROGRAMS.md ex. A) |
| Constant-Product | `XYCSwap` (Aqua-backed: **no balance instruction** — Aqua supplies balances, `useAquaInsteadOfSignature = true`; ship() sets the reserves) | non-Aqua mode would use `DynamicBalances`; we always run Aqua-backed |
| Oracle-Pegged | `OraclePriceAdjuster` (1D) | D2; feed address + offset args |
| Dutch Auction | `DutchAuctionBalanceIn1D` / `...Out1D` | 1D only — confirms incompatibility with Constant-Product in 05 |
| Gas-Responsive | `BaseFeeAdjuster1D` | stretch |
| Flat Fee | `FlatFeeAmountInXD` / `FlatFeeAmountOutXD` | placement is economic-critical: compiler emits fees in fixed canonical slot |
| Progressive Fee | `ProgressiveFeeInXD` / `ProgressiveFeeOutXD` | D2 |
| Deadline | `Deadline` (control) | |
| Min Rate | `RequireMinRate1D` (block) / `AdjustMinRate1D` (variant) | D2 |
| Taker Balance Gate | `OnlyTakerTokenBalanceNonZero` / `...Gte` | exists stock — cheaper than we assumed; emitted FIRST (gate pattern, PROGRAMS.md ex. 4A) |
| **Inventory Skew** ★ | **custom instruction** (new opcode, modified SwapVM redeploy) | see below |

**Ordering discovery (impacts 05 silently, not visibly):** canonical programs
are not strictly "guards last" — invalidators and gates lead the program,
invalidation-tracking trails it. The UI zone model in 05 stays as designed
(it's a UX grouping); the **compiler owns canonical ordering** and emits
instructions in the audited sequence regardless of visual arrangement. The
"order matters within a zone" rule in 05 applies only where PROGRAMS.md allows
variation (fee stacking); everything else is compiler-fixed. 05 does not need
edits — but the compiler spec below is the authority.

## Compiler (app-side)

`app/src/compiler/graph.ts`: **strategy graph → bytecode**, a two-pass
assembler rather than a concatenation, because a strategy is a control-flow
graph (SwapVM's run loop re-reads the program counter after every instruction).

- **Pass 1** lays nodes out — else legs fall through, so a conditional only
  encodes its `then` target — and sizes them. Every instruction is fixed-width,
  so the offsets computed here stay valid once real bytes are emitted.
- **Pass 2** emits with labels resolved. Labels resolve **only** to emission-unit
  boundaries: a target inside an instruction's arguments would make the VM
  execute argument bytes as opcodes. A node reached from two legs is emitted
  once and jumped to, never duplicated.
- **Validation is path-sensitive**, tracked as min/max counts over a topological
  order rather than by enumerating paths (exponential in a DAG): exactly one
  pricing node per path, nothing fee- or balance-related after it, inventory
  branches before anything that shifts the balances they read, no cycles, single
  entry, everything reachable. The same errors drive the UI badges — one source
  of truth.
- **Golden test**: the linear `flatFee → constantProduct` case is pinned
  byte-identically in Solidity (`contracts/test/GoldenPrograms.t.sol`) and
  TypeScript (`app/src/compiler/graph.test.ts`), which also proves the graph
  compiler did not drift from the audited emission. Alongside it: a decoder that
  walks the program as the VM does and asserts every jump target is an
  instruction boundary, and a property test over 200 random branchy graphs.

## Custom instruction: InventorySkew

- Placement: price-modifier slot, immediately before `XYCSwap`.
- Args: `targetSplitBps (uint16)`, `maxSkewBps (uint16)`.
- Semantics: read current strategy balances (registers `balanceIn/balanceOut`),
  compute drift vs target valued at the *strategy's own* current ratio (no
  oracle dependency — deliberate, keeps it pure); scale `amountOut` up to
  ±maxSkew for drift-reducing/-increasing trades.
- Tests: extend the 2D invariant suite
  (`ConcentrateXYCInvariants.t.sol` as reference): symmetry, monotonicity,
  no-free-lunch (skew must never make round-trip profitable), depletion
  liveness.
- Fallback (08/R1): asymmetric per-direction flat fees composed with
  `JumpIfTokenIn` — same visible behavior class, stock instructions only.

## Indexer

- Substreams module (Rust): decode Aqua `ship/dock/pull/push` events →
  entity changes; feeds the subgraph (substreams-powered subgraph — the Graph
  track's qualifying composition).
- Schema: entities from 06 (Strategy, Fill) shaped on the standardized
  DEX-AMM convention (Protocol/Pool≈Strategy/Swap≈Fill).
- Deployed to Subgraph Studio indexing Base (real network); the app reads the
  fork for actions and Studio for the live dashboard (08 dual-environment).
- `substreams` CLI: not in nixpkgs — add fetchurl derivation to the flake when
  this workstream starts (TODO noted in flake.nix).

## Frontend stack (decided)

- Vite + React + TypeScript
- React Flow for the canvas (free node graph; the R4 "linear chain" guard was
  lifted deliberately — branching is what the strategies need)
- wagmi + viem (wallet, fork chain config), TanStack Query
- graphql-request for subgraph queries; polling for feed (websockets only if
  trivially available)
- Recharts (curve preview, charts); no design system — hand-rolled ocean theme
- Uniswap API reached through a same-origin `/uniswap` proxy that holds the
  key server-side (Vite dev server locally, Pages worker in production, 08)

## Chain targets

- Actions/demo: anvil fork of Base (SwapVM + Aqua deployed; redeploy modified
  SwapVM on the fork for InventorySkew).
- Indexer: Base mainnet, real transactions we generate (08/R3).

## Open items

- [ ] Exact `ArgsBuilder` encodings per instruction — read from
      `swap-vm/src/instructions/*` when compiler work starts (encoding detail,
      does not change this map)
- [ ] Verify Aqua+SwapVM deployment addresses on Base (`config/constants.json`
      in both repos)
- [ ] substreams CLI derivation for the flake
