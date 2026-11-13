#!/usr/bin/env bash
# The one command on the VM. Idempotent: run it after every push to this branch.
#
#   deploy/polkadot-test/apply.sh              pull, build, fetch, nginx, unit, restart the network
#   deploy/polkadot-test/apply.sh --no-restart same, but leave the running network alone
#   deploy/polkadot-test/apply.sh --no-pull    work from the checkout as it is
#
# A bite is never done here: `make bite NETWORK=polkadot UPGRADES=...` is a deliberate act.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT"
source "$HERE/vm.env"

RESTART=1
PULL=1
for arg in "$@"; do
  case "$arg" in
    --no-restart) RESTART=0 ;;
    --no-pull) PULL=0 ;;
    *) echo "apply.sh: unknown argument '$arg'" >&2; exit 2 ;;
  esac
done

say() { echo "apply: $*"; }
changed() { ! cmp -s "$1" "$2"; }

# ---- 1. dependencies ------------------------------------------------------------------------
# What a fresh Ubuntu is missing for this to run at all. Node comes from NodeSource when it is
# absent or too old; pnpm through corepack; everything else from apt.
NODE_MAJOR_MIN=22
APT_WANTED=(nginx certbot gettext-base jq lsof unzip curl tmux git build-essential)
APT_MISSING=()
for pkg in "${APT_WANTED[@]}"; do dpkg -s "$pkg" >/dev/null 2>&1 || APT_MISSING+=("$pkg"); done
NEED_NODE=0
if ! command -v node >/dev/null 2>&1; then
  NEED_NODE=1
elif [[ "$(node --version | sed 's/^v\([0-9]*\).*/\1/')" -lt "$NODE_MAJOR_MIN" ]]; then
  NEED_NODE=1
fi
if [[ ${#APT_MISSING[@]} -gt 0 || "$NEED_NODE" == 1 ]]; then
  say "installing: ${APT_MISSING[*]}${NEED_NODE:+ node}"
  sudo apt-get update -qq
  if [[ "$NEED_NODE" == 1 ]]; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_MIN}.x" | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
  [[ ${#APT_MISSING[@]} -gt 0 ]] && sudo apt-get install -y "${APT_MISSING[@]}"
fi
if ! command -v pnpm >/dev/null 2>&1; then
  sudo corepack enable >/dev/null 2>&1 || corepack enable >/dev/null 2>&1 || sudo npm install -g pnpm
fi
if ! command -v gh >/dev/null 2>&1; then
  say "WARNING: gh is not installed; \`make fetch\` needs GITHUB_TOKEN or gh auth for private release assets"
fi
sudo install -d -o "$RUN_USER" -g "$RUN_USER" "$LOG_DIR"

# ---- 2. code ----------------------------------------------------------------------------
# ports.env is patched below on every run, so the local copy is disposable: drop it before the
# pull, or a pull that touches the file fails.
if [[ "$PULL" == 1 ]]; then
  git checkout -q -- config/ports.env 2>/dev/null || true
  git pull -q --ff-only
fi
say "at $(git rev-parse --short HEAD) on $(git branch --show-current)"
pnpm install --frozen-lockfile >/dev/null
BUILD_LOG="$(mktemp)"
if ! pnpm -r build > "$BUILD_LOG" 2>&1; then cat "$BUILD_LOG"; rm -f "$BUILD_LOG"; exit 1; fi
rm -f "$BUILD_LOG"

# ---- 3. artifacts -----------------------------------------------------------------------
# Picks up a changed node pin or dub tag; a no-op when provenance says everything is current.
FETCH_LOG="$(mktemp)"
if ! make fetch NETWORK="$NETWORK" > "$FETCH_LOG" 2>&1; then cat "$FETCH_LOG"; rm -f "$FETCH_LOG"; exit 1; fi
grep -vE "^\s*✓|^$" "$FETCH_LOG" | grep -iE "fetch|download|missing|✗" || true
rm -f "$FETCH_LOG"

# ---- 4. the machine's values into ports.env --------------------------------------------
# zombienet hands custom processes no environment, so the dashboard and bootnode patching read
# these from the file. The actions token is the one secret; it lives in local.env.
LOCAL_ENV="$HERE/local.env"
if [[ ! -f "$LOCAL_ENV" ]]; then
  printf 'DASHBOARD_ACTIONS_TOKEN=%s\n' "$(openssl rand -hex 24)" > "$LOCAL_ENV"
  say "created $LOCAL_ENV with a new dashboard actions token"
fi
source "$LOCAL_ENV"
sed -i \
  -e "s|^BOOTNODE_HOSTNAME=.*|BOOTNODE_HOSTNAME=$DOMAIN|" \
  -e "s|^PPN_PUBLIC_URL=.*|PPN_PUBLIC_URL=https://$DOMAIN|" \
  -e "s|^DASHBOARD_HOST=.*|DASHBOARD_HOST=127.0.0.1|" \
  -e "s|^P2P_LISTEN_IP=.*|P2P_LISTEN_IP=$PUBLIC_IP|" \
  -e "s|^DASHBOARD_ACTIONS_TOKEN=.*|DASHBOARD_ACTIONS_TOKEN=${DASHBOARD_ACTIONS_TOKEN:-}|" \
  config/ports.env
say "ports.env: domain $DOMAIN, listen ip $PUBLIC_IP"

# ---- 5. nginx ---------------------------------------------------------------------------
TLS_DIR="/etc/letsencrypt/live/$DOMAIN"
if [[ ! -f "$TLS_DIR/fullchain.pem" ]]; then
  say "WARNING: no certificate at $TLS_DIR — nginx not touched. Issue one, then re-run:"
  say "  sudo systemctl stop nginx && sudo certbot certonly --standalone -d $DOMAIN --deploy-hook 'systemctl reload nginx'"
else
  export PPN_NETWORK="$NETWORK" PPN_DOMAIN="$DOMAIN" PPN_TLS_DIR="$TLS_DIR" LOG_DIR DATA_DIR="$ROOT/data-fork-$NETWORK"
  set -a; source config/ports.env; set +a
  # Re-exported after ports.env, which must not be allowed to blank them.
  export LOG_DIR DATA_DIR
  ROUTED="$(mktemp)"; RENDERED="$(mktemp)"
  node bin/ppn.mjs nginx-conf "$HERE/nginx/ppn.conf.template" "$ROUTED" >/dev/null
  # Named explicitly so nginx's own $host and friends survive.
  envsubst '$PPN_DOMAIN $PPN_TLS_DIR $DATA_DIR $LOG_DIR $RELAY_ALICE_PORT $RELAY_BOB_PORT $RELAY_CHARLIE_PORT $RELAY_DAVE_PORT $RELAY_EVE_PORT $RELAY_FERDIE_PORT $PEOPLE_PORT $ASSET_HUB_PORT $BULLETIN_PORT $WEB3_STORAGE_PORT $ETH_RPC_PORT $WEB3_STORAGE_PROVIDER_PORT $IPFS_GATEWAY_PORT $DUB_PORT $DASHBOARD_PORT $RELAY_ALICE_P2P_PORT $ASSET_HUB_P2P_PORT $PEOPLE_P2P_PORT $BULLETIN_P2P_PORT $WEB3_STORAGE_P2P_PORT $RELAY_ALICE_P2P_WSS_PORT $ASSET_HUB_P2P_WSS_PORT $PEOPLE_P2P_WSS_PORT $BULLETIN_P2P_WSS_PORT $WEB3_STORAGE_P2P_WSS_PORT' \
    < "$ROUTED" > "$RENDERED"
  if LEFT=$(grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*\}' "$RENDERED" | sort -u | tr '\n' ' ') && [[ -n "$LEFT" ]]; then
    echo "apply: nginx config has unsubstituted variables: $LEFT" >&2; exit 1
  fi
  NGINX_CHANGED=0
  if changed "$RENDERED" /etc/nginx/sites-available/ppn.conf; then
    sudo install -m 0644 "$RENDERED" /etc/nginx/sites-available/ppn.conf; NGINX_CHANGED=1
  fi
  if changed "$HERE/nginx/websocket-proxy.conf" /etc/nginx/snippets/websocket-proxy.conf; then
    sudo install -m 0644 "$HERE/nginx/websocket-proxy.conf" /etc/nginx/snippets/websocket-proxy.conf; NGINX_CHANGED=1
  fi
  rm -f "$ROUTED" "$RENDERED"
  sudo ln -sf /etc/nginx/sites-available/ppn.conf /etc/nginx/sites-enabled/ppn.conf
  sudo rm -f /etc/nginx/sites-enabled/default
  if [[ "$NGINX_CHANGED" == 1 ]]; then
    sudo nginx -t && sudo systemctl enable --now nginx >/dev/null && sudo systemctl reload nginx
    say "nginx: config updated and reloaded"
  else
    sudo systemctl is-active --quiet nginx || sudo systemctl enable --now nginx
    say "nginx: unchanged"
  fi
fi

# ---- 6. systemd unit --------------------------------------------------------------------
UNIT=/etc/systemd/system/ppn-polkadot.service
RENDERED_UNIT="$(mktemp)"
sed -e "s|__ROOT__|$ROOT|g" -e "s|__USER__|$RUN_USER|g" "$HERE/ppn-polkadot.service" > "$RENDERED_UNIT"
if changed "$RENDERED_UNIT" "$UNIT"; then
  sudo install -m 0644 "$RENDERED_UNIT" "$UNIT"
  sudo systemctl daemon-reload
  say "unit: installed"
fi
rm -f "$RENDERED_UNIT"
sudo systemctl enable ppn-polkadot.service >/dev/null 2>&1 || true

# ---- 7. the network ---------------------------------------------------------------------
if [[ ! -f "fork-bundle-$NETWORK/manifest.json" ]]; then
  say "no bundle at fork-bundle-$NETWORK — bite first: make bite NETWORK=$NETWORK UPGRADES=\"...\""
elif [[ "$RESTART" == 1 ]]; then
  # Anything running outside systemd (a `make start` in tmux) goes too: two networks on one
  # port set is worse than a restart.
  sudo systemctl stop ppn-polkadot.service 2>/dev/null || true
  node bin/ppn.mjs kill >/dev/null 2>&1 || true
  sudo systemctl start ppn-polkadot.service
  say "network: restarting under systemd (journalctl -u ppn-polkadot -f)"
else
  say "network: left alone (--no-restart)"
fi

echo
say "done. dashboard https://$DOMAIN  token in $LOCAL_ENV"
