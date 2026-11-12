/** The flag an arg sets: `--rpc-port` for `--rpc-port=9944`, and `-l` for every `-l…`/`--log` arg. */
export function flagOf(arg: string): string {
  return /^(-l|--log(=|$))/.test(arg) ? '-l' : arg.split('=')[0];
}

/** `args` plus the flags of `extra` it does not set already, so defaults never override. */
export function addMissing(args: string[], extra: string[]): string[] {
  const present = new Set(args.map(flagOf));
  return [...args, ...extra.filter((arg) => !present.has(flagOf(arg)))];
}

/** `args` with each flag `extra` also sets taking extra's value, and extra's other flags appended. */
export function overrideArgs(args: string[], extra: string[]): string[] {
  const byFlag = new Map(extra.map((arg) => [flagOf(arg), arg]));
  const present = new Set(args.map(flagOf));
  return [...args.map((arg) => byFlag.get(flagOf(arg)) ?? arg), ...extra.filter((arg) => !present.has(flagOf(arg)))];
}
