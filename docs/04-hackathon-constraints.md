# Bacalhau — Hackathon Constraints & Sponsor Mapping

The product is defined functionally in 01–03. This file pins the *non-negotiable*
external constraints: which sponsor track each feature serves and what the
judges must be able to verify. Feature decisions in 01–03 must not regress
these.

## Sponsor mapping

| Product capability | Powered by | Track |
|---|---|---|
| Strategy blocks, pipeline, ship/dock, self-custody model | 1inch Aqua + SwapVM (official contracts) | 1inch — Build an Aqua App ($5k) |
| Live dashboard, activity feed, fill history, public pages | The Graph: Substreams module → substreams-powered subgraph | The Graph — Composable/Standardized ($3k) |
| Market reference line, rebalance quoting & execution | Uniswap API (Developer Platform key) | Uniswap — Best API Integration ($7k) |

## Qualification requirements checklist

### 1inch
- [ ] Official Aqua/SwapVM contracts used (modified SwapVM redeploy allowed —
      planned: at least one custom instruction/opcode, judges score SwapVM
      usage higher)
- [ ] On-chain token transfers shown in final demo (local fork OK) —
      covered by Flow 6 "Execute test swap"
- [ ] Proper git commit history: commit early, commit often, **no
      single-commit dump on final day**

### The Graph
- [ ] Compose ≥2 Graph products: Substreams module feeding a subgraph
      (substreams-powered subgraph) — this is the qualifying composition
- [ ] Live data from a Graph provider (no mocks): subgraph deployed to
      Subgraph Studio, indexing the real chain (mainnet or Base). If Aqua has
      no organic traffic yet, generate real transactions ourselves on Base
- [ ] Make the composition visible: README section "what became easier because
      the module is reusable / the subgraph is standardized"
- [ ] Schema follows the standardized DEX-AMM shape where applicable
      (Protocol / Pool / Swap / Position)
- [ ] Public repo + 2–4 min demo video

### Uniswap
- [ ] Valid API key from Uniswap Developer Platform; API used for **core**
      functionality: rebalance execution (trade routing + execution) and
      market reference quotes
- [ ] `FEEDBACK.md` in repo + Developer Feedback Form submitted with its link
- [ ] README points to the exact files/lines of the integration

## Verifiability rules (apply to everything)

- No hard-coded market data: every number on screen traces to chain or a live
  API.
- The demo path (compose → ship → taker swap → dashboard pulse → rebalance)
  must run end-to-end on a fresh checkout with documented setup.
- Anything not finished by demo time is cut from the UI, not stubbed: no dead
  buttons in the pitch build.

## Deliverables

- Public GitHub repo (this one), README with setup + architecture
- Demo video 2–4 min (Graph limit is the binding one)
- FEEDBACK.md (Uniswap) + feedback form submission
- Live subgraph endpoint (Subgraph Studio) + published Substreams package
