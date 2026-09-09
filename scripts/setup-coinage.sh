#!/usr/bin/env bash
# Creates the native/asset liquidity pool on People and adds liquidity.
# Coinage converts its fees through this pool, so it cannot charge a fee in the asset without it.
# Also creates the sponsored Coinage instance wrapping the asset on People.
#
# Adapted from individuality-community's 03g-setup-xtrnl-pool-people.sh and 03f-setup-coinage.sh.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib/setup-common.sh"

coinage_asset_unit=10000
coinage_pot_funding=$(( 1000 * 10**NATIVE_DECIMALS ))

asset_foreign=$(people_foreign_location "$SEED_ASSET_ID")
native_max=$(( 1000 * 10**NATIVE_DECIMALS ))
native_min=$(( 500 * 10**NATIVE_DECIMALS ))
asset_max=$(( 4000 * 10**SEED_ASSET_DECIMALS ))
asset_min=$(( 2000 * 10**SEED_ASSET_DECIMALS ))
asset_fund=$(( asset_max + SEED_ASSET_MIN_BALANCE ))

echo "-> Create native/asset liquidity pool on People"
asset_pool=$(dot people.query.AssetConversion.Pools "[$NATIVE_TOKEN, $asset_foreign]")
if [ "$asset_pool" == "undefined" ]; then
  echo "Pool is not set, creating pool"
  dot people.tx.AssetConversion.create_pool "$NATIVE_TOKEN" "$asset_foreign" --from "$SIGNER"
  asset_pool=$(dot people.query.AssetConversion.Pools "[$NATIVE_TOKEN, $asset_foreign]")
else
  echo "Pool is LPToken: $asset_pool"
fi

echo "-> Check pool liquidity on People"
# People exposes no AssetConversionApi, so the LP token supply stands in for the reserves.
lp_asset=$(dot people.query.PoolAssets.Asset "$asset_pool" --output json)
if [ "$lp_asset" == "undefined" ]; then
  lp_supply="0"
else
  lp_supply=$(echo "$lp_asset" | jq -r ".supply // 0")
fi
if [ "$lp_supply" != "0" ]; then
  echo "Pool already has liquidity: LP supply $lp_supply"
else
  # The supply lives on AssetHub and no script bridges it, so mint the People side. Providing
  # the liquidity spends it, so this has to be driven by the pool rather than by the balance.
  owner_balance=$(assets_account_balance people "$asset_foreign" "$SEED_ASSET_OWNER")
  if ! int_ge "$owner_balance" "$asset_fund"; then
    shortfall=$(echo "$asset_fund - $owner_balance" | bc)
    echo "Minting $shortfall units to asset owner $SEED_ASSET_OWNER"
    dot people.tx.Assets.mint "$asset_foreign" "$SEED_ASSET_OWNER" "$shortfall" --from "$SIGNER"
  fi
  echo "Pool has no liquidity, adding liquidity (1:4 ratio)"
  dot people.tx.AssetConversion.add_liquidity "$NATIVE_TOKEN" "$asset_foreign" "$native_max" "$asset_max" "$native_min" "$asset_min" "$SEED_ASSET_OWNER" --from "$SIGNER"
fi

echo "-> Create Coinage instance on People"
# An instance is never exclusive over its asset, so look for one that already wraps it at the
# unit this setup wants.
coinage_instance=""
instance_ids=$(dot people.query.Coinage.AssetToInstance "$asset_foreign" | jq -r ".[].keys[1]")
for id in $instance_ids; do
  instance=$(dot people.query.Coinage.Instances "$id" --output json)
  asset_unit=$(echo "$instance" | jq -r ".asset_unit")
  if [ "$asset_unit" == "$coinage_asset_unit" ]; then
    coinage_instance="$id"
    break
  fi
done
if [ -n "$coinage_instance" ]; then
  echo "Asset is already wrapped at asset unit $coinage_asset_unit by instance $coinage_instance"
else
  # create_sponsored_instance takes the asset's minimum balance from the caller, so mint it first.
  creator_balance=$(assets_account_balance people "$asset_foreign" "$SEED_ASSET_OWNER")
  if ! int_ge "$creator_balance" "$SEED_ASSET_MIN_BALANCE"; then
    echo "Minting $SEED_ASSET_MIN_BALANCE units to creator $SEED_ASSET_OWNER"
    dot people.tx.Assets.mint "$asset_foreign" "$SEED_ASSET_OWNER" "$SEED_ASSET_MIN_BALANCE" --from "$SIGNER"
  fi
  echo "No instance wraps the asset at asset unit $coinage_asset_unit, creating a sponsored one"
  funding="[$NATIVE_TOKEN, $coinage_pot_funding]"
  dot people.tx.Coinage.create_sponsored_instance "$asset_foreign" "$coinage_asset_unit" "$funding" --from "$SIGNER"
fi
