#!/bin/sh
# Boot Anvil, wait for it to answer, then deploy the demo contracts into it.
# A fresh chain always puts them at the same addresses, which is why the
# frontend can ship those addresses instead of discovering them.
#
# POSIX sh on purpose: the Foundry image is Alpine, which has no bash.
set -eu

PORT="${PORT:-8545}"
RPC="http://127.0.0.1:${PORT}"

echo "starting anvil on 0.0.0.0:${PORT}"
anvil --host 0.0.0.0 --port "${PORT}" --block-time 2 &
ANVIL_PID=$!

echo "waiting for rpc"
i=0
while [ "$i" -lt 60 ]; do
  if cast block-number --rpc-url "${RPC}" >/dev/null 2>&1; then
    echo "rpc is up"
    break
  fi
  i=$((i + 1))
  sleep 0.5
done

if ! cast block-number --rpc-url "${RPC}" >/dev/null 2>&1; then
  echo "anvil never answered on ${RPC}" >&2
  exit 1
fi

echo "deploying contracts"
cd contracts
forge script script/Deploy.s.sol:Deploy --rpc-url "${RPC}" --broadcast
cd ..

echo "chain ready on ${PORT}"
wait "${ANVIL_PID}"
