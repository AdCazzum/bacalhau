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

## Deploy the demo

The public build is a Nix derivation, so the artifact is identical locally and
in CI:

```bash
nix build .#site     # -> ./result, a self-contained Cloudflare Pages root
nix run  .#deploy    # builds the above, then uploads it with wrangler
```

`nix run .#deploy` is the entire deploy — GitHub Actions runs the same command
and only adds credentials (`.github/workflows/deploy.yml`). It reads:

| Variable                | Purpose                                          |
| ----------------------- | ------------------------------------------------ |
| `CLOUDFLARE_API_TOKEN`  | wrangler auth (or run `wrangler login` once)      |
| `CLOUDFLARE_ACCOUNT_ID` | wrangler auth                                     |
| `UNISWAP_API_KEY`       | pushed as a Pages secret when set; optional       |
| `CF_PAGES_PROJECT`      | Pages project name, defaults to `bacalhau`        |

The Uniswap Trading API sends no CORS headers and its key must not reach the
browser, so every `/uniswap/*` call goes through a same-origin proxy that
attaches the key server-side: the Vite dev server locally, `app/public/_worker.js`
on Cloudflare. Nothing secret is passed into the build — with no key configured
the proxy answers 503 and the app simply hides the live market overlay.

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
