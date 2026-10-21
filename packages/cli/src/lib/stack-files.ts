// What `ppn service trinity-stack` writes into the data directory, and the dashboard serves.

/** The descriptor's bytes, served as-is at /.well-known/trinity-stack.json. */
export const STACK_FILE = 'trinity-stack.json';

/** The publish state, the generation, and the pointer and link the dashboard shows. */
export const STACK_STATE_FILE = 'trinity-stack.state.json';

/** A chain's light-client spec, next to its raw spec `<name>.json`. */
export const lightSpecFile = (specName: string) => `${specName}.smol.json`;

export interface StackStateFile {
  generation: string;
  state: { sequence: number; contentHash: string };
  pointer: { url: string; key?: string };
  link: string;
}
