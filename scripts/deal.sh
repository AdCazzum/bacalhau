#!/usr/bin/env bash
# Give `account` a balance of `amount` (wei) of ERC20 `token` on an anvil fork
# by writing the balances-mapping storage slot directly. Probes declared slots
# 0..20, computing keccak256(abi.encode(account, slot)) for each, and verifies
# via balanceOf so it works for proxies and non-standard layouts alike.
#
# Usage: ./scripts/deal.sh <token> <account> <amount-wei> [rpc]
set -euo pipefail

TOKEN="$1"; ACCOUNT="$2"; AMOUNT="$3"; RPC="${4:-http://127.0.0.1:8545}"
VALUE=$(cast to-uint256 "$AMOUNT")

for SLOT in $(seq 0 20); do
  KEY=$(cast keccak "$(cast abi-encode "f(address,uint256)" "$ACCOUNT" "$SLOT")")
  PREV=$(cast storage "$TOKEN" "$KEY" --rpc-url "$RPC")
  cast rpc anvil_setStorageAt "$TOKEN" "$KEY" "$VALUE" --rpc-url "$RPC" >/dev/null
  BAL=$(cast call "$TOKEN" "balanceOf(address)(uint256)" "$ACCOUNT" --rpc-url "$RPC" | awk '{print $1}')
  if [ "$BAL" = "$AMOUNT" ]; then
    echo "   dealt $AMOUNT of $TOKEN to $ACCOUNT (slot $SLOT)"
    exit 0
  fi
  cast rpc anvil_setStorageAt "$TOKEN" "$KEY" "$PREV" --rpc-url "$RPC" >/dev/null
done

echo "!! could not find balance slot for $TOKEN" >&2
exit 1
