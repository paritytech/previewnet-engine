#!/usr/bin/env bash
# Creates the native/asset liquidity pool on Asset Hub and adds liquidity.
#
# Not the same job as the People pool setup-coinage.sh creates. That one is what Coinage
# converts its fees through, so a fee in the asset is unpayable without it. This one is depth
# on the reserve chain, for anything swapping there.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib/setup-common.sh"

# 2500000 of each side, so the pool opens at 1:1. That is not the market rate, and nothing on
# the fork reads a rate from this pool, unlike the People one.
native_max=$(( 2500000 * 10**NATIVE_DECIMALS ))
native_min=$(( 1250000 * 10**NATIVE_DECIMALS ))
asset_max=$(( 2500000 * 10**SEED_ASSET_DECIMALS ))
asset_min=$(( 1250000 * 10**SEED_ASSET_DECIMALS ))
asset_fund=$(( asset_max + SEED_ASSET_MIN_BALANCE ))

# Asset Hub is the reserve chain, so the Assets pallet keys the asset by id. AssetConversion
# names it by location, and stores each pool under the pair with DOT first. The queries below
# are raw storage lookups rather than calls into pool_id, so naming the pair the other way
# round hashes a different key and finds nothing, while create_pool still succeeds.
asset_local=$(asset_hub_local_location "$SEED_ASSET_ID")

echo "-> Create native/asset liquidity pool on Asset Hub"
asset_pool=$(dot asset-hub.query.AssetConversion.Pools "[$NATIVE_TOKEN, $asset_local]")
if [ "$asset_pool" == "undefined" ]; then
  echo "Pool is not set, creating pool"
  dot asset-hub.tx.AssetConversion.create_pool "$NATIVE_TOKEN" "$asset_local" --from "$SIGNER"
  asset_pool=$(dot asset-hub.query.AssetConversion.Pools "[$NATIVE_TOKEN, $asset_local]")
else
  echo "Pool is LPToken: $asset_pool"
fi

echo "-> Check pool liquidity on Asset Hub"
# The LP token supply stands in for the reserves, as it does on People.
lp_asset=$(dot asset-hub.query.PoolAssets.Asset "$asset_pool" --output json)
if [ "$lp_asset" == "undefined" ]; then
  lp_supply="0"
else
  lp_supply=$(echo "$lp_asset" | jq -r ".supply // 0")
fi
if [ "$lp_supply" != "0" ]; then
  echo "Pool already has liquidity: LP supply $lp_supply"
else
  # The bite seeds the asset with a zero supply, so the whole asset side is minted here.
  # Providing the liquidity spends it, so this is driven by the pool rather than the balance.
  owner_balance=$(assets_account_balance asset-hub "$SEED_ASSET_ID" "$SEED_ASSET_OWNER")
  if ! int_ge "$owner_balance" "$asset_fund"; then
    shortfall=$(echo "$asset_fund - $owner_balance" | bc)
    echo "Minting $shortfall units to asset owner $SEED_ASSET_OWNER"
    dot asset-hub.tx.Assets.mint "$SEED_ASSET_ID" "$SEED_ASSET_OWNER" "$shortfall" --from "$SIGNER"
  fi
  echo "Pool has no liquidity, adding liquidity (1:1 ratio)"
  dot asset-hub.tx.AssetConversion.add_liquidity "$NATIVE_TOKEN" "$asset_local" "$native_max" "$asset_max" "$native_min" "$asset_min" "$SEED_ASSET_OWNER" --from "$SIGNER"
fi
