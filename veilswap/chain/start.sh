#!/usr/bin/env bash
# Boot Anvil, wait for it to answer, then deploy the demo contracts into it.
# A fresh chain always puts them at the same addresses, which is why the
# frontend can ship those addresses instead of discovering them.
set -euo pipefail

PORT="${PORT:-8545}"
RPC="http://127.0.0.1:${PORT}"

anvil --host 0.0.0.0 --port "${PORT}" --block-time 2 &
ANVIL_PID=$!

echo "waiting for anvil on ${RPC}"
for _ in $(seq 1 60); do
  if cast block-number --rpc-url "${RPC}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

cd contracts
forge script script/Deploy.s.sol:Deploy --rpc-url "${RPC}" --broadcast
cd ..

echo "chain ready"
wait "${ANVIL_PID}"
