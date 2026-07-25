# Bacalhau

Compose your own market-making strategy from visual blocks, ship it from your
wallet, and watch it live — no code, no deployed contracts.

Built at ETHGlobal Lisbon 2026.

## Run it

One command brings up the whole demo — a Base fork, the deployed contracts with
a seeded strategy, and the app:

```bash
nix run .#dev
```

Then open <http://localhost:5173>. `q` (or Ctrl-C) stops everything; processes
shut down in reverse dependency order, so nothing is left listening.

It runs three processes, wired by readiness so the app never starts before the
deployment exists:

| Process  | What it does                                                        |
| -------- | ------------------------------------------------------------------- |
| `anvil`  | Forks Base, so real WETH/USDC and Uniswap pools are available        |
| `deploy` | Deploys Aqua + BacalhauRouter, ships the seed strategy, writes addresses |
| `app`    | Vite dev server                                                     |

Fork a different upstream with `BASE_RPC_URL=… nix run .#dev`. To drive the
pieces separately — say to restart the frontend without redeploying — use
`nix develop`, then `./scripts/demo-env.sh` and `cd app && pnpm dev`.

## Specs

- [01 — Product overview](docs/01-product-overview.md)
- [02 — User flows](docs/02-user-flows.md)
- [03 — Screens](docs/03-screens.md)
- [04 — Hackathon constraints & sponsor mapping](docs/04-hackathon-constraints.md)
- [05 — Block catalog](docs/05-block-catalog.md)
- [06 — Data model & metrics](docs/06-data-and-metrics.md)
- [07 — Demo script](docs/07-demo-script.md)
- [08 — Assumptions, risks & cut plan](docs/08-assumptions-risks.md)
- [09 — Architecture](docs/09-architecture.md)
- [Backlog (deferred ideas)](docs/backlog.md)
