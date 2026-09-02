# PPN - Product Preview Network
# Pre-built image with all binaries and chain specs ready to run
#
# Build context expects pre-built binaries in bin/ directory.
#
# Usage:
#   docker run -p 10000-10030:10000-10030 -p 8545:8545 paritytech/previewnet-engine
#
# Options (environment variables):
#   DATA_DIR=/data  - Chain data directory (default: ./data inside container)
#   EPHEMERAL=1     - No persistence (data in /tmp, lost on stop)
#   CLEAN=1         - Wipe data directory before starting
#   REGENERATE=1    - Regenerate chainspecs (for custom runtime overrides)
#
# Examples:
#   # Basic run
#   docker run -p 10000-10030:10000-10030 -p 8545:8545 paritytech/previewnet-engine
#
#   # Persistent with mounted volume
#   docker run -p 10000-10030:10000-10030 -e DATA_DIR=/data -v ./data:/data paritytech/previewnet-engine
#
#   # Ephemeral (no persistence)
#   docker run -p 10000-10030:10000-10030 -e EPHEMERAL=1 paritytech/previewnet-engine
#
#   # Clean restart
#   docker run -p 10000-10030:10000-10030 -e CLEAN=1 -v ./data:/data paritytech/previewnet-engine
#
# NOTE: Not supported on Apple Silicon Macs (M1/M2/M3/M4) — p2p networking
#       fails under x86_64 emulation. Use native mode (make start) instead.

FROM ubuntu:24.04

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    jq \
    make \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22 (required for startup helper scripts)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /ppn

# Copy everything (Makefile, scripts, configs)
COPY Makefile ./
COPY scripts/ ./scripts/
COPY zombienet-configs/ ./zombienet-configs/
COPY config/ ./config/
# The network descriptors: `make generate` below and every workflow that asks what a chain
# runs reads these (see networks/README.md).
COPY networks/ ./networks/

# The workspace. Manifests and the lockfile first, so the dependency layer is cached
# independently of the sources — editing a .ts file does not re-resolve the tree.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/network-config/package.json packages/network-config/tsconfig.json ./packages/network-config/
COPY packages/cli/package.json packages/cli/tsconfig.json ./packages/cli/
COPY packages/dashboard-ui/package.json packages/dashboard-ui/tsconfig.json ./packages/dashboard-ui/
RUN npm install -g pnpm@9 && pnpm install --frozen-lockfile

# Sources, then compile. This replaces an ad-hoc `npm install --no-save @polkadot/api`:
# every runtime dependency now comes from the committed lockfile, at the version the
# release was tested with.
COPY packages/ ./packages/
COPY bin/ppn.mjs ./bin/ppn.mjs
RUN pnpm build

# Copy pre-built binaries (provided by CI)
COPY bin/ ./bin/

# Make binaries and scripts executable
RUN chmod +x bin/* scripts/*.sh

# The `dot` CLI, used by the services that submit extrinsics.
RUN npm install -g polkadot-cli@1.1.1

# Generate chain specs from the pre-built runtimes
RUN make generate

# Expose ports. Keep in step with the `-p` list in the Makefile's docker target: published but
# not listed here is undocumented, listed but not published is unreachable.
# Relay chain validators
EXPOSE 10000 10001 10002 10003 10004 10005
# Parachains: people, asset-hub, bulletin, web3-storage
EXPOSE 10010 10020 10030 10040
# Eth RPC
EXPOSE 8545
# IPFS
EXPOSE 4001 5001 8080
# Dashboard, identity backend, storage provider
EXPOSE 8090 8092 3333

# Healthcheck - check if relay node responds
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -sf -X POST -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","method":"system_health","params":[],"id":1}' \
        http://localhost:10000 || exit 1

# Start network via entrypoint script (prints info, handles regenerate)
ENTRYPOINT ["/ppn/scripts/docker-entrypoint.sh"]
