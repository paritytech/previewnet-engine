// Composing a network as it will actually run.
//
// Split out of networks.ts to break a cycle: the descriptor parser has no business knowing
// about overrides, and the override rules need the descriptor's types. This module is the only
// one that knows both, and it is what the package exports as `loadNetwork`.

import { loadDescriptor, currentNetworkName, type NetworkDef } from './networks.js';
import { applyOverrides, effectiveOverrides, type OverrideSet } from './overrides.js';

/**
 * A network as it will actually run: the descriptor, with any --release/--binary overrides
 * applied. Every command goes through here, so none of them can disagree about which binary
 * comes from where. `extra` carries flag overrides; the environment is always consulted.
 */
export function loadNetwork(name: string, extra?: OverrideSet): NetworkDef {
  return applyOverrides(loadDescriptor(name), effectiveOverrides(extra));
}

/** The descriptor exactly as checked in, overrides ignored. For drift checks and tests. */
export function loadDescriptorOnly(name: string): NetworkDef {
  return loadDescriptor(name);
}

export function loadCurrentNetwork(): NetworkDef {
  return loadNetwork(currentNetworkName());
}
