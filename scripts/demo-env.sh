#!/usr/bin/env bash
# Bacalhau local demo environment on a Base fork.
# Starts anvil forked from Base (so real WETH/USDC and Uniswap pools exist),
# deploys Aqua + BacalhauRouter, seeds a strategy with one fill, and writes
# addresses to contracts/deployments/local.json (+ app/public/local.json).
#
# Usage: ./scripts/demo-env.sh            (run inside `nix develop`)
# Env:   BASE_RPC_URL  upstream Base RPC to fork (default: public endpoint)
set -euo pipefail

cd "$(dirname "$0")/.."

RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
BASE_RPC_URL="${BASE_RPC_URL:-https://mainnet.base.org}"
# anvil default account #0 - demo only, publicly known key
DEPLOYER_KEY="${DEPLOYER_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"

if ! cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1; then
  echo "==> starting anvil forked from Base ($BASE_RPC_URL)"
  anvil --fork-url "$BASE_RPC_URL" --block-time 1 --silent &
  ANVIL_PID=$!
  trap 'kill "$ANVIL_PID" 2>/dev/null || true' INT TERM
  for _ in $(seq 1 100); do
    cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1 && break
    sleep 0.3
  done
  echo "==> anvil up (pid $ANVIL_PID), chain $(cast chain-id --rpc-url "$RPC_URL")"
else
  echo "==> reusing node at $RPC_URL (chain $(cast chain-id --rpc-url "$RPC_URL"))"
  ANVIL_PID=""
fi

echo "==> deploying demo environment"
(cd contracts && DEPLOYER_PK="$DEPLOYER_KEY" forge script script/DemoEnv.s.sol:DemoEnv \
  --rpc-url "$RPC_URL" \
  --broadcast -vv)

echo "==> seeding one fill so the dashboard opens with history"
DEP=contracts/deployments/local.json
MAKER=$(jq -r .maker "$DEP")
TAKER=$(jq -r .taker "$DEP")
ROUTER=$(jq -r .router "$DEP")
WETH=$(jq -r .weth "$DEP")
USDC=$(jq -r .usdc "$DEP")
HASH=$(jq -r .seedStrategyHash "$DEP")
# Fund maker (WETH+USDC for the strategy) and taker (WETH for the fill).
cast rpc anvil_setBalance "$MAKER" 0xde0b6b3a7640000 --rpc-url "$RPC_URL" >/dev/null
./scripts/deal.sh "$WETH" "$MAKER" 1000000000000000000000 "$RPC_URL"
./scripts/deal.sh "$USDC" "$MAKER" 2000000000000 "$RPC_URL"
./scripts/deal.sh "$WETH" "$TAKER" 10000000000000000000 "$RPC_URL"

# The seed strategy starts live with zero fills; the first swap is done from
# the app (test-swap panel), which is the live demo beat anyway.

echo
echo "==> publishing addresses to the app"
mkdir -p app/public
cp contracts/deployments/local.json app/public/local.json

echo
echo "==> done. addresses: contracts/deployments/local.json (+ app/public/local.json)"
if [ -n "$ANVIL_PID" ]; then
  echo "==> anvil keeps running in foreground; Ctrl-C to stop"
  wait "$ANVIL_PID"
fi
