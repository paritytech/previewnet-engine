#!/usr/bin/env bash
# setup-common.sh - config and helpers shared by the polkadot fork's setup scripts.
#
# Usage: source "$(dirname "${BASH_SOURCE[0]}")/lib/setup-common.sh"
#
# Adapted from individuality-community's load-config.sh and utils.sh.

source "$(dirname "${BASH_SOURCE[0]}")/workspace.sh"
source "$PPN_WS/config/ports.env"

command -v dot >/dev/null 2>&1 || { echo "ERROR: dot (polkadot-cli) not installed" >&2; exit 1; }
command -v jq  >/dev/null 2>&1 || { echo "ERROR: jq not installed" >&2; exit 1; }
command -v bc  >/dev/null 2>&1 || { echo "ERROR: bc not installed" >&2; exit 1; }

NETWORK="${PPN_NETWORK:-polkadot}"
[ "$NETWORK" = polkadot ] || { echo "ERROR: $NETWORK is not polkadot" >&2; exit 1; }
DESCRIPTOR="$PPN_WS/networks/$NETWORK.json"
[ -f "$DESCRIPTOR" ] || { echo "ERROR: no descriptor at $DESCRIPTOR" >&2; exit 1; }

PARACHAIN_ID_ASSET_HUB="$(jq -r '.parachains[]|select(.key=="asset-hub").paraId' "$DESCRIPTOR")"

SEED_ASSET_ID="$(jq -r '.seedAsset.id' "$DESCRIPTOR")"
SEED_ASSET_DECIMALS="$(jq -r '.seedAsset.decimals' "$DESCRIPTOR")"
SEED_ASSET_MIN_BALANCE="$(jq -r '.seedAsset.minBalance' "$DESCRIPTOR")"
SEED_ASSET_OWNER="$(jq -r '.seedAsset.owner' "$DESCRIPTOR")"

NATIVE_TOKEN='{"parents":1,"interior":{"type":"Here"}}'
NATIVE_DECIMALS=10

# A fork has no Sudo. Alice is endowed on every chain.
SIGNER=alice

RPC_PEOPLE="ws://127.0.0.1:${PEOPLE_PORT}"
dot chain add people --rpc "$RPC_PEOPLE" >/dev/null 2>&1 || true

# Integer >= comparison that handles arbitrary-precision positive integers.
# Needed because bash's [ -ge ] silently breaks past int64 (~9.2e18), and on-chain
# balances routinely exceed that (e.g. a 21M supply of a 18-decimal asset is ~2.1e25).
int_ge() {
  [ "$(echo "$1 >= $2" | bc)" = "1" ]
}

# Echoes an asset's foreign location on People.
people_foreign_location() {
  local asset_id="$1"
  echo '{"parents":1,"interior":{"type":"X3","value":[{"type":"Parachain","value":'"$PARACHAIN_ID_ASSET_HUB"'},{"type":"PalletInstance","value":50},{"type":"GeneralIndex","value":"'"$asset_id"'"}]}}'
}

# Echoes an account's balance of an asset on a chain, or 0 if it holds none.
assets_account_balance() {
  local chain="$1" asset="$2" account="$3" result
  result=$(dot "$chain.query.Assets.Account" "$asset" "$account")
  [ "$result" = "undefined" ] && echo 0 || echo "$result" | jq -r '.balance // 0'
}
