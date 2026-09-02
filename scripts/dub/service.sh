#!/usr/bin/env bash
# Runs one device-uniqueness-backend service.
#
#   service.sh --role=<role> --wait-for=<host:port>
#
# Flag form rather than positionals because zombienet validates custom_process
# args as CLI arguments and rejects anything that is not a flag or --key=value.
#
# Config does not live here: the non-secret environment is emitted into the
# generated zombienet TOML by packages/network-config/src/dub.ts, so what a service runs
# with is visible in the config rather than in a shell default. This script only
# does the three things a declaration cannot.
set -uo pipefail

# Both spellings are accepted because zombienet does not pass args through
# verbatim: `--role=all-in-one` in the TOML arrives as `--role all-in-one`,
# two separate argv entries.
ROLE=""
# device-uniqueness-backend v0.2.0 ships one binary; the service is chosen with --role.
# Named `ibv2` until v0.3.0 renamed it, along with the release assets `ppn fetch` reads.
BINARY="dub"
WAIT_TARGET=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --role=*)     ROLE="${1#*=}"; shift ;;
        --role)       ROLE="${2:-}"; shift 2 ;;
        --wait-for=*) WAIT_TARGET="${1#*=}"; shift ;;
        --wait-for)   WAIT_TARGET="${2:-}"; shift 2 ;;
        *) echo "service.sh: unknown argument '$1'" >&2; exit 1 ;;
    esac
done

if [[ -z "$ROLE" || -z "$WAIT_TARGET" ]]; then
    echo "usage: service.sh --role=<role> --wait-for=<host:port>" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
# Binaries live in the workspace, not beside this script — see scripts/lib/workspace.sh.
source "$SCRIPT_DIR/../lib/workspace.sh"
BIN_DIR="$PPN_WS_BIN"

if [[ ! -x "$BIN_DIR/$BINARY" ]]; then
    echo "Error: $BINARY not found at $BIN_DIR/$BINARY (run \`ppn fetch\`)" >&2
    echo "  Run 'make fetch' (see docs/DEVICE-UNIQUENESS-BACKEND.md)." >&2
    exit 1
fi

# 1. Secrets, from the file the operator named in PPN_SECRETS_FILE. Kept out of the
#    generated TOML on purpose: the deployable profile holds private keys at runtime only
#    (see docs/PROFILES.md). No default path — that would be a guess about someone's host,
#    and guessing wrong looks exactly like "no secrets", which is the dev keys.
if [[ -n "${PPN_SECRETS_FILE:-}" ]]; then
    if [[ ! -f "$PPN_SECRETS_FILE" ]]; then
        echo "[$ROLE] PPN_SECRETS_FILE points at $PPN_SECRETS_FILE, which does not exist." >&2
        exit 1
    fi
    set -a && source "$PPN_SECRETS_FILE" && set +a
fi

# The attester, under the deployable profile.
#
# increase-people-lite-attestation-allowance.sh grants the allowance to
# PPN_ALLOWANCE_SS58, so the writer has to attest as that same account — the
# generated TOML carries Alice, who holds no allowance on a deployed server.
# Overridden here rather than at generate time because a deployment may not
# regenerate the TOML; it deploys the committed one.
#
# Refuse to start when the key for that account is missing, rather than falling
# back to //Alice: the writer would sign, the API would keep returning 202, and
# every registration would sit in the outbox failing NoAttestationAllowance.
# Same reasoning as the allowance script's own hard-fail.
if [[ -n "${PPN_ALLOWANCE_SS58:-}" ]]; then
    if [[ -z "${PPN_DUB_ATTESTER_URI:-${PPN_IDENTITY_ATTESTER_URI:-}}" ]]; then
        echo "Error: PPN_ALLOWANCE_SS58 is set but no attester key is set." >&2
        echo "       The attestation allowance is granted to $PPN_ALLOWANCE_SS58, so the" >&2
        echo "       chain writer must hold that account's key. Add it to" >&2
        echo "       the file named by PPN_SECRETS_FILE — see docs/DEVICE-UNIQUENESS-BACKEND.md." >&2
        exit 1
    fi
    export ATTESTER_ACCOUNT="$PPN_ALLOWANCE_SS58"
fi

# Writer's signing key. Must resolve to ATTESTER_ACCOUNT above, or the writer
# derives a proxy target from the difference and People Chain needs a matching
# proxy registration.
# The attester key. PPN_DUB_ATTESTER_URI is the current name; PPN_IDENTITY_ATTESTER_URI is
# still read because it is already set as a GitHub Actions secret on deployed environments, and
# a rename here would break those deploys until someone re-entered a value only they hold.
export CHAIN_WRITER_SIGNER_SURI="${PPN_DUB_ATTESTER_URI:-${PPN_IDENTITY_ATTESTER_URI:-//Alice}}"
# The ticket services sign their own batches. v0.2.0 removed INVITER_PROXY_FOR: proxying is now
# derived from whether this key's account differs from INVITER_ADDRESS, so keeping them equal
# means direct signing and no proxy registration on chain — the same arrangement the chain
# writer already used.
#
# Bob, not Alice: two independent writers on one account share a nonce lane, and
# invite-tickets-pool submits every ~30s, which starves the chain writer until its
# registration fails terminally. It must stay in step with INVITER_ADDRESS in the generated
# TOML (see BOB_SS58 in packages/network-config/src/dub.ts) — a mismatch turns direct
# signing into a proxy call that People Chain has no registration for.
export INVITER_SIGNER_SURI="${PPN_INVITER_SURI:-//Bob}"

# turn-api signs short-lived TURN credentials. Base64, not hex — it rejects hex with "invalid
# base64 encoding". Local-only: nothing outside this machine can use a credential minted here.
export TURN_SECRET="${TURN_SECRET:-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=}"

# Where all-in-one serves /docs from. A ServeDir, so it needs a directory rather than the two
# loose files the old gateway mapped by hand; `ppn fetch` fills it from the backend's tree at
# the pinned tag. Set here and not in the TOML because it is a path on this machine.
export GATEWAY_DOCS_ROOT="${GATEWAY_DOCS_ROOT:-$BIN_DIR/identity-docs}"

# The JWT signing seed. The default below is a public constant, so anything holding it can
# mint tokens this backend accepts: fine on a laptop, fatal anywhere reachable. A deployment
# is any run that named a secrets file, and it has to state its own.
if [[ -n "${PPN_SECRETS_FILE:-}" && -z "${JWT_ED25519_SECRET:-}" ]]; then
    echo "[$ROLE] JWT_ED25519_SECRET is not set in $PPN_SECRETS_FILE." >&2
    echo "       The dev default is public; a deployment must supply its own seed." >&2
    exit 1
fi
export JWT_ED25519_SECRET="${JWT_ED25519_SECRET:-0x0101010101010101010101010101010101010101010101010101010101010101}"

# device-attestation mints JWTs with the secret above; the ticket APIs verify them, and v0.2.0 requires
# the verification key explicitly (JWT_JWKS_JSON or JWT_ED25519_PUBLIC_KEY). Derived from the
# secret rather than written out beside it: two hardcoded halves drift, and a mismatch would
# look like every ticket request being unauthorised for no visible reason.
if [[ -z "${JWT_ED25519_PUBLIC_KEY:-}" && -z "${JWT_JWKS_JSON:-}" ]]; then
    JWT_ED25519_PUBLIC_KEY=$(node -e '
      const crypto = require("crypto");
      const seed = Buffer.from(process.env.JWT_ED25519_SECRET.replace(/^0x/, ""), "hex");
      const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
      const pub = crypto
        .createPublicKey(crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }))
        .export({ format: "der", type: "spki" })
        .subarray(-32);
      process.stdout.write("0x" + pub.toString("hex"));
    ') || { echo "[$ROLE] could not derive JWT_ED25519_PUBLIC_KEY from JWT_ED25519_SECRET" >&2; exit 1; }
    export JWT_ED25519_PUBLIC_KEY
fi

# 2. Free our own port. A leftover process from a previous run holds it, and the
#    supervision loop below would otherwise respawn against "Address already in
#    use (os error 48)" forever. BIND_ADDR comes from the TOML env and is only
#    set for the services that listen, so this is a no-op for the workers.
if [[ -n "${BIND_ADDR:-}" ]]; then
    "$PROJECT_DIR/scripts/kill-port.sh" "${BIND_ADDR##*:}" >/dev/null 2>&1 || true
fi

# 3. Wait for Postgres. Every service connects and applies migrations before
#    anything else, and exits rather than retrying when it is unreachable
#    ("pool timed out while waiting for an open connection"). custom_processes
#    have no ordering, so waiting here is the only sequencing available.
#
#    No equivalent wait for the chain: the services block on the People Chain
#    connect indefinitely and pick it up whenever it appears. They do not bind
#    their HTTP port until that succeeds, so /livez and /readyz being
#    unreachable while the parachain starts is expected, not a fault.
WAIT_HOST="${WAIT_TARGET%:*}"
WAIT_PORT="${WAIT_TARGET##*:}"

echo "[$ROLE] waiting for $WAIT_TARGET..."
for _ in $(seq 1 120); do
    if "$BIN_DIR/postgres-dist/bin/pg_isready" -h "$WAIT_HOST" -p "$WAIT_PORT" \
        -U identity -d postgres >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

# The port is not the thing to wait for. postgres.sh has to open it *before* it can create
# the databases, and pg_isready above asks about `postgres`, which always exists — so a
# service that wins the race connects into the gap, dies with `database "identity" does not
# exist`, and then sits out a restart backoff. That cost five minutes on CI, long enough for
# the registration test to give up while the chain half had already succeeded.
for _ in $(seq 1 120); do
    missing=""
    for db in identity username_indexer invite_tickets; do
        "$BIN_DIR/postgres-dist/bin/psql" -h "$WAIT_HOST" -p "$WAIT_PORT" -U identity \
            -d "$db" -tAc 'select 1' >/dev/null 2>&1 || missing="$missing $db"
    done
    [[ -z "$missing" ]] && break
    sleep 1
done
[[ -n "$missing" ]] && echo "[$ROLE] warning: databases still missing:$missing" >&2
echo "[$ROLE] databases ready"

# 4. Supervise. zombienet has no restart policy for custom_processes — the
#    schema is name/command/image/args/env — so a service that dies stays dead
#    until the whole network restarts. Same reason ipfs-daemon.sh loops.
CHILD_PID=""
cleanup() {
    if [[ -n "$CHILD_PID" ]]; then
        kill "$CHILD_PID" 2>/dev/null
        wait "$CHILD_PID" 2>/dev/null
    fi
    exit 0
}
trap cleanup INT TERM EXIT

while true; do
    "$BIN_DIR/$BINARY" --role "$ROLE" &
    CHILD_PID=$!
    wait "$CHILD_PID"
    EXIT_CODE=$?
    CHILD_PID=""

    # Killed by signal (128+n) means the network is going down with us.
    if [[ $EXIT_CODE -gt 128 ]]; then
        exit 0
    fi

    echo "[$ROLE] exited (code $EXIT_CODE), restarting in 5s..."
    sleep 5
done
