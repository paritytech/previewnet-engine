#!/usr/bin/env bash
# Postgres cluster backing the device-uniqueness-backend services.
#
# One cluster with a database per service. Upstream's compose file runs a
# separate cluster per service so each can deploy independently; that buys
# nothing here and costs three extra processes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/../.."
source "$SCRIPT_DIR/../lib/workspace.sh"
BIN_DIR="$PPN_WS_BIN"
PG_DIST="$BIN_DIR/postgres-dist"

source "$PROJECT_DIR/config/ports.env"
[[ -f "$PPN_WS/config/ports.local.env" ]] && source "$PPN_WS/config/ports.local.env"

# DATA_DIR does not survive zombie-cli into a custom_process, so fall back to
# the project-local default the same way storage-provider-node.sh does.
#
# Deliberately NOT $DATA_DIR/dub-postgres: zombienet creates a directory
# named after each custom_process for its log and writes dub-postgres.log
# there before this script runs, and initdb refuses a non-empty directory.
PGDATA="${DUB_POSTGRES_DATA_DIR:-${DATA_DIR:-$PPN_WS/data}/identity-pgdata}"

# Databases to create on first init. `identity` is shared by device-attestation-api, its chain
# writer and registration-queue; username-indexer owns its own.
# One database per service that owns state. v0.2.0 split a bare DATABASE_URL, which eight
# call sites had been reading while naming four different Postgres instances, into namespaced
# keys — so each exists here even when only device-attestation and the indexer are busy.
#
# `identity` keeps its physical name: the config key that carries it became
# DEVICE_ATTESTATION_DATABASE_URL in v0.3.0, but nothing upstream reads the database's name, and
# renaming it would strand every cluster already initialised under the old one. `dim_tickets` is
# gone with the service that owned it — an existing cluster keeps the database, unread.
# Supplied by the generated TOML (see dubDatabases in packages/network-config/src/dub.ts),
# because which databases exist depends on the dub build: the polkadot one has no
# invite-tickets service and so never owns `invite_tickets`. No default: one that is right
# for a testnet cluster is silently wrong for a polkadot one, and the cost lands later.
if [[ -z "${DUB_DATABASES:-}" ]]; then
    echo "Error: DUB_DATABASES is not set." >&2
    echo "       The generated TOML supplies it; which databases exist depends on the dub" >&2
    echo "       build, so there is no default that is right for both. Run through a" >&2
    echo "       generated network, or set it: DUB_DATABASES=\"identity username_indexer\"" >&2
    exit 1
fi
read -r -a DATABASES <<< "$DUB_DATABASES"

PG_USER=identity

if [[ ! -x "$PG_DIST/bin/postgres" ]]; then
    echo "Error: postgres not found at $PG_DIST/bin/postgres" >&2
    echo "  Run 'make fetch' to download it (see docs/DEVICE-UNIQUENESS-BACKEND.md)." >&2
    exit 1
fi

"$SCRIPT_DIR/../kill-port.sh" "$DUB_POSTGRES_PORT"

# initdb once; on restart the existing cluster is reused.
if [[ ! -f "$PGDATA/PG_VERSION" ]]; then
    echo "Initialising Postgres cluster at $PGDATA"
    mkdir -p "$PGDATA"
    # --auth=trust: the cluster listens on loopback only (see -c below) and
    # holds nothing but local dev state, so there is no password to manage.
    "$PG_DIST/bin/initdb" -D "$PGDATA" -U "$PG_USER" --auth=trust --encoding=UTF8 >/dev/null
    INITIALISED=1
else
    echo "Reusing Postgres cluster at $PGDATA"
    INITIALISED=0
fi

# Unix sockets are disabled outright. The socket path has a hard 103-byte limit
# and PGDATA is user-controlled via DATA_DIR, so a deep path makes postgres fail
# to start with "could not create any Unix-domain sockets". Every client here
# connects over TCP anyway.
#
# dynamic_shared_memory_type=mmap keeps the dynamic shared memory in
# $PGDATA/pg_dynshmem instead of /dev/shm. systemd-logind runs with RemoveIPC=yes, which
# deletes the POSIX shared memory of a normal uid when that user's last login session
# ends. Postgres runs as ubuntu here, so an ssh logout removes the segment under a live
# cluster, and every backend started after that dies with "could not open shared memory
# segment". The postmaster survives, because shared_memory_type defaults to mmap and is
# not an IPC object, so the port keeps listening and only queries fail. Files in the data
# directory are not IPC, so logind never touches them. Upstream never meets this: its
# compose file runs Postgres in a container, which has its own /dev/shm and no login
# session. This ran unnoticed on previewnet from 2026-08-31 and on the Polkadot fork from
# 2026-09-11.
PG_OPTS=(
    -D "$PGDATA"
    -p "$DUB_POSTGRES_PORT"
    -c listen_addresses=127.0.0.1
    -c unix_socket_directories=
    -c dynamic_shared_memory_type=mmap
)

PG_PID=""
cleanup() {
    if [[ -n "$PG_PID" ]]; then
        # Fast shutdown: roll back live transactions rather than waiting for
        # clients, which never disconnect on their own here.
        kill -INT "$PG_PID" 2>/dev/null || true
        wait "$PG_PID" 2>/dev/null || true
    fi
    exit 0
}
trap cleanup INT TERM EXIT

"$PG_DIST/bin/postgres" "${PG_OPTS[@]}" &
PG_PID=$!

echo "Waiting for Postgres on 127.0.0.1:$DUB_POSTGRES_PORT..."
for _ in $(seq 1 60); do
    if "$PG_DIST/bin/pg_isready" -h 127.0.0.1 -p "$DUB_POSTGRES_PORT" -U "$PG_USER" -d postgres >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

if ! "$PG_DIST/bin/pg_isready" -h 127.0.0.1 -p "$DUB_POSTGRES_PORT" -U "$PG_USER" -d postgres >/dev/null 2>&1; then
    echo "Error: Postgres did not become ready within 60s" >&2
    exit 1
fi

# Create databases on every boot, not just after initdb: a cluster left over
# from an older revision may predate a database added since.
for db in "${DATABASES[@]}"; do
    if "$PG_DIST/bin/psql" -h 127.0.0.1 -p "$DUB_POSTGRES_PORT" -U "$PG_USER" \
        -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1; then
        echo "  = $db"
    else
        "$PG_DIST/bin/createdb" -h 127.0.0.1 -p "$DUB_POSTGRES_PORT" -U "$PG_USER" "$db"
        echo "  + $db"
    fi
done

[[ "$INITIALISED" == "1" ]] && echo "Postgres ready (fresh cluster)" || echo "Postgres ready"

# Migrations are applied by the services themselves on boot, under a Postgres
# advisory lock, so nothing else is needed here.
wait "$PG_PID"
