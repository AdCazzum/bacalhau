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
- [x] Official Aqua/SwapVM contracts used as submodules; `BacalhauRouter` is
      the allowed modified-SwapVM redeploy, adding the custom `InventorySkew`
      opcode `0x22` (`contracts/src/InventorySkew.sol`)
- [x] On-chain token transfers shown in final demo (local Base fork) —
      Flow 6 "Execute test swap"
- [x] Proper git commit history: progressive commits throughout, no
      single-commit dump

### The Graph
- [x] Compose ≥2 Graph products. **Planned as a substreams-powered subgraph;
      Studio has since dropped support** ("Substreams-powered Subgraphs,
      originally intended for non-EVM chains, are no longer supported"), so the
      shipped shape is a **reusable composable Substreams module**
      (`substreams/`, explicitly in scope per the track) **plus a subgraph**
      (`subgraph/`) over the same Aqua events. Weaker than one feeding the
      other: be upfront about it and cite the rejection.
- [x] Live data from a Graph provider (no mocks): subgraph deployed to Subgraph
      Studio, indexing Base Sepolia from block 44584712. Aqua has no organic
      testnet traffic, so we generated real transactions ourselves
      (`contracts/script/SepoliaSwaps.s.sol`)
- [ ] Make the composability leverage clear — the track asks to "show what
      became easier". README section pending
- [~] Schema follows the standardized DEX-AMM shape where applicable:
      `Protocol` / `Strategy` (≈Pool) / `Fill` (≈Swap). No `Position` entity —
      Aqua strategies are not LP positions
- [ ] Public repo + 2–4 min demo video (video pending)

### Uniswap
- [x] Valid API key from Uniswap Developer Platform; API used for **core**
      functionality: market reference quotes (`app/src/lib/uniswap.ts`) and
      rebalance routing + execution (`app/src/lib/rebalance.ts`)
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
- Live subgraph endpoint (Subgraph Studio). The Substreams module ships as
  source that packs reproducibly (`substreams pack`) — no track requires
  publishing it to the registry, which would need a provider token.
