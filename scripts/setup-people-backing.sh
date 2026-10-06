#!/usr/bin/env bash
# Backs People's supply of the seeded asset on Asset Hub.
#
# On a real network the asset reaches People only by reserve transfer, which leaves the reserve in
# People's sovereign account on Asset Hub. The fork's setup mints People's side directly, so that
# account holds nothing, and a reserve withdraw to Asset Hub fails with FailedToTransactAsset.
# This mints the difference to that account. Run it after any mint of the asset on People.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib/setup-common.sh"

asset_foreign=$(people_foreign_location "$SEED_ASSET_ID")
people_sovereign=$(sibling_sovereign_account "$PARACHAIN_ID_PEOPLE")

echo "-> Back People's supply on Asset Hub"
people_asset=$(dot people.query.Assets.Asset "$asset_foreign")
people_supply=0
[ "$people_asset" = "undefined" ] || people_supply=$(echo "$people_asset" | jq -r '.supply // 0')
backing=$(assets_account_balance asset-hub "$SEED_ASSET_ID" "$people_sovereign")
if int_ge "$backing" "$people_supply"; then
  echo "People's supply $people_supply is backed by $backing on Asset Hub"
else
  shortfall=$(echo "$people_supply - $backing" | bc)
  echo "Minting $shortfall units to People's sovereign account $people_sovereign on Asset Hub"
  dot asset-hub.tx.Assets.mint "$SEED_ASSET_ID" "$people_sovereign" "$shortfall" --from "$SIGNER"
fi
