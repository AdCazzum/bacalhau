# QilinSwap — Hackathon Constraints & Sponsor Mapping

The product is defined functionally in 01–03. This file pins the *non-negotiable*
external constraints: which sponsor track each feature serves and what the
judges must be able to verify. Feature decisions in 01–03 must not regress
these.

## Sponsor mapping

| Product capability | Powered by | Track |
|---|---|---|
| Strategy graph, custom opcodes, ship/dock, self-custody model | 1inch Aqua + SwapVM (official contracts) | 1inch — Build an Aqua App ($5k) |
| Copilot: ask about live strategies, get a compiled strategy back | The Graph as the agent's data source (subgraph + Subgraph MCP) | The Graph — **Best AI Use Case** ($3k, primary claim) |
| Live dashboard, activity feed, fill history, public pages | The Graph: reusable Substreams module + subgraph over the same Aqua events | The Graph — Composable/Standardized ($3k, secondary) |
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

### The Graph — Best AI Use Case (primary claim)
- [x] AI component that reasons over the data rather than printing a query:
      the copilot (`app/src/ui/Copilot.tsx`, `app/public/_worker.js/agent.js`)
      answers questions about live strategies and emits SwapVM strategy graphs
- [x] The Graph is load-bearing, not decorative: `query_strategies` runs
      GraphQL against our deployed subgraph, and the reply names every tool it
      used, so a judge can see which source answered
- [x] The model never signs: its proposal is validated by the same `compile`/
      `validate` the canvas uses, and a rejected graph is sent back once with
      the compiler's own errors
- [ ] Bonus (reusable SKILL or MCP server) — not attempted

### The Graph — Composable/Standardized (secondary claim)
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
- [x] Make the composability leverage clear — the track asks to "show what
      became easier": README "The Graph" section explains that both products
      share one decode of Aqua's events, so a new sink points at the existing
      `.spkg` instead of re-deriving the event layout
- [~] Schema follows the standardized DEX-AMM shape where applicable:
      `Protocol` / `Strategy` (≈Pool) / `Fill` (≈Swap). No `Position` entity —
      Aqua strategies are not LP positions
- [ ] Public repo + 2–4 min demo video (video pending; script in `07`)

### Uniswap
- [x] Valid API key from Uniswap Developer Platform; API used for **core**
      functionality: market reference quotes (`app/src/lib/uniswap.ts`) and
      rebalance routing + execution (`app/src/lib/rebalance.ts`)
- [x] `FEEDBACK.md` in repo — real integration notes, including the disclosure
      that execution bypasses the API's Permit2 calldata
- [ ] Developer Feedback Form submitted with the FEEDBACK.md link (needs the
      public repo URL, so after the push)
- [x] README points to the exact files of the integration ("Where the
      integrations live")

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
