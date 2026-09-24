// `ppn service turn`: the TURN/STUN relay (eturnal) whose credentials DUB's turn-api mints.
// `ppn service dub-turn-env`: the matching secret and ICE servers, as shell exports for
// scripts/dub/service.sh. Both resolve from the same inputs, so they cannot disagree.
// See docs/TURN.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { LOCAL_TURN_SECRET, eturnalConfig, iceServers, runsTurnRelay, turnSecret } from '@parity/ppn-network-config';
import type { ServiceContext } from './service-context.js';
import { secretsFile } from '../lib/secrets.js';
import { ETURNAL_BREW_INSTALL, eturnalCtl, eturnalDist } from '../lib/eturnal.js';

/** The host clients reach the network under; only its hostname and scheme matter here. */
function publicBaseUrl(ctx: ServiceContext): string {
  return process.env.PPN_PUBLIC_URL || ctx.ports.PPN_PUBLIC_URL || 'http://127.0.0.1';
}

function listenIp(ctx: ServiceContext): string {
  return process.env.P2P_LISTEN_IP || ctx.ports.P2P_LISTEN_IP || '127.0.0.1';
}

const secretOf = () => turnSecret(process.env.TURN_SECRET, secretsFile() !== null);

export function dubTurnEnv(ctx: ServiceContext): Record<string, string> {
  // turn-api still requires a secret with no relay behind it; nothing checks it then.
  if (!runsTurnRelay(ctx.net)) {
    return { TURN_SECRET: process.env.TURN_SECRET || LOCAL_TURN_SECRET, ICE_SERVERS: '' };
  }
  return {
    TURN_SECRET: secretOf().base64,
    ICE_SERVERS: iceServers(publicBaseUrl(ctx)).map((s) => s.url).join(','),
  };
}

export async function printDubTurnEnv(ctx: ServiceContext): Promise<void> {
  for (const [k, v] of Object.entries(dubTurnEnv(ctx))) {
    console.log(`export ${k}='${v.replace(/'/g, `'\\''`)}'`);
  }
}

export async function turn(ctx: ServiceContext): Promise<void> {
  const ctl = eturnalCtl(ctx.sharedBinDir);
  if (!ctl) {
    throw new Error(
      process.platform === 'darwin'
        ? `eturnal is not installed. On macOS it comes from the processone tap:\n       ${ETURNAL_BREW_INSTALL}`
        : `eturnal not found under ${eturnalDist(ctx.sharedBinDir)} (run \`ppn fetch\`)`
    );
  }
  const secret = secretOf();

  // Not DATA_DIR/turn: that is where zombienet writes this process's log.
  const dataDir =
    process.env.DATA_DIR || ctx.ports.PPN_DATA_DIR || path.join(path.dirname(ctx.sharedBinDir), 'data');
  const state = path.join(dataDir, 'turn-state');
  const etcDir = path.join(state, 'etc');
  const runDir = path.join(state, 'run');
  fs.mkdirSync(etcDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  const ip = listenIp(ctx);
  fs.writeFileSync(path.join(etcDir, 'eturnal.yml'), eturnalConfig({ listenIp: ip, runDir }));

  console.log(`turn: eturnal (${ctl}) on ${ip}, config ${etcDir}/eturnal.yml`);
  for (const s of iceServers(publicBaseUrl(ctx))) console.log(`  ${s.url}`);

  const env = {
    ...process.env,
    // zombienet passes custom processes no HOME; the Erlang VM keeps its cookie there.
    HOME: process.env.HOME || os.homedir(),
    ETURNAL_ETC_DIR: etcDir,
    // eturnalctl prefers $ETURNAL_PREFIX/bin/eturnal, defaulting to a system install path.
    ETURNAL_PREFIX: path.dirname(path.dirname(ctl)),
    ETURNAL_SECRET: secret.plain,
    // eturnalctl switches to an `eturnal` user when started as root; run as whoever we are.
    ETURNAL_USER: os.userInfo().username,
  };

  // zombienet has no restart policy for custom processes, so this loop is the supervisor.
  let child: ChildProcess | null = null;
  let stopping = false;
  const stop = () => {
    stopping = true;
    child?.kill('SIGTERM');
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  while (!stopping) {
    child = spawn(ctl, ['foreground'], { stdio: 'inherit', env });
    const code = await new Promise<number | null>((resolve) => {
      child!.on('exit', (c, signal) => resolve(signal ? null : c));
      child!.on('error', (err) => {
        console.error(`turn: ${err.message}`);
        resolve(1);
      });
    });
    child = null;
    if (stopping || code === null) return;
    console.log(`turn: eturnal exited (code ${code}), restarting in 5s...`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
