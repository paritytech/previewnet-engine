// Which chain does a runtime upgrade target, and where does it listen locally?
//
// Ports come from the same table the zombienet configs are generated from
// (toml-generator reads config/ports.env), so an upgrade can never be aimed at a port
// nothing was told to listen on. Chain keys match the spawner's runtime-upload keys.

import { PORTS, RELAY_BASE_PORT, VALID_PARACHAINS } from '@parity/ppn-network-config';
import type { ChainKey, Parachain } from '@parity/ppn-network-config';

export const UPGRADE_CHAINS: ChainKey[] = ['relay', ...VALID_PARACHAINS];

/** Default WS endpoint of a chain on a locally running network. */
export function localWsUrl(chain: string): string {
  if (chain === 'relay') return `ws://127.0.0.1:${RELAY_BASE_PORT}`;
  if ((VALID_PARACHAINS as string[]).includes(chain)) {
    return `ws://127.0.0.1:${PORTS[chain as Parachain]}`;
  }
  throw new Error(`unknown chain "${chain}" — expected one of: ${UPGRADE_CHAINS.join(', ')}`);
}
