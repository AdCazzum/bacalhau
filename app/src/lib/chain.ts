import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

/**
 * PoC posture (docs/08): the app drives a demo wallet directly — no wallet
 * extension on stage. Locally that is anvil account #0 (publicly known key).
 * The public build bakes in VITE_DEMO_KEY: a throwaway Base Sepolia key that
 * only ever holds testnet gas and mock tokens, shipped knowingly so visitors
 * can execute the whole flow. Anyone may drain it; there is nothing to drain.
 */
const DEMO_KEY: Hex =
  (import.meta.env.VITE_DEMO_KEY as Hex | undefined) ??
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/**
 * The public build targets Base Sepolia, where the demo deployment is real
 * and reachable; the local build targets the anvil fork on 127.0.0.1, which
 * only exists on the machine running `nix run .#dev`.
 */
export const isPublicDemo = import.meta.env.VITE_PUBLIC_DEMO === "1";

/** anvil fork of Base: chain id 8453 (must match for Permit2 EIP-712), local RPC. */
const forkChain = defineChain({
  ...base,
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

const chain = isPublicDemo ? baseSepolia : forkChain;

/**
 * Writes need a funded key. Locally that is anvil account #0; the public
 * build writes on Base Sepolia only when a demo key was baked in at build
 * time — without one it stays read-only.
 */
export const canWrite = !isPublicDemo || Boolean(import.meta.env.VITE_DEMO_KEY);

export const demoAccount = privateKeyToAccount(DEMO_KEY);

export const publicClient = createPublicClient({ chain, transport: http() });

export const walletClient = createWalletClient({
  account: demoAccount,
  chain,
  transport: http(),
});

export interface Deployment {
  aqua: Address;
  router: Address;
  weth: Address;
  usdc: Address;
  usdcDecimals: number;
  chainId: number;
  deployBlock: number;
  maker: Address;
  /** Absent on the public Base Sepolia record: fill simulation is local-only. */
  taker?: Address;
  seedStrategyHash: Hex;
}

const NO_DEPLOYMENT = isPublicDemo
  ? "Deployment record missing from this build — this is a bug, please report it."
  : "No local deployment found — run ./scripts/demo-env.sh, then reload.";

/**
 * Locally this is written by scripts/demo-env.sh into app/public/local.json;
 * the public build ships contracts/deployments/sepolia.json under the same
 * name, so the app does not care which chain it ended up on.
 */
export async function loadDeployment(): Promise<Deployment> {
  const res = await fetch("/local.json");
  // The dev server answers unknown paths with index.html (SPA fallback), so a
  // missing file arrives as 200 + HTML rather than a 404. Parse defensively:
  // otherwise the first thing a fresh clone shows is a JSON syntax error.
  if (!res.ok) throw new Error(NO_DEPLOYMENT);
  const body = await res.text();
  if (!body.trimStart().startsWith("{")) throw new Error(NO_DEPLOYMENT);
  try {
    return JSON.parse(body) as Deployment;
  } catch {
    throw new Error("local.json is not valid JSON — re-run ./scripts/demo-env.sh.");
  }
}
