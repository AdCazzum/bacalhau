import { useEffect, useRef, useState } from "react";
import type { Address, GetContractEventsReturnType, Hex } from "viem";

import { aquaAbi, erc20Abi } from "../lib/abi";
import { loadDeployment, publicClient, type Deployment } from "../lib/chain";
import { decodeOrder, type Order } from "../lib/order";

export interface Strategy {
  hash: Hex;
  order: Order;
  program: Hex;
  status: "live" | "docked";
  balanceWeth: bigint;
  balanceUsdc: bigint;
  fills: Fill[];
}

export interface Fill {
  txHash: Hex;
  blockNumber: bigint;
  strategyHash: Hex;
  tokenIn: Address;
  amountIn: bigint;
  tokenOut: Address;
  amountOut: bigint;
}

export interface WalletBalances {
  weth: bigint;
  usdc: bigint;
}

export interface DemoState {
  deployment: Deployment | null;
  strategies: Strategy[];
  fills: Fill[]; // newest first, across all strategies
  wallet: WalletBalances | null;
  error: string | null;
  refresh: () => void;
}

const POLL_MS = 2000;

/** Error text without the "Error:" prefix `String(e)` would prepend. */
function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function useDemo(): DemoState {
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [fills, setFills] = useState<Fill[]>([]);
  const [wallet, setWallet] = useState<WalletBalances | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const busy = useRef(false);

  useEffect(() => {
    loadDeployment().then(setDeployment).catch((e) => setError(msg(e)));
  }, []);

  useEffect(() => {
    if (!deployment) return;
    const timer = setInterval(() => setTick((t) => t + 1), POLL_MS);
    return () => clearInterval(timer);
  }, [deployment]);

  useEffect(() => {
    if (!deployment || busy.current) return;
    busy.current = true;
    sync(deployment)
      .then(({ strategies, fills, wallet }) => {
        setStrategies(strategies);
        setFills(fills);
        setWallet(wallet);
        setError(null);
      })
      .catch((e) => setError(msg(e)))
      .finally(() => {
        busy.current = false;
      });
  }, [deployment, tick]);

  return { deployment, strategies, fills, wallet, error, refresh: () => setTick((t) => t + 1) };
}

type AquaEvents = GetContractEventsReturnType<typeof aquaAbi>;

/**
 * Public RPCs cap eth_getLogs at a 2000-block span, and the Base Sepolia
 * deployment is thousands of blocks behind the head. anvil has no such cap,
 * but paginating there costs one request, so the same path serves both.
 */
const LOG_WINDOW = 2000n;
const LOG_CONCURRENCY = 8;

async function fetchAquaEvents(dep: Deployment): Promise<AquaEvents> {
  const head = await publicClient.getBlockNumber();
  const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
  for (let from = BigInt(dep.deployBlock); from <= head; from += LOG_WINDOW) {
    const to = from + LOG_WINDOW - 1n;
    ranges.push({ fromBlock: from, toBlock: to > head ? head : to });
  }

  // Batched rather than one big Promise.all: public endpoints rate-limit, and
  // sequential batches keep the results in block order for the reducer below.
  let events: AquaEvents = [];
  for (let i = 0; i < ranges.length; i += LOG_CONCURRENCY) {
    const batch = await Promise.all(
      ranges
        .slice(i, i + LOG_CONCURRENCY)
        .map((range) =>
          publicClient.getContractEvents({ address: dep.aqua, abi: aquaAbi, ...range }),
        ),
    );
    events = events.concat(...batch);
  }
  return events;
}

async function sync(
  dep: Deployment,
): Promise<{ strategies: Strategy[]; fills: Fill[]; wallet: WalletBalances }> {
  const logs = await fetchAquaEvents(dep);

  const docked = new Set<Hex>();
  const shipped = new Map<Hex, Order>();
  const pushes: { tx: Hex; block: bigint; hash: Hex; token: Address; amount: bigint }[] = [];
  const pulls: { tx: Hex; block: bigint; hash: Hex; token: Address; amount: bigint }[] = [];

  for (const log of logs) {
    const a = log.args as Record<string, unknown>;
    const hash = a.strategyHash as Hex;
    switch (log.eventName) {
      case "Shipped":
        shipped.set(hash, decodeOrder(a.strategy as Hex));
        break;
      case "Docked":
        docked.add(hash);
        break;
      case "Pushed":
        pushes.push({
          tx: log.transactionHash, block: log.blockNumber,
          hash, token: a.token as Address, amount: a.amount as bigint,
        });
        break;
      case "Pulled":
        pulls.push({
          tx: log.transactionHash, block: log.blockNumber,
          hash, token: a.token as Address, amount: a.amount as bigint,
        });
        break;
    }
  }

  // A fill = Pushed (taker pays in) + Pulled (maker pays out) in one tx.
  const fills: Fill[] = [];
  for (const push of pushes) {
    const pull = pulls.find((p) => p.tx === push.tx && p.hash === push.hash);
    if (pull) {
      fills.push({
        txHash: push.tx,
        blockNumber: push.block,
        strategyHash: push.hash,
        tokenIn: push.token,
        amountIn: push.amount,
        tokenOut: pull.token,
        amountOut: pull.amount,
      });
    }
  }
  fills.sort((x, y) => Number(y.blockNumber - x.blockNumber));

  const strategies: Strategy[] = [];
  for (const [hash, order] of shipped) {
    const status = docked.has(hash) ? "docked" : "live";
    let balanceWeth = 0n;
    let balanceUsdc = 0n;
    if (status === "live") {
      [balanceWeth, balanceUsdc] = await publicClient.readContract({
        address: dep.aqua,
        abi: aquaAbi,
        functionName: "safeBalances",
        args: [order.maker, dep.router, hash, dep.weth, dep.usdc],
      });
    }
    strategies.push({
      hash,
      order,
      program: order.data,
      status,
      balanceWeth,
      balanceUsdc,
      fills: fills.filter((f) => f.strategyHash === hash),
    });
  }
  strategies.sort((a, b) => (a.status === "live" ? -1 : 1) - (b.status === "live" ? -1 : 1));

  const [walletWeth, walletUsdc] = await Promise.all([
    publicClient.readContract({ address: dep.weth, abi: erc20Abi, functionName: "balanceOf", args: [dep.maker] }) as Promise<bigint>,
    publicClient.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "balanceOf", args: [dep.maker] }) as Promise<bigint>,
  ]);

  return { strategies, fills, wallet: { weth: walletWeth, usdc: walletUsdc } };
}
