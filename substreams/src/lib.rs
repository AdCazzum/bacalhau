mod abi;
mod pb;

use hex::ToHex;
use pb::bacalhau::v1 as bacalhau;
use substreams::errors::Error;
use substreams::pb::substreams::store_delta::Operation;
use substreams::scalar::BigInt;
use substreams::store::{
    DeltaString, Deltas, StoreAdd, StoreAddBigInt, StoreAddInt64, StoreGet, StoreGetBigInt,
    StoreGetInt64, StoreNew, StoreSet, StoreSetString,
};
use substreams::Hex;
use substreams_entity_change::pb::entity::EntityChanges;
use substreams_entity_change::tables::Tables;
use substreams_ethereum::pb::eth::v2 as eth;
use substreams_ethereum::Event;

/// Parse `aqua=0x...` params into the Aqua contract address (lowercase, no 0x).
fn aqua_address(params: &str) -> Vec<u8> {
    let raw = params
        .split('&')
        .find_map(|kv| kv.strip_prefix("aqua="))
        .unwrap_or(params)
        .trim_start_matches("0x");
    Hex::decode(raw).unwrap_or_default()
}

fn meta(block: &eth::Block, trx: &eth::TransactionTrace, log: &eth::Log) -> bacalhau::Meta {
    bacalhau::Meta {
        block_number: block.number,
        block_timestamp: block
            .header
            .as_ref()
            .and_then(|h| h.timestamp.as_ref())
            .map(|t| t.seconds as u64)
            .unwrap_or(0),
        tx_hash: format!("0x{}", trx.hash.encode_hex::<String>()),
        log_index: log.block_index,
    }
}

#[substreams::handlers::map]
fn map_events(params: String, block: eth::Block) -> Result<bacalhau::Events, Error> {
    let aqua = aqua_address(&params);
    let mut events = bacalhau::Events::default();

    for trx in block.transaction_traces.iter() {
        for log in trx.receipt.as_ref().map(|r| &r.logs).into_iter().flatten() {
            if log.address != aqua {
                continue;
            }
            let m = meta(&block, trx, log);

            if let Some(e) = abi::aqua::events::Shipped::match_and_decode(log) {
                events.shipped.push(bacalhau::Shipped {
                    meta: Some(m),
                    maker: format!("0x{}", Hex(&e.maker)),
                    app: format!("0x{}", Hex(&e.app)),
                    strategy_hash: format!("0x{}", Hex(&e.strategy_hash)),
                    strategy: format!("0x{}", Hex(&e.strategy)),
                });
            } else if let Some(e) = abi::aqua::events::Docked::match_and_decode(log) {
                events.docked.push(bacalhau::Docked {
                    meta: Some(m),
                    maker: format!("0x{}", Hex(&e.maker)),
                    app: format!("0x{}", Hex(&e.app)),
                    strategy_hash: format!("0x{}", Hex(&e.strategy_hash)),
                });
            } else if let Some(e) = abi::aqua::events::Pulled::match_and_decode(log) {
                events.pulled.push(bacalhau::Pulled {
                    meta: Some(m),
                    maker: format!("0x{}", Hex(&e.maker)),
                    app: format!("0x{}", Hex(&e.app)),
                    strategy_hash: format!("0x{}", Hex(&e.strategy_hash)),
                    token: format!("0x{}", Hex(&e.token)),
                    amount: e.amount.to_string(),
                });
            } else if let Some(e) = abi::aqua::events::Pushed::match_and_decode(log) {
                events.pushed.push(bacalhau::Pushed {
                    meta: Some(m),
                    maker: format!("0x{}", Hex(&e.maker)),
                    app: format!("0x{}", Hex(&e.app)),
                    strategy_hash: format!("0x{}", Hex(&e.strategy_hash)),
                    token: format!("0x{}", Hex(&e.token)),
                    amount: e.amount.to_string(),
                });
            }
        }
    }

    Ok(events)
}

/// One decoded event tagged for merged, on-chain-ordered processing.
enum AquaEvent<'a> {
    Shipped(&'a bacalhau::Shipped),
    Docked(&'a bacalhau::Docked),
    Pulled(&'a bacalhau::Pulled),
    Pushed(&'a bacalhau::Pushed),
}

/// Store/entity ordinal for an event: its log index within the block.
fn log_ordinal(meta: &Option<bacalhau::Meta>) -> u64 {
    meta.as_ref().map(|m| m.log_index as u64).unwrap_or(0)
}

/// Merge the per-type event lists back into log order. A dock and a re-ship
/// of the same strategy can share a block; applying them out of order would
/// leave the wrong final status.
fn ordered(events: &bacalhau::Events) -> Vec<(u64, AquaEvent<'_>)> {
    let mut merged = Vec::with_capacity(
        events.shipped.len() + events.docked.len() + events.pulled.len() + events.pushed.len(),
    );
    merged.extend(events.shipped.iter().map(|e| (log_ordinal(&e.meta), AquaEvent::Shipped(e))));
    merged.extend(events.docked.iter().map(|e| (log_ordinal(&e.meta), AquaEvent::Docked(e))));
    merged.extend(events.pulled.iter().map(|e| (log_ordinal(&e.meta), AquaEvent::Pulled(e))));
    merged.extend(events.pushed.iter().map(|e| (log_ordinal(&e.meta), AquaEvent::Pushed(e))));
    merged.sort_by_key(|(ordinal, _)| *ordinal);
    merged
}

/// Decode a `0x...` hex string into raw bytes for a GraphQL `Bytes` column.
/// graph-node validates values against schema.graphql field types, so Bytes
/// columns must arrive as bytes, not as hex strings.
fn hex_bytes(value: &str) -> Vec<u8> {
    Hex::decode(value.trim_start_matches("0x")).unwrap_or_default()
}

/// Parse a decimal uint256 string (produced by map_events) into a BigInt.
fn amount_bigint(value: &str) -> BigInt {
    value.parse::<BigInt>().unwrap_or_else(|_| BigInt::zero())
}

fn strategy_fills_key(strategy_hash: &str) -> String {
    format!("strategy:{strategy_hash}:fills")
}

fn strategy_seen_key(strategy_hash: &str) -> String {
    format!("strategy:{strategy_hash}:seen")
}

fn volume_key(strategy_hash: &str, token: &str, direction: &str) -> String {
    format!("{strategy_hash}:{token}:{direction}")
}

/// Strategy lifecycle status keyed by strategy hash ("LIVE" / "DOCKED").
/// Its deltas drive store_counters: a CREATE delta marks the first in-range
/// ship, and LIVE <-> DOCKED transitions move `liveStrategyCount`.
#[substreams::handlers::store]
fn store_status(events: bacalhau::Events, store: StoreSetString) {
    for (ordinal, event) in ordered(&events) {
        match event {
            AquaEvent::Shipped(e) => store.set(ordinal, &e.strategy_hash, &"LIVE"),
            AquaEvent::Docked(e) => store.set(ordinal, &e.strategy_hash, &"DOCKED"),
            AquaEvent::Pulled(_) | AquaEvent::Pushed(_) => {}
        }
    }
}

/// Additive counters backing the non-nullable Int fields of the schema:
///   protocol:strategies      distinct strategies shipped in range
///   protocol:live            currently-LIVE strategies
///   protocol:fills           Pulled events (one per swap)
///   strategy:<hash>:fills    Pulled events touching one strategy
///   strategy:<hash>:seen     1 once the strategy was shipped in range
#[substreams::handlers::store]
fn store_counters(events: bacalhau::Events, statuses: Deltas<DeltaString>, store: StoreAddInt64) {
    for delta in statuses.deltas.iter() {
        let now_live = delta.new_value == "LIVE";
        match delta.operation {
            Operation::Create if now_live => {
                store.add(delta.ordinal, "protocol:strategies", 1);
                store.add(delta.ordinal, "protocol:live", 1);
                store.add(delta.ordinal, strategy_seen_key(&delta.key), 1);
            }
            Operation::Update if now_live && delta.old_value == "DOCKED" => {
                store.add(delta.ordinal, "protocol:live", 1);
            }
            Operation::Update if !now_live && delta.old_value == "LIVE" => {
                store.add(delta.ordinal, "protocol:live", -1);
            }
            // LIVE -> LIVE re-ships and docks of never-shipped hashes move
            // nothing, mirroring subgraph/src/mapping.ts.
            _ => {}
        }
    }

    for e in events.pulled.iter() {
        // A swap emits one Pulled and one Pushed; counting pulls makes these
        // track swaps, not token movements (same rule as mapping.ts).
        let ordinal = log_ordinal(&e.meta);
        store.add(ordinal, "protocol:fills", 1);
        store.add(ordinal, strategy_fills_key(&e.strategy_hash), 1);
    }
}

/// Cumulative per-(strategy, token) raw amounts, split by direction:
/// `<hash>:<token>:pulled` / `<hash>:<token>:pushed`.
#[substreams::handlers::store]
fn store_volumes(events: bacalhau::Events, store: StoreAddBigInt) {
    for e in events.pulled.iter() {
        store.add(
            log_ordinal(&e.meta),
            volume_key(&e.strategy_hash, &e.token, "pulled"),
            amount_bigint(&e.amount),
        );
    }
    for e in events.pushed.iter() {
        store.add(
            log_ordinal(&e.meta),
            volume_key(&e.strategy_hash, &e.token, "pushed"),
            amount_bigint(&e.amount),
        );
    }
}

/// Read an additive counter as the i32 that graph-node expects for `Int!`.
fn counter(counters: &StoreGetInt64, key: &str) -> i32 {
    counters.get_last(key).unwrap_or(0) as i32
}

/// True once the strategy was shipped inside the indexed range, i.e. a
/// Strategy row exists. Mirrors the `Strategy.load(...) == null` guards in
/// subgraph/src/mapping.ts.
fn strategy_seen(counters: &StoreGetInt64, strategy_hash: &str) -> bool {
    counters.get_last(strategy_seen_key(strategy_hash)).is_some()
}

/// Materialize the GraphQL entities (subgraph/schema.graphql) from decoded
/// events. EntityChanges carry SET semantics — graph-node overwrites the
/// fields present in a change, it does not fold deltas — so every cumulative
/// field written here is the absolute end-of-block value read back from the
/// counter/volume stores (`get` mode exposes a store after the current block
/// was applied).
///
/// Known divergence from subgraph/src/mapping.ts: EntityChanges cannot write
/// `null`, so a strategy re-shipped after a dock keeps its stale `dockedAt`
/// (status still flips back to LIVE).
#[substreams::handlers::map]
fn graph_out(
    events: bacalhau::Events,
    counters: StoreGetInt64,
    volumes: StoreGetBigInt,
) -> Result<EntityChanges, Error> {
    let mut tables = Tables::new();
    let ordered_events = ordered(&events);
    if ordered_events.is_empty() {
        return Ok(tables.to_entity_changes());
    }

    for (_, event) in ordered_events {
        match event {
            AquaEvent::Shipped(e) => {
                let m = e.meta.as_ref().unwrap();
                // Full upsert: on a re-ship the row already exists and every
                // field below is still the correct current value (fillCount
                // is cumulative in the store, and the same hash implies the
                // same program bytes).
                tables
                    .update_row("Strategy", &e.strategy_hash)
                    .set("maker", hex_bytes(&e.maker))
                    .set("app", hex_bytes(&e.app))
                    .set("program", hex_bytes(&e.strategy))
                    .set("status", "LIVE")
                    .set("shippedAt", m.block_timestamp)
                    .set("shippedTx", hex_bytes(&m.tx_hash))
                    .set("fillCount", counter(&counters, &strategy_fills_key(&e.strategy_hash)));
            }
            AquaEvent::Docked(e) => {
                // A dock for a hash never shipped in range has no Strategy
                // row; updating one would materialize a row missing its
                // non-nullable fields. mapping.ts skips it the same way.
                if !strategy_seen(&counters, &e.strategy_hash) {
                    continue;
                }
                let m = e.meta.as_ref().unwrap();
                tables
                    .update_row("Strategy", &e.strategy_hash)
                    .set("status", "DOCKED")
                    .set("dockedAt", m.block_timestamp);
            }
            AquaEvent::Pulled(e) => {
                fill_row(&mut tables, e.meta.as_ref().unwrap(), "PULL", &e.strategy_hash, &e.maker, &e.app, &e.token, &e.amount);
                volume_row(&mut tables, &volumes, &e.strategy_hash, &e.token);
                if strategy_seen(&counters, &e.strategy_hash) {
                    tables
                        .update_row("Strategy", &e.strategy_hash)
                        .set("fillCount", counter(&counters, &strategy_fills_key(&e.strategy_hash)));
                }
            }
            AquaEvent::Pushed(e) => {
                fill_row(&mut tables, e.meta.as_ref().unwrap(), "PUSH", &e.strategy_hash, &e.maker, &e.app, &e.token, &e.amount);
                volume_row(&mut tables, &volumes, &e.strategy_hash, &e.token);
            }
        }
    }

    // Protocol counters are non-nullable; write the absolute end-of-block
    // values whenever any event could have moved them.
    tables
        .update_row("Protocol", "aqua")
        .set("strategyCount", counter(&counters, "protocol:strategies"))
        .set("liveStrategyCount", counter(&counters, "protocol:live"))
        .set("fillCount", counter(&counters, "protocol:fills"));

    Ok(tables.to_entity_changes())
}

#[allow(clippy::too_many_arguments)]
fn fill_row(
    tables: &mut Tables,
    m: &bacalhau::Meta,
    direction: &str,
    strategy_hash: &str,
    maker: &str,
    app: &str,
    token: &str,
    amount: &str,
) {
    let id = format!("{}-{}", m.tx_hash, m.log_index);
    tables
        .create_row("Fill", id)
        .set("strategy", strategy_hash)
        .set("direction", direction)
        .set("maker", hex_bytes(maker))
        .set("app", hex_bytes(app))
        .set("token", hex_bytes(token))
        .set_bigint_or_zero("amount", &amount.to_string())
        .set("blockNumber", m.block_number)
        .set("timestamp", m.block_timestamp)
        .set("txHash", hex_bytes(&m.tx_hash))
        .set("logIndex", m.log_index as i32);
}

/// Upsert the cumulative per-(strategy, token) volume row from the store's
/// end-of-block totals. The id mirrors mapping.ts: `<strategyHash>-<token>`.
fn volume_row(tables: &mut Tables, volumes: &StoreGetBigInt, strategy_hash: &str, token: &str) {
    tables
        .update_row("StrategyTokenVolume", format!("{strategy_hash}-{token}"))
        .set("strategy", strategy_hash)
        .set("token", hex_bytes(token))
        .set(
            "pulled",
            volumes
                .get_last(volume_key(strategy_hash, token, "pulled"))
                .unwrap_or_else(BigInt::zero),
        )
        .set(
            "pushed",
            volumes
                .get_last(volume_key(strategy_hash, token, "pushed"))
                .unwrap_or_else(BigInt::zero),
        );
}
