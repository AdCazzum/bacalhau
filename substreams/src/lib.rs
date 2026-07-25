mod abi;
mod pb;

use hex::ToHex;
use pb::bacalhau::v1 as bacalhau;
use substreams::errors::Error;
use substreams::Hex;
use substreams_ethereum::pb::eth::v2 as eth;
use substreams_ethereum::Event;
use substreams_entity_change::pb::entity::EntityChanges;
use substreams_entity_change::tables::Tables;

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

/// Materialize the GraphQL entities (schema.graphql) from decoded events.
/// Aggregates (fillCount, totals, protocol counters) are emitted as deltas so
/// graph-node folds them across blocks.
#[substreams::handlers::map]
fn graph_out(events: bacalhau::Events) -> Result<EntityChanges, Error> {
    let mut tables = Tables::new();

    for e in events.shipped.iter() {
        let m = e.meta.as_ref().unwrap();
        tables
            .create_row("Strategy", &e.strategy_hash)
            .set("maker", &e.maker)
            .set("app", &e.app)
            .set("program", &e.strategy)
            .set("status", "LIVE")
            .set("shippedAt", m.block_timestamp)
            .set("shippedTx", &m.tx_hash)
            .set("fillCount", 0)
            .set("totalPulled", substreams::scalar::BigInt::zero())
            .set("totalPushed", substreams::scalar::BigInt::zero());
        tables.update_row("Protocol", "aqua").set("strategyCount", 1);
    }

    for e in events.docked.iter() {
        let m = e.meta.as_ref().unwrap();
        tables
            .update_row("Strategy", &e.strategy_hash)
            .set("status", "DOCKED")
            .set("dockedAt", m.block_timestamp);
    }

    for e in events.pulled.iter() {
        fill_row(&mut tables, e.meta.as_ref().unwrap(), "PULL", &e.strategy_hash, &e.maker, &e.app, &e.token, &e.amount);
    }

    for e in events.pushed.iter() {
        fill_row(&mut tables, e.meta.as_ref().unwrap(), "PUSH", &e.strategy_hash, &e.maker, &e.app, &e.token, &e.amount);
    }

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
        .set("maker", maker)
        .set("app", app)
        .set("token", token)
        .set_bigint_or_zero("amount", &amount.to_string())
        .set("blockNumber", m.block_number)
        .set("timestamp", m.block_timestamp)
        .set("txHash", &m.tx_hash)
        .set("logIndex", m.log_index as i32);
}
