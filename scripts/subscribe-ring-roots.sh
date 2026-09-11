#!/usr/bin/env bash
# Subscribes AssetHub to ring root updates from People
# for the people and people-lite collections.
#
# Adapted from individuality-community's 10-subscribe-ah-ring-root-updates.sh.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib/setup-common.sh"

echo "-> Subscribe AssetHub to ring root updates from People for the people and people-lite collections"
subscriber=$(dot people.query.MembersNotifier.Subscribers "$PARACHAIN_ID_ASSET_HUB")
if [ "$subscriber" != "undefined" ]; then
  echo "AssetHub($PARACHAIN_ID_ASSET_HUB) already subscribed, skipping"
else
  whitelist=$(dot people.query.MembersNotifier.SubscriptionWhitelist "$PARACHAIN_ID_ASSET_HUB")
  if [ "$whitelist" = "undefined" ]; then
    echo "ERROR: AssetHub($PARACHAIN_ID_ASSET_HUB) is not in the subscription whitelist." >&2
    exit 1
  fi
  echo "AssetHub($PARACHAIN_ID_ASSET_HUB) not subscribed, subscribing"
  dot people.tx.MembersNotifier.subscribe_whitelisted "$PARACHAIN_ID_ASSET_HUB" --unsigned
fi
