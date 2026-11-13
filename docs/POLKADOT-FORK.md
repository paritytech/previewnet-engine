# Forking Polkadot with the fellowship runtimes

A runbook for one dedicated machine that keeps a fork of Polkadot running, optionally with a
fellowship runtime release newer than mainnet's enacted on it. Mainnet runs v2.5.3, with the
Individuality pallets on People and Asset Hub. Everything here is `make` on top of what
`docs/FORK.md` explains; read that for the why.

## What the fork is

| Chain | Live para id | Runtime live (2026-11) |
| --- | --- | --- |
| Relay | | polkadot 2005003 |
| Asset Hub | 1000 | statemint 2005003 |
| People | 1004 | people-polkadot 2005003 |
| Bulletin | 1010 | bulletin-polkadot 2005003 |

A bite takes these runtimes as they are; `UPGRADES=` adds a runtime under test (see "Bite and
start"). Six dev validators, one collator per parachain, PPN's normal ports. All six HRMP
channels between the three parachains exist on live Polkadot and survive the bite. Polkadot has
no sudo, so a runtime under test is authorized at bite time and enacted after the spawn. Nothing
else on the fork can dispatch root, so the grant processes do not run: the bite seeds both
attestation allowances instead (`docs/FORK.md`, "What the bite seeds"), dub's `polkadot` build
has no invite roles, and Web3 Storage is not part of the fork.

## One-time setup

Linux x86_64 or macOS arm64, Node.js 24+, pnpm, `gh` authenticated (or `GITHUB_TOKEN`), and the
usual `make doctor`. Then:

```bash
git clone https://github.com/paritytech/previewnet-engine && cd previewnet-engine
pnpm install
make fetch NETWORK=polkadot              # polkadot, polkadot-parachain, eth-rpc into bin/polkadot/
make fetch-doppelganger NETWORK=polkadot # the bite tool, into bin/polkadot/dg/
```

Then replace `bin/polkadot/polkadot-parachain` with a build that has the fork-id fix (see
`docs/FORK.md`). Any later `make fetch`, including the one `apply.sh` runs, restores the stock one.

## Get the runtimes

Only for a runtime newer than mainnet's. PPN takes runtime blobs as files; fetching them is `gh`'s
job: a release's assets, or an unreleased build from its PR's build workflow, which uploads one
artifact per runtime, named after it:

```bash
gh release download <tag> -R polkadot-fellows/runtimes -D runtimes/ -p 'asset-hub-polkadot_*' -p 'people-polkadot_*'
gh run download <run-id> -R polkadot-fellows/runtimes -D runtimes/ -n asset-hub-polkadot -n people-polkadot
```

Artifacts expire after 90 days; the directory is what you keep. The relay and Bulletin runtimes
are in the same places (`polkadot`, `bulletin-polkadot`).

## Bite and start

```bash
make bite NETWORK=polkadot
make start FORK=1 NETWORK=polkadot            # spawns from fork-bundle-polkadot/
```

To rehearse a runtime under test, name its blobs in the bite:

```bash
make bite NETWORK=polkadot UPGRADES="asset-hub=runtimes/<asset-hub-wasm> people=runtimes/<people-wasm>"
```

The bite is ~20 minutes: it warp-syncs all four chains and authorizes any blobs, printing per chain
what it authorized. With `UPGRADES=`, the start then does the rest on its own: once the chains
author, the `enact-upgrades` process submits `apply_authorized_upgrade` for every seeded parachain
at once, waits for the relay's PVF pre-check and go-ahead, then does the relay, and the dashboard
flips each to its new spec version. Its log is under the dashboard's logs tab. On a bundle bitten
with the current code that is a few minutes: the bite sets the relay's `validation_upgrade_delay`
to 30 blocks and the cooldown to 60 (live Polkadot: 600 and 14400, an hour and a day).

To redo one chain by hand, `make runtime-upgrade NETWORK=polkadot CHAIN=people` with no `WASM=`
applies the blob the bite authorized; on a chain already running it, it is a no-op. A second
upgrade of the same chain (a newer build) is a new bite with the new blob, and the 60-block
cooldown means it can follow the first within minutes.

## Day to day

| You want | Run |
| --- | --- |
| Stop | `make kill` |
| Start again where it stopped, upgrades still enacted | `make start FORK=1 NETWORK=polkadot` |
| Back to the bite block (the upgrades are re-enacted on the way up) | `make start FORK=1 NETWORK=polkadot CLEAN=1` |
| Fresh state from live Polkadot, same runtimes | the same `make bite` (with the same `UPGRADES=`, if any) then start |
| Different runtimes under test | download again, then a new bite with the new files — the authorization is state inside the bundle |
| Throw the bundle away | `make clean-fork NETWORK=polkadot` |

A start decides between resuming and wiping from the spawn stamp in `data-fork-polkadot/`: if
it names the bite the bundle carries, the fork continues; if the bundle was re-bitten since,
the old data goes. A start that reuses a bundle prints what that bundle has authorized.

Node logs are under `data-fork-polkadot/`, one `<node>/<node>.log` per node; the bite's own logs
under `fork-bundle-polkadot-logs/`.

## Exposing it: nginx, TLS, systemd

The engine ships no server tooling; Parity's previewnet boxes get theirs from preview-net-v1's
`server/` directory and its deploy workflow, which today only know how to spawn previewnet from
genesis. Until that grows a fork target, this is the same setup done by hand, once. The fork
machine's own branch adds `deploy/polkadot-test/apply.sh`, which does all of it (see its README);
the steps below are what it automates. They predate two things it adds: the nginx `stream {}`
block for TURN over TLS, without whose `{{GENERATED_STREAMS}}` marker `ppn nginx-conf` refuses
the template, and the secrets file `/etc/ppn/secrets.env` (named by `PPN_SECRETS_FILE` in
`ports.env`), without which the box runs the public dev secrets. Ubuntu assumed; `DOMAIN` is
the name the box answers on.

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

The webrtc-direct collators (Asset Hub, Bulletin) bind the interface `P2P_LISTEN_IP` names,
`127.0.0.1` by default, which nobody outside the box can reach. Export the box's public IP —
`P2P_LISTEN_IP=203.0.113.10` in the unit below — or set it in `ports.env` the same way. This is
independent of TLS: webrtc-direct carries its own certificate hash in the address.

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
Environment="P2P_LISTEN_IP=203.0.113.10"
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

Run the bite (`make bite NETWORK=polkadot` above) before the first `systemctl start`; the unit
only spawns what is already bitten, and a restart resumes it. `make kill` and `systemctl stop`
are the same thing; use the latter so systemd does not restart what you stopped.

One limit of the hand-rolled version: nothing collects node logs out of `data-fork-polkadot/` the
way v1's log collector does, and a wipe (`CLEAN=1`, or a start after a re-bite) removes them with
the data. Copy what you need first.

## Services on this fork

Asset Hub's eth-rpc, Bulletin's IPFS daemon, the dashboard and the identity backend (dub, its
`polkadot` build) start with the chains. What does not run, because each needs root on a chain
that has none: the attestation allowance and invite grants (the bite seeds both allowances, and
the `polkadot` build has no invite roles), HRMP opening and core assignment (both already in
state), and the DotNS genesis steps on Asset Hub (the fork inherits mainnet's dotNS). Polkadot
Bulletin stores nothing, so there are no products to import.

## What is not verified yet

Verified on the first machine (2026-09-03): the bite of all four chains including Bulletin
from its published spec, all four authoring afterwards with the HRMP reset in place, and the
dashboard, eth-rpc and IPFS coming up beside them. Two bugs found the same day and fixed: the
bite wrote the upgrade authorization as an override, which doppelganger applies only to keys
the live state already has, so it never landed and the apply failed `NothingAuthorized`; and
the upgrade command read `Sudo.Key` before checking whether the chain has a Sudo pallet.

- The upgrade enactment end to end was verified the same day on a re-bite: apply landing,
  PVF pre-check, go-ahead 600 relay blocks later, all four chains on `2005000`, dub up. Not yet
  verified: a bite made after the delay/cooldown patch enacting within minutes, and a second
  upgrade of the same parachain after the shortened cooldown.
- Stop and resume of a running fork on this branch's code. A resume leaves the snapshots out of
  the spawn config (`start-network.test.ts` checks it), and each node restarts on its own
  database, but nobody has watched it on the box yet.
- A registration through dub on the fork. dub v0.8.0's `polkadot` build vendors people-polkadot
  2005000's metadata, which matches mainnet's 2005003 in everything dub reads, decodes and signs
  with (compared with `subxt diff`, 2026-11-13). The bite seeds both attestation allowances, and
  the build has no invite roles.

Tell the runbook what you find.
