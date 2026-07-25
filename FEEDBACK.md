# Uniswap API — developer feedback

Written for the Uniswap Developer Feedback Form (ETHGlobal Lisbon 2026).

**What we built:** QilinSwap, a visual builder for 1inch Aqua/SwapVM
market-making strategies. The Uniswap Trading API is the market-truth layer: it
supplies the reference price the strategy is drawn against, and it quotes and
routes the corrective swap when a maker's inventory drifts.

**Where the integration lives:** [`app/src/lib/uniswap.ts`](app/src/lib/uniswap.ts)
(reference price), [`app/src/lib/rebalance.ts`](app/src/lib/rebalance.ts)
(quote → approve → execute), [`app/public/_worker.js`](app/public/_worker.js)
(same-origin proxy that attaches the key server-side). Time to a first working
quote: about 15 minutes. Time to a working *execution*: several hours, for the
reason in §1.

---

## 1. Permit2 execution fails against a pinned fork — the one that cost us a day

This is the feedback we'd most want read.

Local development against a mainnet fork (`anvil --fork-url`) is the standard
way to build anything that moves funds. We forked Base so the demo could swap
against real pool liquidity. Quoting worked immediately. Execution did not.

The API's swap path goes through the Universal Router with a Permit2
EIP-712 signature. Against the fork it reverted with
`ExecutionFailed(uint256 commandIndex, bytes message)` where `commandIndex = 0`
and `message` was **empty** — command 0 being `PERMIT2_PERMIT`. Empty revert
data on the permit command gave us nothing to work with, so we ruled things out
one at a time:

- Permit2 allowance present, and the ERC-20 approval to Permit2 mined first ✓
- Permit2 nonce correct (0 for a fresh maker; we read it back on-chain) ✓
- `permitData.domain.chainId` = 8453, matching the fork, and the right
  `verifyingContract` ✓
- `sigDeadline` ~1800s in the future, fork timestamp within 2s of wall clock ✓
- Slippage widened to 5% in case it was a `minAmountOut` failure ✓ (still failed)
- Signature 65 bytes, produced by `viem`'s `signTypedData` with the domain the
  API returned ✓

We eventually stopped and switched to calling **SwapRouter02
`exactInputSingle`** directly with a plain ERC-20 approval — no Permit2, no
signature — and it worked on the first attempt.

**Asks, in order of value to us:**

1. **Populate the revert reason on the permit command.** An empty `message` on
   `ExecutionFailed` is the single biggest time sink here. Even a static string
   would have collapsed hours into minutes.
2. **Document the fork story.** A short note in the docs — "the Permit2 path
   assumes X; against a pinned fork block, do Y" — would help every team that
   develops locally, which is most of them.
3. **Offer a `permit: false` (or `approvalType: erc20`) option on the swap
   endpoint.** We wanted the API's routing intelligence with a plain approval.
   Instead we had to leave the API's calldata behind and hand-roll the router
   call, which means we no longer benefit from multi-pool routes (see §4).

**Disclosure, so nobody has to find it in an audit:** because of the above, our
execution calls SwapRouter02 directly rather than submitting the API's
transaction. The API still drives pricing, routing and the fee-tier choice —
`feeTier` is read from the API's structured `route`, preferring the direct
pool that carries the largest share of the flow
([`rebalance.ts`](app/src/lib/rebalance.ts)) — but the final call is ours.

## 2. `slippageTolerance` must be a number, not a string

Sending `"5"` returns HTTP 400; sending `5` works. Roughly half an hour lost.
When we first hit this (early in the hackathon), the 400 read to us as a
generic malformed request; retesting as of 2026-07-25, the error does name the
field — `"slippageTolerance" must be a number` — so either the message
improved or we misread it under pressure. What remains is the type strictness
itself: coercing an obviously numeric string would remove the trap entirely.

## 3. No CORS headers, so every browser integration needs a proxy

Calling the API from a browser origin fails outright. Understandable — it keeps
keys off the client — but it isn't stated up front, and the failure surfaces as
a generic network error rather than something that points at CORS.

In practice it means a browser app can't integrate without server-side
infrastructure. We ended up with a Vite dev proxy for local work and a
Cloudflare Pages worker for the public deploy
([`app/public/_worker.js`](app/public/_worker.js)), purely to attach the key.
A one-paragraph "browser apps need a proxy; here's why and here's the shape of
it" in the quickstart would set expectations correctly.

## 4. Losing the API's calldata means losing multi-pool routing

A consequence worth naming: our first rebalance attempt sold a large amount and
reverted, because the API's route split it across three pools while our
`exactInputSingle` call hits exactly one. We now cap a single rebalance at
roughly one pool's depth (`MAX_USDC_PER_REBALANCE`,
[`app/src/ui/Dashboard.tsx`](app/src/ui/Dashboard.tsx)). A reasonable product
decision, but we only had to make it because §1 pushed us off the API's own
transaction.

## What worked well

- **Quoting and routing are excellent.** One POST, and the response carries
  everything we needed. This is the part that made the integration worth doing.
- **`routeString` is genuinely useful.** Human-readable *and* machine-parseable
  — we derive the fee tier from it, which we did not expect to be able to do.
- **The developer dashboard is frictionless.** Key in under a minute, working
  immediately, no approval wait.
- **Error status codes are sane** (`4xx` vs `5xx`), so distinguishing "my
  request is wrong" from "upstream is unhappy" was easy — see our freshness
  handling in [`app/src/lib/uniswap.ts`](app/src/lib/uniswap.ts).

## Environment

Base mainnet (8453) via `anvil --fork-url https://mainnet.base.org`, viem 2.x,
Trading API v1, July 2026. The shipped code calls `/v1/quote`; `/v1/swap` and
its Permit2 calldata are what §1 describes — reached during the work, not in the
final integration.
