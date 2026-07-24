# Bacalhau — Build Status

Anchor for resuming work. Code + commits on disk are the source of truth;
this summarizes where we are.

Project = "Bacalhau" (codename). Product in specs is "Aqua Studio". Repo
remote: git@github.com:AdCazzum/bacalhau.git (commits are NOT pushed by the
agent — the user pushes manually).

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
  - Golden tests (template→bytecode parity) + 5 skew tests. **forge 8/8.**
- **TS compiler** (`app/src/compiler/`) — canvas blocks → SwapVM bytecode,
  byte-identical to Solidity golden vector. **vitest 11/11.**
- **Frontend** (`app/`, Vite+React+viem): Canvas (block palette, pipeline,
  live price curve + Uniswap market overlay), Dashboard (strategies from Aqua
  events, live feed, test-swap, dock, wallet-inventory gauge), demo wallet
  (anvil acct #0, PoC — no wallet extension).
- **Uniswap** ✅ CORE: market reference price (canvas overlay + value gauge)
  AND rebalance execution — quote via Trading API, execute real swap via
  SwapRouter02 against a Base fork. Verified in-browser.
- **Demo env**: `scripts/demo-env.sh` = anvil fork of Base + deploy + seed
  strategy; `scripts/deal.sh` = ERC20 balance cheat. `app/public/local.json`
  carries addresses (gitignored).

## Remaining ❌

1. **The Graph indexer** (the last sponsor pillar): Substreams module (Rust)
   decoding Aqua ship/dock/pull/push → substreams-powered subgraph → deploy to
   Subgraph Studio. Compose 2 Graph products = the qualifying requirement.
   - `substreams` CLI not in nixpkgs — needs a fetchurl derivation in flake.
   - Real Base transactions for live data (R3) — needs a funded Base wallet.
2. **FEEDBACK.md** (Uniswap qualification) + submit the Uniswap Developer
   Feedback Form with its link. Material: real integration notes incl. the
   Permit2-on-fork revert we worked around.
3. **README** with architecture + pointers to integration code (Uniswap
   requires this; also general submission hygiene).
4. **Demo video** ≤3:50 (docs/07 script) + final rehearsal.

## Keys (in app/.env.local, gitignored)

- `VITE_UNISWAP_API_KEY` — set, working.
- `VITE_GRAPH_API_KEY` — set (for subgraph queries; Studio deploy is separate).

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

## Run it

```
nix develop
./scripts/demo-env.sh        # anvil fork of Base + deploy + seed
cd app && pnpm install && pnpm dev   # http://localhost:5173
```

## Commits (progressive history for 1inch)

specs+flake → contracts scaffold → InventorySkew → compiler → demo env →
Uniswap market → Base fork → Uniswap rebalance.
