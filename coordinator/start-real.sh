#!/usr/bin/env bash
# Start the coordinator with real Monero (stagenet) + real OPNet (testnet).
# Usage: ./start-real.sh
#
# Prerequisites:
#   1. monero-wallet-rpc running: ~/monero-cli/monero-wallet-rpc --stagenet \
#        --rpc-bind-port 18082 --daemon-address node.monerodevs.org:38089 \
#        --wallet-dir ~/monero-wallets --disable-rpc-login --trusted-daemon
#   2. Coordinator built: npm run build
#   3. SwapVault contract deployed on OPNet testnet

set -euo pipefail
cd "$(dirname "$0")"

# ── OPNet ────────────────────────────────────────────────────────────────────
export SWAP_CONTRACT_ADDRESS="opt1sqpfk6a2m6ngae8yyztvrsmd0efup67pleuf243nm"

# ── Monero (stagenet, real wallet-rpc) ───────────────────────────────────────
export MONERO_MOCK="false"
export XMR_WALLET_RPC_URL="http://localhost:18082/json_rpc"
export XMR_WALLET_RPC_USER=""
export XMR_WALLET_RPC_PASS=""
export XMR_WALLET_NAME="coordinator"
export XMR_WALLET_PASS=""
export XMR_FEE_ADDRESS="55bpfbMNm3oUfs8bBN6BjieP6fVABs6Cy6481oAh7n77EuYypQFwt3wFausbcKPqtrJzDYcr4vxBPYNx7ZFDCufY32tBwza"
export XMR_POLL_INTERVAL_MS="15000"

# ── Server ───────────────────────────────────────────────────────────────────
export PORT="3099"
export ADMIN_API_KEY="test-admin-key-that-is-at-least-32-chars-long"
export CORS_ORIGIN="http://localhost:5173,http://localhost:5174"
export DB_PATH="./data/coordinator-real.db"
export DB_BACKUP_INTERVAL_MS="60000"

# ── Safety ───────────────────────────────────────────────────────────────────
export RATE_LIMIT_DISABLED="false"

# ── Ensure data dir exists ───────────────────────────────────────────────────
mkdir -p ./data

# ── Preflight checks ────────────────────────────────────────────────────────
echo "Checking monero-wallet-rpc..."
if ! curl -s -X POST "$XMR_WALLET_RPC_URL" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"0","method":"get_version","params":{}}' \
  | grep -q '"result"'; then
  echo "ERROR: monero-wallet-rpc not reachable at $XMR_WALLET_RPC_URL"
  echo "Start it first:"
  echo "  ~/monero-cli/monero-wallet-rpc --stagenet --rpc-bind-port 18082 \\"
  echo "    --daemon-address node.monerodevs.org:38089 \\"
  echo "    --wallet-dir ~/monero-wallets --disable-rpc-login --trusted-daemon"
  exit 1
fi
echo "  monero-wallet-rpc OK"

echo "Checking OPNet testnet..."
if ! curl -s --max-time 10 -X POST https://testnet.opnet.org \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"btc_blockNumber","params":[]}' \
  | grep -q '"result"'; then
  echo "WARNING: OPNet testnet RPC not responding (may be temporary)"
fi
echo "  OPNet RPC checked"

echo ""
echo "Starting coordinator on port $PORT"
echo "  Contract: $SWAP_CONTRACT_ADDRESS"
echo "  Monero:   stagenet (real wallet-rpc)"
echo "  DB:       $DB_PATH"
echo ""

if [ -f dist/src/index.js ]; then
    node dist/src/index.js
else
    node dist/index.js
fi
