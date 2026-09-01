// The chain keys and the descriptor types live in core/networks.ts, next to the
// validation that enforces them; re-exported here because most of the codebase reaches
// for them through this module.
import type { Parachain, ChainKey } from './networks.js';
export type { Parachain, ChainKey };
export { PARACHAIN_KEYS } from './networks.js';
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export interface ChainDef {
  required: string[];
  defaultLogs: Record<string, LogLevel>;
}

export interface GenerateTomlOptions {
  logTargets?: Partial<Record<ChainKey, Record<string, LogLevel>>>;
  relayWasmOverrides?: string;
  enableHop?: boolean;
}
