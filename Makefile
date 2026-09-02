# =============================================================================
# Product Preview Network
# =============================================================================
#
# Quick start:
#   make start              # Start network (downloads dependencies if needed)
#
# Options (work with any command):
#   DOCKER=1                # Run in Docker instead of native
#   EPHEMERAL=1             # No persistence (data lost on stop)
#   CLEAN=1                 # Wipe chain data before starting
#   REGENERATE=1            # Regenerate chain specs before starting
#   DATA_DIR=<path>         # Custom data directory (default: ./data)
#   FORK=1                  # Start from the live network's state, not genesis
#   NETWORK=<name>          # Which network (networks/*.json, default: previewnet).
#                           # Only previewnet starts from genesis; the rest are
#                           # fork-only. See networks/README.md.
#   FRESH_BITE=1            # With FORK=1: bite the live network now instead of
#                           # downloading the latest published bundle
#   UPGRADES="<chain>=<wasm> ..."  # With a bite: runtimes to authorize at import, for a
#                           # network without sudo (kusama, polkadot). See docs/FORK.md.
#
# Examples:
#   make start                        # Native, persistent, from genesis
#   make start EPHEMERAL=1            # Native, no persistence
#   make start CLEAN=1                # Native, wipe data first
#   make start FORK=1                 # Fork of production previewnet (downloads a bundle)
#   make start FORK=1 NETWORK=devnet  # Fork of devnet
#   make start FORK=1 FRESH_BITE=1    # Fork, biting production right now
#   make start FORK=1 CLEAN=1         # Fork, back at the bite block (default resumes)
#   make bite                         # Just produce a bundle, do not start
#   make bite NETWORK=paseo-next-v2   # Bundle of another network
#   make bite NETWORK=polkadot UPGRADES="people=./people.wasm"  # Bite with a runtime authorized
#   DOCKER=1 make start               # Docker, persistent
#
# Forking continues from a real block rather than resetting to genesis, so
# contracts, registrations and balances are all present. A fork that is started again
# resumes where it stopped; CLEAN=1 puts it back at the bite block. See docs/FORK.md.
#
# =============================================================================

.PHONY: test-unit start fresh fetch fetch-doppelganger show-network generate generate-toml build build-spawner bite clean clean-bin clean-data clean-chainspecs clean-design-families clean-fork kill pin-design-families test doctor help

# Configuration
#
# Which network to run — one of networks/*.json (see networks/README.md). Only
# previewnet can start from genesis; every other network is fork-only (FORK=1).
# Non-previewnet networks keep their own binaries (bin/<network>/), fork bundle
# (fork-bundle-<network>/) and data directory (data-fork-<network>/). Every network is
# named, previewnet included.
NETWORK ?= previewnet
export PPN_NETWORK := $(NETWORK)
ifeq ($(wildcard $(CURDIR)/networks/$(NETWORK).json),)
$(error unknown network "$(NETWORK)" — expected one of: $(notdir $(basename $(wildcard $(CURDIR)/networks/*.json))))
endif

ifeq ($(NETWORK),previewnet)
BIN_DIR := $(CURDIR)/bin
else
BIN_DIR := $(CURDIR)/bin/$(NETWORK)
endif
# Genesis and fork never share a data directory.
#
# zombienet restores a fork bundle's snapshot only into an *empty* base path, and
# a forked database is warp-synced under --state-pruning=256 — it holds state at
# the bite block and nothing before it. Point a fork at a directory that already
# holds genesis data (or the reverse) and the run looks healthy for a hundred
# blocks, then panics with "Trie lookup error: Database missing expected key".
#
# Separating them also keeps the identity backend's Postgres cluster per-mode.
# The username indexer stores a finalized-block checkpoint; carrying one across a
# chain swap makes it silently index nothing, because its checkpoint sits ahead
# of the new chain's head.
#
# An explicit DATA_DIR= still wins, since this is a ?= default.
DATA_DIR ?= $(CURDIR)/data$(if $(filter 1,$(FORK)),-fork,)$(if $(filter previewnet,$(NETWORK)),,-$(NETWORK))
CONFIG_DIR := $(CURDIR)/zombienet-configs
SCRIPTS_DIR := $(CURDIR)/scripts

# Fork mode: spawn from the live network's state instead of genesis. The bundle and
# its zombienet config are generated (never checked in) — see docs/FORK.md.
FORK_DIR := $(CURDIR)/fork-bundle-$(NETWORK)
FORK_TOML := $(FORK_DIR)/fork.toml

# Runtimes a bite authorizes at import, for a network without sudo: UPGRADES="<chain>=<wasm> ..."
# becomes one `--upgrade` per entry on `ppn bite` (or `ppn start` when it bites).
UPGRADE_FLAGS := $(foreach u,$(UPGRADES),--upgrade $(u))

ifeq ($(FORK),1)
TOML_FILE := $(FORK_TOML)
else
TOML_FILE := $(CONFIG_DIR)/local-dev.toml
endif

# Docker settings
DOCKER_IMAGE ?= paritytech/previewnet-engine:latest
DOCKER_NAME ?= ppn

# Default target
all: start

# =============================================================================
# Main commands
# =============================================================================

ifeq ($(DOCKER),1)
# --- Docker mode ---

# Build Docker env flags from make variables
DOCKER_ENV := $(if $(CLEAN),-e CLEAN=$(CLEAN)) \
              $(if $(EPHEMERAL),-e EPHEMERAL=$(EPHEMERAL)) \
              $(if $(REGENERATE),-e REGENERATE=$(REGENERATE))

# Mount data volume unless ephemeral
DOCKER_VOLUMES := $(if $(filter 1,$(EPHEMERAL)),,-v $(DATA_DIR):/ppn/data -e DATA_DIR=/ppn/data)

start:
	@mkdir -p "$(DATA_DIR)" 2>/dev/null || true
	@docker pull --platform linux/amd64 $(DOCKER_IMAGE)
	@. $(CURDIR)/config/ports.env && \
	docker run --rm -it --init --platform linux/amd64 --name $(DOCKER_NAME) \
		-p $$RELAY_ALICE_PORT-$$BULLETIN_PORT:$$RELAY_ALICE_PORT-$$BULLETIN_PORT \
		-p $$WEB3_STORAGE_PORT:$$WEB3_STORAGE_PORT \
		-p $$ETH_RPC_PORT:$$ETH_RPC_PORT \
		-p $$DASHBOARD_PORT:$$DASHBOARD_PORT \
		-p $$DUB_PORT:$$DUB_PORT \
		-p $$WEB3_STORAGE_PROVIDER_PORT:$$WEB3_STORAGE_PROVIDER_PORT \
		-p $$IPFS_GATEWAY_PORT:$$IPFS_GATEWAY_PORT \
		-p $$IPFS_API_PORT:$$IPFS_API_PORT \
		-e DASHBOARD_HOST=0.0.0.0 \
		$(DOCKER_ENV) $(DOCKER_VOLUMES) \
		$(DOCKER_IMAGE)

kill:
	@docker stop $(DOCKER_NAME) 2>/dev/null || echo "Container not running"

else
# --- Native mode ---

# One implementation, in the CLI. This target stays as the memorable front door and maps the
# familiar variables onto its flags — see `node bin/ppn.mjs start --help`.
#
# `build-spawner` for the same reason every other target has it: bin/ppn.mjs refuses to run
# until packages/cli is compiled, so without it `make start` on a fresh clone — the first
# command the README gives — fails with "not built" and names a target the README never
# mentions.
start: build-spawner
	@node $(CURDIR)/bin/ppn.mjs start $(NETWORK) \
		--data-dir "$(DATA_DIR)" \
		--toml "$(TOML_FILE)" \
		$(if $(filter 1,$(FORK)),--fork,) \
		$(if $(filter 1,$(CLEAN)),--clean,) \
		$(if $(filter 1,$(EPHEMERAL)),--ephemeral,) \
		$(if $(filter 1,$(REGENERATE)),--regenerate,) \
		$(if $(filter 1,$(FRESH_BITE)),--fresh-bite,) \
		$(UPGRADE_FLAGS)

kill:
	@node $(CURDIR)/bin/ppn.mjs kill

endif

# =============================================================================
# Setup commands
# =============================================================================

# Ensure binaries, chain specs, design families, and required CLIs exist
ifeq ($(FORK),1)
# Fork mode uses the bundle's chain specs, so local spec generation is irrelevant.
ensure-deps: ensure-binaries ensure-dot-cli ensure-fork-bundle
else
ensure-deps: ensure-binaries ensure-chainspecs ensure-dot-cli
endif

# Fetch the doppelganger binaries. Only needed to CREATE a bundle — spawning one uses
# the regular polkadot / polkadot-omni-node.
fetch-doppelganger: build-spawner
	@node $(CURDIR)/bin/ppn.mjs fork fetch-doppelganger "$(BIN_DIR)"

# What each chain, service and tool runs, and from which release.
show-network: build-spawner
	@node $(CURDIR)/bin/ppn.mjs show $(NETWORK)

# Produce a fork bundle by biting the live network.
# build: fork.toml is generated by @ppn/network-config, which shares its
# ports and per-chain flags with the genesis config generator.
bite: build-spawner ensure-binaries
	@node $(CURDIR)/bin/ppn.mjs bite "$(FORK_DIR)" $(UPGRADE_FLAGS)
	@node $(CURDIR)/bin/ppn.mjs fork toml "$(FORK_DIR)" "$(FORK_TOML)"

# Make sure a bundle + config exist before a FORK=1 start.
ensure-fork-bundle: build-spawner
ifeq ($(FRESH_BITE),1)
	@echo "FRESH_BITE=1 — biting production now"
	@$(MAKE) --no-print-directory bite
else
	@test -f "$(FORK_DIR)/manifest.json" \
		&& echo "✓ Fork bundle present (bitten $$(jq -r .bittenAt $(FORK_DIR)/manifest.json))" \
		|| node $(CURDIR)/bin/ppn.mjs fork fetch-bundle "$(FORK_DIR)"
	@node $(CURDIR)/bin/ppn.mjs fork toml "$(FORK_DIR)" "$(FORK_TOML)" >/dev/null
	@echo "✓ Fork config: $(FORK_TOML)"
endif

ensure-binaries: build-spawner
	@node $(CURDIR)/bin/ppn.mjs fetch --if-needed "$(BIN_DIR)"

ensure-chainspecs: build-spawner
	@node $(CURDIR)/bin/ppn.mjs generate --if-needed "$(BIN_DIR)"

ensure-dot-cli:
	@$(SCRIPTS_DIR)/ensure-dot-cli.sh

# Force re-download everything and start
fresh: clean fetch generate start

# Fetch binaries and runtimes
fetch: build-spawner
	@node $(CURDIR)/bin/ppn.mjs fetch "$(BIN_DIR)"

# Generate chain specs
generate: build-spawner
	@node $(CURDIR)/bin/ppn.mjs generate "$(BIN_DIR)"

# Compile the workspace: @ppn/network-config and @ppn/cli.
# `build-spawner` is kept as an alias because existing callers use that name.
build build-spawner:
	@cd $(CURDIR) && \
	if command -v pnpm >/dev/null 2>&1; then \
		pnpm install --frozen-lockfile && pnpm build; \
	elif command -v corepack >/dev/null 2>&1; then \
		corepack enable && pnpm install --frozen-lockfile && pnpm build; \
	else \
		echo "pnpm is required to build the workspace (corepack enable)"; exit 1; \
	fi

# Regenerate local-dev.toml from @ppn/network-config (dev only).
# Run this after editing the generator — do not edit local-dev.toml directly.
generate-toml: build-spawner
	@node $(CURDIR)/bin/ppn.mjs genesis-toml > $(CONFIG_DIR)/local-dev.toml
	@echo "✓ local-dev.toml regenerated"

# =============================================================================
# Cleanup commands
# =============================================================================

# Clean everything (bin + data + design-families)
clean: clean-bin clean-data clean-design-families

clean-bin:
	rm -rf "$(BIN_DIR)"

clean-data:
	rm -rf "$(DATA_DIR)"

# Clean only chain specs (and chain data, since stale data won't match new
# genesis). Useful when iterating on the genesis workflow —
# much faster than `make clean` because it keeps the binaries.
clean-chainspecs: clean-data build-spawner
	@echo "Cleaning chain specs..."
	@node $(CURDIR)/bin/ppn.mjs generate --clean "$(BIN_DIR)"

# Clean only design families
# Remove the fork bundle and its generated config
clean-fork:
	@echo "Removing fork bundle..."
	@rm -rf "$(FORK_DIR)"

clean-design-families:
	rm -rf "$(CURDIR)/design-families"

# =============================================================================
# Utility commands
# =============================================================================

# Pin design families to IPFS
pin-design-families:
	$(SCRIPTS_DIR)/pin-design-families.sh

# Upgrade the runtime of a running chain (genesis or fork; local by default, WS= for remote).
# Usage: make runtime-upgrade CHAIN=asset-hub WASM=path/to/runtime.wasm [WS=wss://...] [ALLOW_SAME_SPEC=1]
runtime-upgrade: build-spawner
	@WS="$(WS)" ALLOW_SAME_SPEC="$(ALLOW_SAME_SPEC)" \
	node $(CURDIR)/bin/ppn.mjs upgrade "$(CHAIN)" "$(WASM)"

# Integration tests: spawn a network and run the .zndsl suites against it.
test:
	$(SCRIPTS_DIR)/run-tests.sh $(ARGS)

# Unit tests: the config generators and the fork/bite logic. No network needed.
test-unit: build-spawner
	@pnpm -r test

doctor:
	@echo "Checking prerequisites..."
	@echo ""
	@[ -x "$(CURDIR)/bin/zombie-cli" ] && echo "✓ zombie-cli" || echo "✗ zombie-cli (run: make fetch)"
	@command -v unzip >/dev/null && echo "✓ unzip" || echo "✗ unzip (required for fetch: brew install unzip / apt install unzip)"
	@command -v node >/dev/null && echo "✓ node: $$(node --version)" || echo "✗ node (required for tests)"
	@command -v dot >/dev/null && echo "✓ dot: $$(dot --version 2>/dev/null | head -1)" || echo "✗ dot (run: make ensure-dot-cli)"
	@if [ -n "$$GITHUB_TOKEN" ]; then \
		echo "✓ GitHub auth (GITHUB_TOKEN)"; \
	elif printf "protocol=https\nhost=github.com\n" | git credential fill 2>/dev/null | grep -q "^password="; then \
		echo "✓ GitHub auth (git credentials)"; \
	else \
		echo "✗ GitHub auth (run: gh auth login)"; \
	fi
	@command -v docker >/dev/null && echo "✓ docker" || echo "- docker (optional, for DOCKER=1 mode)"
	@echo ""

help:
	@echo ""
	@echo "Product Preview Network"
	@echo ""
	@echo "Usage: make <command> [OPTIONS]"
	@echo ""
	@echo "Commands:"
	@echo "  start                  Start the network (fetches deps if needed)"
	@echo "  kill                   Stop running network"
	@echo "  fresh                  Clean everything and start fresh"
	@echo "  fetch                  Download binaries and runtimes"
	@echo "  bite                   Bite the live network into a fork bundle (no start)"
	@echo "  fetch-doppelganger     Download the bite-only doppelganger binaries"
	@echo "  generate               Generate chain spec files"
	@echo "  clean                  Remove bin/, data/, and design-families/"
	@echo "  clean-bin              Remove only bin/ (keeps chain data)"
	@echo "  clean-data             Remove only data/ (keeps binaries)"
	@echo "  clean-chainspecs       Remove generated chain specs + data/ (keeps binaries)"
	@echo "  clean-fork             Remove the fork bundle"
	@echo "  pin-design-families    Pin design families to IPFS"
	@echo "  runtime-upgrade        Upgrade a running chain: CHAIN=<chain> WASM=<path>"
	@echo "  test                   Run integration tests (spawns a network)"
	@echo "  test-unit              Run spawner unit tests (config generators, fork/bite)"
	@echo "  doctor                 Check prerequisites"
	@echo ""
	@echo "Options (can combine with any command):"
	@echo "  DOCKER=1       Run in Docker (linux/amd64, not supported on ARM Macs)"
	@echo "  EPHEMERAL=1    No persistence (data in temp, lost on stop)"
	@echo "  CLEAN=1        Wipe data directory before starting (a fork restarts at its bite block)"
	@echo "  REGENERATE=1   Regenerate chain specs before starting"
	@echo "  DATA_DIR=path  Custom data directory (default: ./data)"
	@echo "  FORK=1         Start from the live network's state, not genesis. A stopped fork resumes"
	@echo "  NETWORK=name   Which network (networks/*.json, default previewnet)."
	@echo "                 Only previewnet starts from genesis; the rest are fork-only."
	@echo "  FRESH_BITE=1   With FORK=1: bite the live network now, not a published bundle"
	@echo "  UPGRADES=...   With a bite: authorize runtimes at import, \"<chain>=<wasm> ...\" (no-sudo networks)"
	@echo ""
	@echo "Examples:"
	@echo "  make start                    Start with persistence (default)"
	@echo "  make start EPHEMERAL=1        Start without persistence"
	@echo "  make start FORK=1             Fork of production (downloads a bundle)"
	@echo "  make start FORK=1 NETWORK=devnet  Fork of devnet"
	@echo "  make start FORK=1 FRESH_BITE=1  Fork, biting production right now"
	@echo "  make start CLEAN=1            Wipe data and start fresh"
	@echo "  DOCKER=1 make start           Run in Docker"
	@echo "  DOCKER=1 make start CLEAN=1   Docker with clean start"
	@echo ""
	@. $(CURDIR)/config/ports.env && \
	echo "Endpoints:" && \
	echo "  Relay:       ws://127.0.0.1:$$RELAY_ALICE_PORT" && \
	echo "  Asset Hub:   ws://127.0.0.1:$$ASSET_HUB_PORT  (2s blocks)" && \
	echo "  People:      ws://127.0.0.1:$$PEOPLE_PORT" && \
	echo "  Bulletin:    ws://127.0.0.1:$$BULLETIN_PORT" && \
	echo "  Eth RPC:     http://127.0.0.1:$$ETH_RPC_PORT" && \
	echo ""
