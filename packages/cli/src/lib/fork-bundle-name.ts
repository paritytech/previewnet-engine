// The name of a network's fork bundle — one definition, used by the directory `ppn bite`
// writes, the release asset the nightly bite publishes, and everything that reads either.
//
// Every network is named, previewnet included. It used to be the exception: its bundle was
// the unsuffixed `fork-bundle.tar.gz` while everyone else got `fork-bundle-<network>`. That
// encoded an assumption this repo has no business making — for forking, the network behind
// previewnet.substrate.dev is just another source, no more the engine's own than dot.li is —
// and it read as "the obvious bundle" only to someone who already knew that host existed.
//
// Three commands derived the name independently, which is how the exception survived a
// refactor: fixing one site left the others disagreeing. It lives here so there is one.

/** Directory and asset stem for a network's bundle, e.g. `fork-bundle-previewnet`. */
export function forkBundleName(network: string): string {
  return `fork-bundle-${network}`;
}

/** The published release asset, e.g. `fork-bundle-previewnet.tar.gz`. */
export function forkBundleAsset(network: string): string {
  return `${forkBundleName(network)}.tar.gz`;
}
