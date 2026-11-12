/** The flag an arg sets: `--rpc-port` for `--rpc-port=9944`, and `-l` for every `-l…`/`--log` arg. */
export function flagOf(arg: string): string {
  return /^(-l|--log(=|$))/.test(arg) ? '-l' : arg.split('=')[0];
}

/** `args` plus the flags of `extra` it does not set already, so defaults never override. */
export function addMissing(args: string[], extra: string[]): string[] {
  const present = new Set(args.map(flagOf));
  return [...args, ...extra.filter((a) => !present.has(flagOf(a)))];
}

/** `args` with each flag `extra` also sets taking extra's value, and extra's other flags appended. */
export function overrideArgs(args: string[], extra: string[]): string[] {
  const byFlag = new Map(extra.map((a) => [flagOf(a), a]));
  const present = new Set(args.map(flagOf));
  return [...args.map((a) => byFlag.get(flagOf(a)) ?? a), ...extra.filter((a) => !present.has(flagOf(a)))];
}
