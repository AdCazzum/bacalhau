import { BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";

import { Docked, Pulled, Pushed, Shipped } from "../generated/Aqua/Aqua";
import { Fill, Protocol, Strategy } from "../generated/schema";

const PROTOCOL_ID = "aqua";

function protocol(): Protocol {
  let p = Protocol.load(PROTOCOL_ID);
  if (p == null) {
    p = new Protocol(PROTOCOL_ID);
    p.strategyCount = 0;
    p.liveStrategyCount = 0;
    p.fillCount = 0;
  }
  return p as Protocol;
}

export function handleShipped(event: Shipped): void {
  const id = event.params.strategyHash.toHexString();
  let s = Strategy.load(id);
  const p = protocol();

  // Track the prior state before writing: reading an unset enum field on a
  // fresh entity traps in AssemblyScript.
  let wasLive = false;
  if (s == null) {
    s = new Strategy(id);
    s.program = event.params.strategy;
    s.fillCount = 0;
    s.totalPulled = BigInt.zero();
    s.totalPushed = BigInt.zero();
    p.strategyCount = p.strategyCount + 1;
  } else {
    wasLive = s.status == "LIVE";
  }

  // Re-shipping an existing hash reactivates it (dock -> ship is the documented
  // way to change parameters, and Aqua keeps the same hash for the same order).
  if (!wasLive) {
    p.liveStrategyCount = p.liveStrategyCount + 1;
  }

  s.maker = event.params.maker;
  s.app = event.params.app;
  s.status = "LIVE";
  s.shippedAt = event.block.timestamp;
  s.shippedTx = event.transaction.hash;
  s.dockedAt = null;
  s.save();
  p.save();
}

export function handleDocked(event: Docked): void {
  const s = Strategy.load(event.params.strategyHash.toHexString());
  if (s == null) return; // docked without a prior ship in range: nothing to update

  if (s.status == "LIVE") {
    const p = protocol();
    p.liveStrategyCount = p.liveStrategyCount - 1;
    p.save();
  }
  s.status = "DOCKED";
  s.dockedAt = event.block.timestamp;
  s.save();
}

export function handlePulled(event: Pulled): void {
  recordFill(
    event,
    "PULL",
    event.params.strategyHash,
    event.params.maker,
    event.params.app,
    event.params.token,
    event.params.amount,
  );
}

export function handlePushed(event: Pushed): void {
  recordFill(
    event,
    "PUSH",
    event.params.strategyHash,
    event.params.maker,
    event.params.app,
    event.params.token,
    event.params.amount,
  );
}

function recordFill(
  event: ethereum.Event,
  direction: string,
  strategyHash: Bytes,
  maker: Bytes,
  app: Bytes,
  token: Bytes,
  amount: BigInt,
): void {
  const strategyId = strategyHash.toHexString();

  const fill = new Fill(
    event.transaction.hash.toHexString() + "-" + event.logIndex.toString(),
  );
  fill.strategy = strategyId;
  fill.direction = direction;
  fill.maker = maker;
  fill.app = app;
  fill.token = token;
  fill.amount = amount;
  fill.blockNumber = event.block.number;
  fill.timestamp = event.block.timestamp;
  fill.txHash = event.transaction.hash;
  fill.logIndex = event.logIndex.toI32();
  fill.save();

  const s = Strategy.load(strategyId);
  if (s != null) {
    // A swap emits one Pulled and one Pushed; count pulls so fillCount tracks
    // swaps, not token movements.
    if (direction == "PULL") {
      s.fillCount = s.fillCount + 1;
      s.totalPulled = s.totalPulled.plus(amount);
    } else {
      s.totalPushed = s.totalPushed.plus(amount);
    }
    s.save();
  }

  const p = protocol();
  if (direction == "PULL") {
    p.fillCount = p.fillCount + 1;
  }
  p.save();
}
