#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$DIR/bin"
SCRIPTS="$DIR/scripts"
ZOMBIE_DIR="/tmp/zombie-test-$$"

# Cleanup on exit
#
# Through `ppn kill` rather than a pkill list of its own: the identity backend is five
# supervising wrappers around a binary that holds no port for four of its five roles, so a
# pkill for zombie-cli and polkadot left the whole identity stack running. It then survived
# into the next run and answered on 8092 with a database projecting the *previous* chain.
LOCAL_ENV="$DIR/config/ports.local.env"
cleanup() {
    node "$DIR/bin/ppn.mjs" kill >/dev/null 2>&1 || true
    # Put the developer's ports.local.env back, or remove the one this run created; see the
    # identity cluster note below.
    if [ -f "$LOCAL_ENV.pre-test" ]; then
        mv -f "$LOCAL_ENV.pre-test" "$LOCAL_ENV"
    else
        rm -f "$LOCAL_ENV"
    fi
    rm -f "$LOCAL_ENV.tmp"
    rm -rf "$ZOMBIE_DIR"
}
trap cleanup EXIT

# Which tests to run.
#
# Named tests come from the command line ("make test ARGS=08-dub.zndsl"), which
# the Makefile has always forwarded and this script used to ignore — so asking for one test
# quietly ran all eleven. No argument means the whole suite, in this order.
#
# Resolved here, before the network is spawned: a typo used to cost a four-minute spawn before
# saying so.
SELECTED=("$@")
if [ ${#SELECTED[@]} -gt 0 ]; then
    for test in "${SELECTED[@]}"; do
        [ -f "$DIR/tests/$test" ] || { echo "No such test: tests/$test" >&2; exit 1; }
    done
fi

# The zndsl runner is a separate binary from zombie-cli, and not one `ppn fetch` pulls: CI
# downloads it per run. Checked here rather than discovered later — it is used only after the
# spawn, so a missing one used to cost a four-minute network before "zombienet: command not
# found".
if ! command -v zombienet >/dev/null 2>&1; then
    # Kept in step with ZOMBIENET_VERSION in .github/workflows/zombienet-tests.yml.
    RUNNER_VERSION="v1.3.138"
    case "$(uname -s)/$(uname -m)" in
        Darwin/arm64) RUNNER_ASSET="zombienet-macos-arm64" ;;
        Linux/x86_64) RUNNER_ASSET="zombienet-linux-x64" ;;
        Linux/aarch64) RUNNER_ASSET="zombienet-linux-arm64" ;;
        *) RUNNER_ASSET="zombienet-<your-platform>" ;;
    esac
    {
        echo "The zndsl test runner (zombienet) is not on PATH."
        echo "  It is a separate binary from zombie-cli and \`ppn fetch\` does not pull it. To install:"
        echo "    curl -sSL https://github.com/paritytech/zombienet/releases/download/$RUNNER_VERSION/$RUNNER_ASSET \\"
        echo "      -o bin/zombienet && chmod +x bin/zombienet && export PATH=\"\$PWD/bin:\$PATH\""
    } >&2
    exit 1
fi

# The identity databases are a projection of chain state, so they have to be as fresh as the
# chain. This spawn is genesis every time, while the default cluster lives in the repo's data/
# and outlives it: the username indexer then starts with a watermark past the new chain's
# finalized head, reports `blocks_processed=0` for ever, and every registration is accepted
# and never projected. That failure is silent and looks exactly like a slow chain — it is the
# reason 09-identity-registration's budget was raised twice for no good reason.
#
# Reaching the process through ports.local.env because zombie-cli does not forward the
# environment into custom_processes; postgres.sh sources that file for the same reason.
[ -f "$LOCAL_ENV" ] && cp "$LOCAL_ENV" "$LOCAL_ENV.pre-test"
grep -v '^DUB_POSTGRES_DATA_DIR=' "$LOCAL_ENV" 2>/dev/null > "$LOCAL_ENV.tmp" || true
echo "DUB_POSTGRES_DATA_DIR=$ZOMBIE_DIR/identity-pgdata" >> "$LOCAL_ENV.tmp"
mv "$LOCAL_ENV.tmp" "$LOCAL_ENV"

# Generate TOML config (builds spawner TS if needed)
make -C "$DIR" generate-toml
TOML_FILE="$DIR/zombienet-configs/local-dev.toml"

# Start network
mkdir -p "$ZOMBIE_DIR"
BIN="$BIN" SCRIPTS="$SCRIPTS" "$BIN/zombie-cli" spawn -p native -d "$ZOMBIE_DIR" \
    "$TOML_FILE" &

# Wait for network
echo "Waiting for network to start..."
for i in {1..60}; do
    if [ -f "$ZOMBIE_DIR/zombie.json" ]; then
        echo "Network started"
        break
    fi
    sleep 10
done
sleep 30

# Run tests
TESTS=("${SELECTED[@]}")
[ ${#TESTS[@]} -gt 0 ] || TESTS=(
    "00-network-health.zndsl"
    "01-asset-hub-revive.zndsl"
    "02-bulletin-storage.zndsl"
    "03-people-chain.zndsl"
    "04-xcm-channels.zndsl"
    "05-dotns-contracts.zndsl"
    "06-evm-genesis-balances.zndsl"
    "07-web3-storage.zndsl"
    "08-dub.zndsl"
    "09-dub-registration.zndsl"
    "10-network-suffix.zndsl"
    "13-runtime-upgrade.zndsl"
)

for test in "${TESTS[@]}"; do
    if [ -f "$DIR/tests/$test" ]; then
        echo "Running: $test"
        "$SCRIPTS/../bin/ppn.mjs" zombie-compat "$ZOMBIE_DIR/zombie.json"
        BIN="$BIN" zombienet -p native test "$DIR/tests/$test" "$ZOMBIE_DIR/zombie.json"
    fi
done

echo "All tests passed!"
