// Composing a network as it will actually run.
//
// Split out of networks.ts to break a cycle: the descriptor parser has no business knowing
// about overrides, and the override rules need the descriptor's types. This module is the only
// one that knows both, and it is what the package exports as `loadNetwork`.

import { loadDescriptor, currentNetworkName, type NetworkDef } from './networks.js';
import { applyOverrides, effectiveOverrides, type OverrideSet } from './overrides.js';
import { applyOverlay } from './overlay.js';

/**
 * A network as it will actually run: the descriptor, with any --release/--binary overrides
 * and the PPN_NETWORK_OVERLAY file applied. Every command goes through here, so none of them
 * can disagree about which binary comes from where or which nodes run. `extra` carries flag
 * overrides; the environment is always consulted.
 */
export function loadNetwork(name: string, extra?: OverrideSet): NetworkDef {
  const net = applyOverrides(loadDescriptor(name), effectiveOverrides(extra));
  const overlay = process.env.PPN_NETWORK_OVERLAY;
  return overlay ? applyOverlay(net, overlay) : net;
}

/** The descriptor exactly as checked in, overrides ignored. For drift checks and tests. */
export function loadDescriptorOnly(name: string): NetworkDef {
  return loadDescriptor(name);
}

export function loadCurrentNetwork(): NetworkDef {
  return loadNetwork(currentNetworkName());
}
