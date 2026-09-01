// What every `ppn service` handler receives. Its own module so a handler can import the
// type without importing the dispatch table — which dynamically imports the handlers back,
// and a type-only import still counts as a cycle to the boundary rules.

import type { NetworkDef } from '@parity/ppn-network-config';

export interface ServiceContext {

  net: NetworkDef;
  /** config/ports.env merged with the gitignored ports.local.env `make start` writes. */
  ports: Record<string, string>;
  /** Node binaries: $BIN when `make start` set it, else bin/ or bin/<network>. */
  binDir: string;
  /** Shared tooling (ipfs, postgres) always lives in plain bin/, one level up. */
  sharedBinDir: string;
  relayWs: string;
  /** Sudo signing URI: the deployable profile's operator key, else //Alice. */
  sudoUri: string;
}
