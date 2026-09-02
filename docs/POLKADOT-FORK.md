# Forking Polkadot with the fellowship runtimes

A runbook for one dedicated machine that keeps a fork of Polkadot running with a fellowship
runtime release enacted on it — currently 2.5, the release that lands Individuality on People
Polkadot and Asset Hub Polkadot. Everything here is `make` on top of what `docs/FORK.md`
explains; read that for the why.

## What the fork is

| Chain | Live para id | Runtime live (2026-09) | Runtime under test |
| --- | --- | --- | --- |
| Relay | | polkadot 2004000 | polkadot 2005000 (version bump only) |
| Asset Hub | 1000 | statemint 2004000 | pallet-revive 0.19.1, Individuality pallets |
| People | 1004 | people-polkadot 2004000 | Individuality pallets |
| Bulletin | 1010 | bulletin-polkadot 2004000 | version bump only |

Six dev validators, one collator per parachain, PPN's normal ports. All six HRMP channels
between the three parachains exist on live Polkadot and survive the bite. Polkadot has no sudo,
so the runtimes are authorized at bite time and enacted after the spawn; nothing else on the
fork can dispatch root, which is why the People-side grants (attestation allowance, invites)
do not run here and Web3 Storage is not part of it.

## One-time setup

Linux x86_64 or macOS arm64, Node 22+, pnpm, `gh` authenticated (or `GITHUB_TOKEN`), and the
usual `make doctor`. Then:

```bash
git clone https://github.com/paritytech/previewnet-engine && cd previewnet-engine
pnpm install
make fetch NETWORK=polkadot              # polkadot, polkadot-parachain, eth-rpc into bin/polkadot/
make fetch-doppelganger NETWORK=polkadot # the bite tool, into bin/polkadot/dg/
```

## Get the runtimes

PPN takes runtime blobs as files; fetching them is `gh`'s job. 2.5 is not a release yet, it is
the open release PR ([polkadot-fellows/runtimes#1265](https://github.com/polkadot-fellows/runtimes/pull/1265)),
whose build workflow uploads one artifact per runtime, named after it, on every push:

```bash
# newest "Tests" run on the release branch that actually uploaded the runtimes (not every run does)
RUN=$(for id in $(gh api "repos/polkadot-fellows/runtimes/actions/runs?branch=kiz-release-2.5&per_page=30" -q '.workflow_runs[] | select(.name=="Tests") | .id'); do
  gh api repos/polkadot-fellows/runtimes/actions/runs/$id/artifacts -q '.artifacts[] | select(.name=="people-polkadot") | .id' | grep -q . && echo $id && break; done)
gh run download $RUN -R polkadot-fellows/runtimes -D runtimes/ -n asset-hub-polkadot -n people-polkadot
ls runtimes/*/   # runtimes/asset-hub-polkadot/asset_hub_polkadot_runtime.compact.compressed.wasm, …
```

Re-run after the PR is pushed to and the blobs follow. Artifacts expire after 90 days; the
directory is what you keep. Once 2.5 is cut, the release assets replace the artifacts:

```bash
gh release download v2.5.0 -R polkadot-fellows/runtimes -D runtimes/ -p 'asset-hub-polkadot_*' -p 'people-polkadot_*'
```

The relay and bulletin runtimes are in the same places (`polkadot`, `bulletin-polkadot`) if you
want the whole release on the fork; 2.5 changes nothing in them beyond the version.

## Bite and start

```bash
make bite NETWORK=polkadot UPGRADES="asset-hub=runtimes/asset-hub-polkadot/asset_hub_polkadot_runtime.compact.compressed.wasm people=runtimes/people-polkadot/people_polkadot_runtime.compact.compressed.wasm"
make start FORK=1 NETWORK=polkadot            # spawns from fork-bundle-polkadot/
```

That is ~20 minutes: it warp-syncs all four chains and authorizes the blobs. `make bite` prints, per chain, the runtime it authorized. Watch the relay finalize
(`ws://127.0.0.1:10000`) and the collators author before upgrading. Then, one chain at a time:

```bash
make runtime-upgrade NETWORK=polkadot CHAIN=asset-hub   # no WASM=: uses the blob the bite authorized
make runtime-upgrade NETWORK=polkadot CHAIN=people
```

Each submits `apply_authorized_upgrade` unsigned, waits for the relay's PVF pre-check and
go-ahead, and reports `OK <chain>: <spec> 2004000 -> 2005000`.

## Day to day

| You want | Run |
| --- | --- |
| Stop | `make kill` |
| Start again where it stopped, upgrades still enacted | `make start FORK=1 NETWORK=polkadot` |
| Back to the bite block, upgrades authorized but not enacted | `make start FORK=1 NETWORK=polkadot CLEAN=1` |
| Fresh state from live Polkadot, same runtimes | the same `make bite ... UPGRADES=...` then start |
| Different runtimes (the PR was pushed to) | download again, then a new bite with the new files — the authorization is state inside the bundle |
| Throw the bundle away | `make clean-fork NETWORK=polkadot` |

A start decides between resuming and wiping from the spawn stamp in `data-fork-polkadot/`: if
it names the bite the bundle carries, the fork continues; if the bundle was re-bitten since,
the old data goes. A start that reuses a bundle prints what that bundle has authorized.

Node logs are under `/tmp/zombie-*/`; the bite's own logs under `fork-bundle-polkadot-logs/`.

## Exposing it: nginx, TLS, systemd

The engine ships no server tooling; Parity's previewnet boxes get theirs from preview-net-v1's
`server/` directory and its deploy workflow, which today only know how to spawn previewnet from
genesis. Until that grows a fork target, this is the same setup done by hand, once. Ubuntu
assumed; `DOMAIN` is the name the box answers on.

**DNS and packages.** Add an A record for `DOMAIN` pointing at the box (Parity's zones live in
the `dns` repo). Then:

```bash
sudo apt-get install -y nginx certbot gettext-base jq lsof
```

**Certificate.** Before nginx holds port 80, issue it standalone. certbot installs a renewal
timer; the deploy hook makes nginx pick the renewed files up.

```bash
sudo systemctl stop nginx
sudo certbot certonly --standalone -d "$DOMAIN" --deploy-hook 'systemctl reload nginx'
```

**Tell the network its public name.** The dashboard and the bootnode addresses the chain specs
advertise come from `config/ports.env`, and zombienet hands its custom processes no
environment, so this is a file edit rather than an export (it is a tracked file; a later `git
pull` may want it stashed):

```bash
sed -i "s|^BOOTNODE_HOSTNAME=.*|BOOTNODE_HOSTNAME=$DOMAIN|; s|^PPN_PUBLIC_URL=.*|PPN_PUBLIC_URL=https://$DOMAIN|" config/ports.env
```

**nginx.** The template and the websocket snippet are preview-net-v1's, `server/nginx/`;
copy the two files onto the box. `ppn nginx-conf` fills the chain routes in from the network
descriptor — with `PPN_NETWORK=polkadot` that is Asset Hub, People and Bulletin, and nothing for
Web3 Storage — and `envsubst` fills the rest from `ports.env`. The variable list is explicit so
nginx's own `$host` and friends survive.

```bash
export PPN_NETWORK=polkadot PPN_DOMAIN="$DOMAIN" PPN_TLS_DIR="/etc/letsencrypt/live/$DOMAIN"
export LOG_DIR=/var/log/ppn DATA_DIR="$PWD/data-fork-polkadot"
set -a; source config/ports.env; set +a
node bin/ppn.mjs nginx-conf server/nginx/ppn.conf.template /tmp/ppn.conf.routed
envsubst '$PPN_DOMAIN $PPN_TLS_DIR $DATA_DIR $LOG_DIR
  $RELAY_ALICE_PORT $RELAY_BOB_PORT $RELAY_CHARLIE_PORT $RELAY_DAVE_PORT $RELAY_EVE_PORT $RELAY_FERDIE_PORT
  $PEOPLE_PORT $ASSET_HUB_PORT $BULLETIN_PORT $WEB3_STORAGE_PORT
  $ETH_RPC_PORT $WEB3_STORAGE_PROVIDER_PORT $IPFS_GATEWAY_PORT $DUB_PORT $DASHBOARD_PORT
  $RELAY_ALICE_P2P_PORT $ASSET_HUB_P2P_PORT $PEOPLE_P2P_PORT $BULLETIN_P2P_PORT $WEB3_STORAGE_P2P_PORT
  $RELAY_ALICE_P2P_WSS_PORT $ASSET_HUB_P2P_WSS_PORT $PEOPLE_P2P_WSS_PORT $BULLETIN_P2P_WSS_PORT $WEB3_STORAGE_P2P_WSS_PORT' \
  < /tmp/ppn.conf.routed > /tmp/ppn.conf
grep -oE '\$\{[A-Za-z_]+\}' /tmp/ppn.conf || echo "all variables substituted"
sudo install -m 0644 /tmp/ppn.conf /etc/nginx/sites-available/ppn.conf
sudo install -m 0644 server/nginx/websocket-proxy.conf /etc/nginx/snippets/
sudo ln -sf /etc/nginx/sites-available/ppn.conf /etc/nginx/sites-enabled/ && sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl restart nginx
```

Open 80, 443 and the p2p wss ports (`*_P2P_WSS_PORT` in `ports.env`, 31333-31337 by default)
in whatever firewall sits in front. The template's upstream for Web3 Storage points at a port
nothing listens on here, which is harmless.

**systemd.** One unit runs the fork through `ppn start`, so the bundle check, the resume
decision and the spawn stamp all apply on a restart. `DASHBOARD_PROXY=0` because nginx does
the proxying. Replace `ubuntu` and the paths with yours.

```ini
# /etc/systemd/system/ppn-polkadot.service
[Unit]
Description=PPN fork of Polkadot
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/home/ubuntu/previewnet-engine
Environment="PPN_NETWORK=polkadot"
Environment="DASHBOARD_PROXY=0"
Environment="RUST_LOG=info"
Environment="PATH=/home/ubuntu/previewnet-engine/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart=/usr/bin/node bin/ppn.mjs start polkadot --fork
ExecStop=/usr/bin/node bin/ppn.mjs kill
TimeoutStopSec=90
Restart=on-failure
RestartSec=30
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now ppn-polkadot.service
journalctl -u ppn-polkadot -f
```

Run the bite (`make bite ... UPGRADES=...` above) before the first `systemctl start`; the unit
only spawns what is already bitten, and a restart resumes it. `make kill` and `systemctl stop`
are the same thing; use the latter so systemd does not restart what you stopped.

Two limits of the hand-rolled version, both fixed once preview-net-v1 grows a fork target:
`fork.toml` is regenerated on every start with webrtc-direct listening on `127.0.0.1`, so
browser peers over webrtc do not reach the collators (wss through nginx does); and nothing
collects node logs out of `/tmp/zombie-*/` the way v1's log collector does.

## Services on this fork

Asset Hub's eth-rpc, Bulletin's IPFS daemon, the dashboard and the identity backend (dub)
start with the chains. dub talks to the Individuality pallets, so it only does anything once
People runs 2.5; before that its chain writer errors and can be ignored. What does not run,
because each needs root on a chain that has none: the attestation allowance and invite grants
on People, HRMP opening and core assignment (both already in state), and the DotNS genesis
steps on Asset Hub. Polkadot's Asset Hub carries no DotNS deployment, so there are no products
to import into Bulletin either.

## What is not verified yet

- A real bite of Polkadot with three parachains, end to end, on this branch. The override
  generation was run against live Polkadot (79 HRMP channels reset, six between our chains,
  every value round-trips through the live metadata); the warp sync of Bulletin from its
  published spec has not been.
- Stop and resume of a running fork. Mechanically it is only skipping the wipe, and each node
  restarts on its own database, but nobody has watched six validators come back after an hour.
- Whether dub works against the fellowship's People runtime rather than previewnet's build.

Tell the runbook what you find.
