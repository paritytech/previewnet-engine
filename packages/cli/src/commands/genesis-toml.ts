// `ppn genesis-toml` — the checked-in zombienet config for a genesis network.
//
// packages/network-config/src/toml-generator.ts is the single source of truth for ports, per-chain args
// and which custom processes run; this prints what it generates. Regenerate the
// checked-in copy with `make generate-toml` after editing that file.
//
// Environment:
//   PPN_PARACHAINS  comma-separated subset (default: every parachain the network has)
//   ENABLE_HOP      --enable-hop on the bulletin collator (default true)

import { loadCurrentNetwork, type Parachain } from '@parity/ppn-network-config';
import { generateToml } from '@parity/ppn-network-config';

export async function run(_args?: string[]): Promise<void> {
  const net = loadCurrentNetwork();
  if (!net.genesis) {
    console.error(`ppn genesis-toml: ${net.name} is fork-only — it has no genesis config`);
    process.exit(1);
  }
  process.stdout.write(genesisToml());
}

/** The genesis zombienet config, with PPN_PARACHAINS and ENABLE_HOP applied. */
export function genesisToml(): string {
  const net = loadCurrentNetwork();
  const parachains = (process.env.PPN_PARACHAINS || net.parachains.map((p) => p.key).join(','))
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean) as Parachain[];
  const enableHop = (process.env.ENABLE_HOP || 'true').toLowerCase() !== 'false';

  const header =
    '# DO NOT EDIT — regenerate with: make generate-toml\n# Source: packages/network-config/src/toml-generator.ts\n\n';
  return header + generateToml(parachains, { enableHop });
}
