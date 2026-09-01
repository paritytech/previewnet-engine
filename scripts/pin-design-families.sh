#!/usr/bin/env bash
# Pins Proof of Ink design families to the local IPFS node.
#
# CID encoding (matches proof-of-ink fixtures.ts):
#   .json  → blake2b-256 + json codec (0x0200)
#   .js    → blake2b-256 + raw codec (0x0055)
#   dirs   → UnixFS (dag-pb + sha2-256)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."
source "$SCRIPT_DIR/lib/workspace.sh"
BIN_DIR="$PPN_WS_BIN"

source "$PROJECT_DIR/config/ports.env"

export IPFS_PATH="${IPFS_PATH:-$BIN_DIR/.ipfs}"
export PATH="$BIN_DIR:$PATH"

DESIGN_FAMILIES_DIR="${DESIGN_FAMILIES_DIR:-$PPN_WS/design-families}"

# Max block size for standard bitswap (1MB)
MAX_BLOCK_SIZE=1048576

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# --- Sanity checks ---

if ! command -v ipfs &>/dev/null; then
    echo -e "${RED}Error: ipfs not found in PATH${NC}"
    exit 1
fi

MAX_RETRIES=30
RETRY_INTERVAL=10
# Probe the daemon's API socket, not `ipfs id`. `ipfs id` also succeeds in offline mode,
# opening the repo directly, so it returns true before the daemon exists. Every pin below
# then runs offline, takes bin/.ipfs/repo.lock, and collides the moment ipfs-daemon starts:
#   Error: lock .../repo.lock: someone else has the lock
# which shows up as a run that pins a handful of files and fails all the rest.
# --api on every call below, so none of them can silently fall back to offline mode.
IPFS_API="/ip4/127.0.0.1/tcp/${IPFS_API_PORT}"
echo "Waiting for IPFS daemon to be ready..."
for i in $(seq 1 "$MAX_RETRIES"); do
    if curl -sS --fail --max-time 5 -X POST "http://127.0.0.1:${IPFS_API_PORT}/api/v0/id" &>/dev/null; then
        break
    fi
    if [ "$i" -eq "$MAX_RETRIES" ]; then
        echo -e "${RED}Error: IPFS daemon not ready after $((MAX_RETRIES * RETRY_INTERVAL))s${NC}"
        exit 1
    fi
    echo "  Attempt $i/$MAX_RETRIES — retrying in ${RETRY_INTERVAL}s..."
    sleep "$RETRY_INTERVAL"
done

if [ ! -d "$DESIGN_FAMILIES_DIR" ]; then
    echo -e "${RED}Error: Design families directory not found: $DESIGN_FAMILIES_DIR${NC}"
    exit 1
fi

echo -e "${GREEN}IPFS daemon is running${NC}"
echo "Pinning design families from $DESIGN_FAMILIES_DIR"
echo ""

# Cross-platform file size
get_file_size() {
    if stat --version &>/dev/null 2>&1; then
        stat -c%s "$1" 2>/dev/null
    else
        stat -f%z "$1" 2>/dev/null
    fi
}

format_size() {
    local size=$1
    if [ "$size" -ge 1048576 ]; then echo "$((size / 1048576))MB"
    elif [ "$size" -ge 1024 ]; then echo "$((size / 1024))KB"
    else echo "${size}B"
    fi
}

PASSED=0
FAILED=0
SKIPPED=0

# --- Pin individual files (blake2b-256) ---

for file in "$DESIGN_FAMILIES_DIR"/*; do
    [ -f "$file" ] || continue

    filename=$(basename "$file")
    filesize=$(get_file_size "$file")

    if [[ "$filename" == *.json ]]; then
        codec_flag="--cid-codec=json"
    elif [[ "$filename" == *.js ]]; then
        codec_flag="--cid-codec=raw"
    else
        continue
    fi

    if [ -n "$filesize" ] && [ "$filesize" -gt "$MAX_BLOCK_SIZE" ]; then
        echo -e "  ${YELLOW}⊘${NC} $filename ($(format_size "$filesize") > 1MB limit)"
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    if cid=$(ipfs --api "$IPFS_API" block put --pin --mhtype=blake2b-256 $codec_flag "$file" 2>&1); then
        echo -e "  ${GREEN}✓${NC} $filename → $cid"
        PASSED=$((PASSED + 1))
    else
        echo -e "  ${RED}✗${NC} $filename — $cid"
        FAILED=$((FAILED + 1))
    fi
done

# --- Pin directories (UnixFS dag-pb + sha2-256) ---

for dir in "$DESIGN_FAMILIES_DIR"/*; do
    [ -d "$dir" ] || continue
    dirname=$(basename "$dir")
    [[ "$dirname" == .* ]] && continue

    if cid=$(ipfs --api "$IPFS_API" add -r -Q --pin "$dir" 2>&1); then
        echo -e "  ${GREEN}✓${NC} $dirname/ → $cid"
        PASSED=$((PASSED + 1))
    else
        echo -e "  ${RED}✗${NC} $dirname/ — $cid"
        FAILED=$((FAILED + 1))
    fi
done

# --- Summary ---

echo ""
echo "Done: $PASSED pinned, $FAILED failed, $SKIPPED skipped"

if [ "$FAILED" -gt 0 ]; then
    exit 1
fi
