// A deployment's own shape for a network, without a release of the engine: RPC nodes in front of
// a chain, or different flags on its nodes. Keyed by network, so loading another network (as
// `ppn networks` does) is unaffected by a section written for this one.
//
//   PPN_NETWORK_OVERLAY=/etc/ppn/network-overlay.json
//   { "previewnet": {
//       "relay": { "extraArgs": ["--rpc-max-connections=2000"] },
//       "parachains": { "people": { "rpcNodes": 2, "rpcNodeArgs": ["--rpc-max-connections=5000"] } } } }

import fs from 'node:fs';
import { overrideArgs } from './args.js';
import { listNetworks, parseArgs, parseRpcNodes, type NetworkDef } from './networks.js';

const RELAY_FIELDS = ['extraArgs'];
const PARACHAIN_FIELDS = ['extraArgs', 'rpcNodes', 'rpcNodeArgs'];

/**
 * `net` with the overlay file's section for it applied: its extraArgs and rpcNodeArgs override
 * the descriptor's flag by flag, and rpcNodes replaces the count. Throws on an unreadable file,
 * an unknown network, chain or field, or a value the descriptor itself would reject.
 */
export function applyOverlay(net: NetworkDef, file: string): NetworkDef {
  const bad = (why: string): never => {
    throw new Error(`${file}: ${why}`);
  };
  let raw: Record<string, any>;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (error) {
    return bad(`cannot read the network overlay: ${(error as Error).message}`);
  }
  const object = (at: string, value: unknown, fields?: string[]): Record<string, any> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) bad(`${at || 'the file'} must be a JSON object`);
    const unknown = fields ? Object.keys(value as object).filter((k) => !fields.includes(k)) : [];
    if (unknown.length) bad(`${at} has unknown fields ${unknown.join(', ')} (allowed: ${fields!.join(', ')})`);
    return value as Record<string, any>;
  };

  object('', raw);
  const networks = listNetworks();
  const strangers = Object.keys(raw).filter((name) => !networks.includes(name));
  if (strangers.length) bad(`unknown networks ${strangers.join(', ')} (known: ${networks.join(', ')})`);
  if (raw[net.name] === undefined) return net;

  const section = object(net.name, raw[net.name], ['relay', 'parachains']);
  const relay = object(`${net.name}.relay`, section.relay ?? {}, RELAY_FIELDS);
  const parachains = object(`${net.name}.parachains`, section.parachains ?? {});
  const declared: string[] = net.parachains.map((p) => p.key);
  const undeclared = Object.keys(parachains).filter((key) => !declared.includes(key));
  if (undeclared.length) {
    bad(`${net.name} has no parachains ${undeclared.join(', ')} (declared: ${declared.join(', ')})`);
  }

  return {
    ...net,
    relay: {
      ...net.relay,
      extraArgs: overrideArgs(net.relay.extraArgs, parseArgs(`${net.name}.relay.extraArgs`, relay.extraArgs, bad)),
    },
    parachains: net.parachains.map((p) => {
      if (parachains[p.key] === undefined) return p;
      const at = `${net.name}.parachains.${p.key}`;
      const chain = object(at, parachains[p.key], PARACHAIN_FIELDS);
      return {
        ...p,
        extraArgs: overrideArgs(p.extraArgs, parseArgs(`${at}.extraArgs`, chain.extraArgs, bad)),
        rpcNodes: chain.rpcNodes === undefined ? p.rpcNodes : parseRpcNodes(`${at}.rpcNodes`, chain.rpcNodes, bad),
        rpcNodeArgs: overrideArgs(p.rpcNodeArgs, parseArgs(`${at}.rpcNodeArgs`, chain.rpcNodeArgs, bad)),
      };
    }),
  };
}
