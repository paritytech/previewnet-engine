#!/usr/bin/env bash
# What the systemd unit runs. Through `ppn start` rather than zombie-cli directly, so the
# bundle check, the resume-or-wipe decision and the spawn stamp all apply on a restart.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
source "$HERE/vm.env"
cd "$ROOT"
export PPN_NETWORK="$NETWORK" P2P_LISTEN_IP="$PUBLIC_IP" DASHBOARD_PROXY=0 RUST_LOG=info
# shellcheck disable=SC2086
exec node bin/ppn.mjs start "$NETWORK" --fork $START_FLAGS
