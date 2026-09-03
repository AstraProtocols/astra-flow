#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

NETWORK="${STELLAR_NETWORK:-testnet}"
IDENTITY="${STELLAR_IDENTITY:-astra-deployer}"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"

echo "==> Building escrow contract"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
if command -v stellar >/dev/null 2>&1; then
  stellar contract build
else
  echo "stellar CLI not found; falling back to cargo wasm build"
  cargo build --target wasm32v1-none --release || cargo build --target wasm32-unknown-unknown --release
fi

WASM=""
for candidate in \
  "$ROOT/target/wasm32v1-none/release/escrow.wasm" \
  "$ROOT/target/wasm32-unknown-unknown/release/escrow.wasm"
do
  if [[ -f "$candidate" ]]; then
    WASM="$candidate"
    break
  fi
done

if [[ -z "$WASM" ]]; then
  echo "error: compiled wasm not found under target/"
  exit 1
fi

echo "==> Using wasm: $WASM"

if ! stellar keys ls | grep -qx "$IDENTITY"; then
  echo "==> Generating identity '$IDENTITY' on $NETWORK"
  stellar keys generate --network "$NETWORK" "$IDENTITY"
fi

echo "==> Funding identity from friendbot (testnet)"
if [[ "$NETWORK" == "testnet" ]]; then
  stellar keys fund "$IDENTITY" --network "$NETWORK" || true
fi

echo "==> Deploying escrow"
CONTRACT_ID="$(
  stellar contract deploy \
    --wasm "$WASM" \
    --source-account "$IDENTITY" \
    --network "$NETWORK" \
    --alias escrow
)"

echo "==> Contract ID: $CONTRACT_ID"

touch "$ENV_FILE"
upsert_env() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

upsert_env "ESCROW_CONTRACT_ID" "$CONTRACT_ID"
upsert_env "NEXT_PUBLIC_ESCROW_CONTRACT_ID" "$CONTRACT_ID"
upsert_env "STELLAR_NETWORK" "$NETWORK"
upsert_env "STELLAR_IDENTITY" "$IDENTITY"

mkdir -p "$ROOT/apps/client" "$ROOT/apps/server"
cp "$ENV_FILE" "$ROOT/apps/client/.env.local" 2>/dev/null || true
grep -E '^(ESCROW_CONTRACT_ID|STELLAR_NETWORK|SOROBAN_RPC_URL)=' "$ENV_FILE" > "$ROOT/apps/server/.env" || true

echo "==> Bindings written to $ENV_FILE"
echo "Done."
