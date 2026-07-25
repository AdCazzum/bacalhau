# Bacalhau — Architecture Spec

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

- TS module: `pipeline JSON -> bytecode` mirroring the Solidity
  `Program.build(Opcode.X, ArgsBuilder...)` encoding.
- Canonical emission order:
  `gates -> invalidate-bit -> balances -> price modifiers -> core swap ->
   fees -> min-rate -> deadline -> trailing invalidators`.
- Validation errors (05) are computed from the same table — single source of
  truth for both UI hints and emission.
- **Golden tests**: for each template in 05, a Foundry script builds the same
  program in Solidity; CI asserts byte-equality with the TS output, then
  executes it on a fork (ship -> swap -> assert amounts). This is the highest
  ROI test in the project: it certifies UI-built strategies are real.

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
- React Flow for the canvas (linear chain with fixed zones — R4 guard)
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
