#!/usr/bin/env bash
# Wrapper around polkadot-omni-node that forces the libp2p network backend on the
# collator's *relay-chain* side.
#
# Why this exists: a collator runs a relay-chain node in the same process, configured by
# the args after the `--` separator. zombienet owns those args and passes no
# `--network-backend`, so the relay side takes the default — litep2p — whose websocket
# listener dies a few seconds after startup with:
#
#   litep2p::websocket: [Relaychain] Websocket listener terminated error=Kind(InvalidInput)
#   sc_service::task_manager: [Relaychain] Essential task `network-worker` failed.
#
# `network-worker` is essential, so the whole collator exits, usually right after it has
# authored its first block. Verified on macOS arm64 with 1.24.0-2f2eeb2b81d: with the
# default backend three or four collators die on every start; with libp2p, none do.
#
# This is consistent rather than exceptional — PPN already passes --network-backend=libp2p
# to every relay validator (see CHAIN_ARGS.relay in @ppn/network-config). The
# relay side of a collator is the one relay node that was still getting the default.
#
# The flag is appended, which puts it in the relay-chain arg list, and only on a real node
# run: zombienet also invokes this binary for spec and key generation, where it would be
# rejected as an unexpected argument.
#
# Which binary is exec'd, and from where, comes from the environment (set per collator
# in the generated fork TOML — zombienet forwards node-level env):
#   PPN_BIN_DIR          bin directory; non-previewnet networks keep theirs in bin/<network>
#   PPN_COLLATOR_BINARY  e.g. polkadot-parachain (networks/<name>.json parachain `command`)
# The libp2p fix applies to any cumulus collator, whichever binary it is.
set -euo pipefail

# Where the binaries are is a property of the *workspace*, never of this script's location.
# `ppn fetch` writes them to the workspace's bin/ ($PPN_HOME, or the checkout); installed from
# npm this script lives in node_modules/@parity/ppn/scripts, whose ../bin does not exist at all
# — under `set -e` the old `cd .../../bin` ended the script before the fallback below could run.
# So: the explicit env first, then the workspace, and only then this script's own tree, which is
# the right answer in a checkout and a harmless miss anywhere else.
source "$(dirname "${BASH_SOURCE[0]}")/lib/workspace.sh"
REPO_BIN="$PPN_WS_BIN"
# `ppn start` exports BIN as the directory this run resolved to — bin/ for previewnet,
# bin/<network> for everything else — and the probe below inherits it even though it gets
# none of the node-level env.
BIN_DIR="${PPN_BIN_DIR:-${BIN:-$REPO_BIN}}"
BINARY="${PPN_COLLATOR_BINARY:-polkadot-omni-node}"
BIN="$BIN_DIR/$BINARY"

# Fall back to bin/<network>/ when the resolved path has nothing in it.
#
# Before spawning anything, zombienet probes each node command to learn which arguments it
# accepts — and that probe runs *without* the node-level env, so PPN_BIN_DIR is unset and the
# lookup above lands on plain bin/. previewnet keeps its binaries there, so it works; every other
# network keeps them in bin/<network>/, and the probe fails with a bare
#
#   NodeAvailableArgsError("", ".../scripts/omni-node.sh")
#
# which says nothing about a missing binary. It only shows up on a machine that has fetched one
# network and not previewnet — a fresh CI runner — so a developer whose bin/ still holds a
# previewnet fetch will never see it.
#
# The probe cannot know the *name* either: Kusama's collator is polkadot-parachain and it
# still probes as the default, which is how a completed bite died at spawn with the error
# above naming bin/polkadot-omni-node. A network's directory holds one collator, so
# whichever of the two is in there is the one this network runs.
if [[ ! -x "$BIN" ]]; then
    dirs=("$BIN_DIR")
    if [[ -n "$REPO_BIN" ]]; then
        [[ -n "${PPN_NETWORK:-}" ]] && dirs+=("$REPO_BIN/$PPN_NETWORK")
        dirs+=("$REPO_BIN" "$REPO_BIN"/*/)
    fi
    for dir in "${dirs[@]}"; do
        for name in "$BINARY" polkadot-omni-node polkadot-parachain; do
            if [[ -x "${dir%/}/$name" ]]; then
                BIN="${dir%/}/$name"
                break 2
            fi
        done
    done
fi

# On a chain whose Aura is ed25519 (Polkadot's Asset Hub), zombienet's keystore has no key the
# collator can author with: it writes `aura` as sr25519 and files the ed25519 key under `gran`.
# Same seed, so inserting it under `aura` is all that is missing — without it the collator syncs,
# reports no error, and never proposes a block.
#
# Only on a real node run: the arg probe passes neither, and `key insert` on a half-set-up node
# would fail the probe rather than the spawn.
if [[ "${PPN_COLLATOR_AURA:-}" == "ed25519" ]]; then
  base=""; chain=""
  prev=""
  for arg in "$@"; do
    case "$prev" in
      --base-path|-d) base="$arg" ;;
      --chain) chain="$arg" ;;
    esac
    prev="$arg"
  done
  if [[ -n "$base" && -n "$chain" ]]; then
    name="$(basename "$base")"
    [[ "$name" == "data" ]] && name="$(basename "$(dirname "$base")")"
    "$BIN" key insert --key-type aura --scheme ed25519 \
      --suri "//$name" --chain "$chain" --base-path "$base" \
      || echo "omni-node.sh: could not insert the ed25519 aura key for $name" >&2
  fi
fi

for arg in "$@"; do
  if [[ "$arg" == "--" ]]; then
    exec "$BIN" "$@" --network-backend=libp2p --discover-local --allow-private-ip
  fi
done

exec "$BIN" "$@"
