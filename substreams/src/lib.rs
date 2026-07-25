mod abi;
mod pb;

use hex::ToHex;
use pb::bacalhau::v1 as bacalhau;
use substreams::errors::Error;
use substreams::Hex;
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
