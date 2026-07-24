import { useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";

import { aquaAbi } from "../lib/abi";
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

export interface DemoState {
  deployment: Deployment | null;
  strategies: Strategy[];
  fills: Fill[]; // newest first, across all strategies
  error: string | null;
  refresh: () => void;
}

const POLL_MS = 2000;

export function useDemo(): DemoState {
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [fills, setFills] = useState<Fill[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const busy = useRef(false);

  useEffect(() => {
    loadDeployment().then(setDeployment).catch((e) => setError(String(e)));
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
      .then(({ strategies, fills }) => {
        setStrategies(strategies);
        setFills(fills);
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => {
        busy.current = false;
      });
  }, [deployment, tick]);

  return { deployment, strategies, fills, error, refresh: () => setTick((t) => t + 1) };
}

async function sync(dep: Deployment): Promise<{ strategies: Strategy[]; fills: Fill[] }> {
  const logs = await publicClient.getContractEvents({
    address: dep.aqua,
    abi: aquaAbi,
    fromBlock: 0n,
  });

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

  return { strategies, fills };
}
