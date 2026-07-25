# QilinSwap — Build Status

Anchor for resuming work. Code + commits on disk are the source of truth;
this summarizes where we are.

Product name = "QilinSwap" (user-facing: app, README, docs, pitch).
"Bacalhau" survives as the codename in identifiers we do not want to churn:
repo, package/flake names, `BacalhauRouter.sol` (already deployed on Base
Sepolia), and the golden-vector salt. Repo remote:
git@github.com:AdCazzum/bacalhau.git (commits are NOT pushed by the agent —
the user pushes manually).

## One-liner

Visual builder for 1inch Aqua/SwapVM market-making strategies: compose blocks
→ compile to SwapVM bytecode → ship on Aqua → watch live → rebalance via
Uniswap. Three sponsors: 1inch (core), The Graph (observability), Uniswap
(market price + rebalance execution).

## Done ✅ (committed)

- **Specs** docs/01-09 + backlog (functional, screens, block catalog, data,
  demo script, risks, architecture).
- **Contracts** (`contracts/`, Foundry, deps = 1inch swap-vm/aqua submodules):
  - `InventorySkew.sol` — custom SwapVM opcode 0x22 (self-balancing price
    tilt). `BacalhauRouter.sol` — modified-SwapVM redeploy with skew appended.
  - Golden tests (template→bytecode parity), 5 skew tests, 11 inventory-branch
    tests. **forge 19/19.**
  - `app/src/compiler/graph.test.ts` — 89 tests: golden-vector parity, a
    test-local VM interpreter proving the emitted program runs exactly the nodes
    the graph model says, a property test over 200 random branchy graphs, and 19
    rejected unsafe shapes. **vitest 93/93.**
- **Strategy graph** — SwapVM is a machine whose instructions rewrite the PC, so
  a strategy is a control-flow graph, not a pipeline:
  - `app/src/compiler/graph.ts` — two-pass assembler. Emits labels only at
    instruction boundaries (a target inside an args blob would make the VM run
    argument bytes as opcodes), enforces the audited order (modifiers/fees
    before the swap, exactly one pricing node per path, inventory branches
    before anything that shifts balances) and rejects cycles.
  - `contracts/src/InventoryBranch.sol` — second custom opcode 0x23,
    `_jumpIfInventoryAboveXD`: direction-independent state predicate.
  - Nine blocks incl. Price Range (xycConcentrate), Flow Decay (decay),
    Holder Gate; two branch kinds (direction, inventory).
  - Six one-click templates (`app/src/lib/templates.ts`), four of them not
    expressible in a constant-product pool.
- **Frontend** (`app/`, Vite+React+viem): Canvas is a React Flow node editor
  with typed then/else ports, live validation badges, live-path highlighting
  (it resolves which leg the VM would take for the previewed direction) and a
  bytecode panel; Dashboard (strategies from Aqua events, live feed, test-swap,
  dock, wallet-inventory gauge, indexed-by-The-Graph panel); demo wallet
  (anvil acct #0, PoC — no wallet extension).
- **Uniswap** ✅ CORE: market reference price (canvas overlay + value gauge)
  AND rebalance execution — quote via Trading API, execute real swap via
  SwapRouter02 against a Base fork. Verified in-browser.
- **The Graph** ✅ two products over the same Aqua events:
  - `substreams/` — Rust/wasm module decoding Shipped/Docked/Pulled/Pushed
    into protobuf, plus a `graph_out` emitting EntityChanges. Packs to a valid
    `.spkg`. Endpoint for Base Sepolia is
    `basesepolia.substreams.pinax.network:443` (absent from the docs, found in
    the networks registry); running it needs a provider token we don't have.
  - `subgraph/` — deployed and indexing, `hasIndexingErrors: false`:
    https://api.studio.thegraph.com/query/1756929/bacalhau-aqua/v0.0.2
  - Dashboard panel "Indexed by The Graph" shows indexer head block, strategy
    status and recent movements.
- **Base Sepolia** (chain 84532, deploy block 44584712) — real public
  deployment, addresses in `contracts/deployments/sepolia.json`:
  Aqua `0xE5Cf2ec690BeE8b59cB8340f469ecfB2f0De98bD`,
  router `0xF9b0AfdDad9D249Eb22e69b15df2a4E8C1e99ABC`.
  1 Shipped + 3 Pulled + 5 Pushed on chain, total cost ~0.00006 ETH.
- **Demo env**: `nix run .#dev` (process-compose: anvil Base fork → deploy +
  seed → vite) is the single entry point; `scripts/demo-env.sh` and
  `scripts/deal.sh` remain for piecemeal use. `local.json` is per-run and
  gitignored.

## Remaining ❌

1. **`FEEDBACK.md`** (Uniswap qualification) + submit the Developer Feedback
   Form with its link. Material from the real integration: Permit2's EIP-712
   path reverting against a pinned fork block, `slippageTolerance` needing a
   number (a string returns an undiagnostic HTTP 400), no CORS headers so the
   browser needs a dev proxy, quote working while execute needed a direct
   router.
2. **README architecture section** — satisfies two requirements at once:
   Uniswap wants pointers to the exact integration files, The Graph wants the
   composability leverage made explicit ("what became easier").
3. **Demo video** ≤3:50 + rehearsal. `docs/07-demo-script.md` is stale: written
   before the Graph pillar, Base Sepolia and `nix run .#dev` existed.

## Keys / secrets (all gitignored)

`app/.env.local`:
- `UNISWAP_API_KEY` — Uniswap Developer Platform, working. Read by the
  `/uniswap` proxy, not by the bundle; mirrored as a Cloudflare Pages secret
  for the public deploy.
- `VITE_GRAPH_SUBGRAPH_URL` — Studio query endpoint the dashboard polls.
- `VITE_GRAPH_API_KEY` — gateway key, for a published subgraph (unused while
  we query Studio directly).

`contracts/.env.sepolia`:
- `SEPOLIA_DEPLOYER_PK` — throwaway testnet wallet
  `0x4fB5C90d3A828067aE07e134eA82ad14DAD50d58`, funded with 0.1 ETH, ~0.0999
  left. NEVER fund with real ETH.
- `GRAPH_DEPLOY_KEY` — Subgraph Studio deploy key (distinct from the query
  key above).

Still missing: a Substreams provider token (Pinax or thegraph.market JWT) to
*run* the module against live data. Not required by any track.

## Key technical decisions / gotchas

- Aqua-backed SwapVM: `useAquaInsteadOfSignature=true`, no balance
  instruction; ship() sets reserves. `BPS = 1e9`. USDC on Base = 6 decimals.
- Rebalance executes via SwapRouter02 directly (not Universal Router) because
  Permit2 EIP-712 reverts against a pinned fork block; size capped to
  one-pool depth. Uniswap API still drives price/route/fee-tier.
- Fork RPC caps eth_getLogs at 10k blocks → scan from `deployBlock`.
- forge broadcast collector chokes on BacalhauRouter's inherited constructor
  → deploy via a self-contained DemoDeployer factory (empty-args creation).
- chain.ts pins chainId 8453 for correct EIP-712 on the fork.
- Subgraph Studio rejects substreams-powered subgraphs outright; the subgraph
  is a classic EVM datasource and the Substreams module stands alone.
- `substreams pack` resolves manifest imports over the network, so the
  entity-change sink proto is vendored under
  `substreams/proto/sf/substreams/sink/entity/v1` (field numbers mirror the
  crate, so the wire format is unchanged).
- AssemblyScript mappings trap when reading an unset enum on a fresh entity —
  capture prior state before writing (bit us on `Strategy.status`).
- Aqua's events are all non-indexed, so a subgraph must match on signature,
  not topics.
- The dev server serves index.html for unknown paths, so a missing
  `local.json` arrives as 200 + HTML: parse defensively.

## Run it

```
nix run .#dev        # anvil Base fork -> deploy + seed -> vite (localhost:5173)
```

process-compose (flake input `process-compose-flake`) wires the three
processes by readiness, so the app never boots before app/public/local.json
exists, and `ordered_shutdown` stops vite before the chain. Piecemeal:
`nix develop`, then `./scripts/demo-env.sh` + `cd app && pnpm dev`.

## Commits (progressive history for 1inch)

specs+flake → contracts scaffold → InventorySkew opcode → TS compiler →
demo env → frontend → Uniswap market reference → Base fork → Uniswap
rebalance → Substreams toolchain → Substreams module + Sepolia deploy →
subgraph live → single entry point.
