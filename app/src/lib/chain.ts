import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

/**
 * PoC posture (docs/08): the app drives a local demo wallet directly —
 * anvil account #0, publicly known key. No wallet extension on stage.
 */
const DEMO_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export const demoAccount = privateKeyToAccount(DEMO_KEY);

export const publicClient = createPublicClient({ chain: foundry, transport: http() });

export const walletClient = createWalletClient({
  account: demoAccount,
  chain: foundry,
  transport: http(),
});

export interface Deployment {
  aqua: Address;
  router: Address;
  weth: Address;
  usdc: Address;
  maker: Address;
  taker: Address;
  seedStrategyHash: Hex;
}

/** Written by scripts/demo-env.sh into app/public/local.json. */
export async function loadDeployment(): Promise<Deployment> {
  const res = await fetch("/local.json");
  if (!res.ok) {
    throw new Error("deployments/local.json not found - run ./scripts/demo-env.sh first");
  }
  return res.json();
}
