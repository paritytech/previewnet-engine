// The Node-side WS provider, kept out of upgrade.ts so that module stays browser-clean
// (a browser bundle would use polkadot-api/ws-provider/web instead).

import { getWsProvider } from 'polkadot-api/ws-provider/node';

export function wsProvider(url: string): ReturnType<typeof getWsProvider> {
  return getWsProvider(url);
}
