#!/usr/bin/env bash
# Bacalhau local demo environment.
# Starts anvil (unless already running) and deploys Aqua + BacalhauRouter +
# demo tokens + a seeded strategy with one fill. Addresses land in
# contracts/deployments/local.json for the app.
#
# Usage: ./scripts/demo-env.sh          (run inside `nix develop`)
set -euo pipefail

cd "$(dirname "$0")/.."

RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
# anvil default account #0 - demo only, publicly known key
DEPLOYER_KEY="${DEPLOYER_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"

if ! cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1; then
  echo "==> starting anvil (chain 31337, 1s blocks)"
  anvil --block-time 1 --silent &
  ANVIL_PID=$!
  trap 'kill "$ANVIL_PID" 2>/dev/null || true' INT TERM
  for _ in $(seq 1 50); do
    cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1 && break
    sleep 0.2
  done
  echo "==> anvil up (pid $ANVIL_PID)"
else
  echo "==> reusing anvil at $RPC_URL"
  ANVIL_PID=""
fi

echo "==> deploying demo environment"
(cd contracts && forge script script/DemoEnv.s.sol \
  --rpc-url "$RPC_URL" \
  --private-key "$DEPLOYER_KEY" \
  --broadcast -vv)

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
