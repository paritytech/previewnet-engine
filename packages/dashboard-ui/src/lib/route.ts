// Where you are, in the URL.
//
// The dashboard is one index.html, served at `/` locally and behind nginx on a server, so the
// route lives in the fragment rather than the path. A path like /logs would miss the static
// handler and 404, and on a server it would sit in the same namespace as the chain routes the
// model owns (/asset-hub, /relay/alice, /ipfs). A fragment reaches neither.
//
// Shape: `#<tab>`, with an optional second segment the tab itself owns — `#logs/<id>` reopens
// one stream. Parsing lives here, apart from the components, because a fragment is
// user-editable input: it can name a tab that does not exist, a log that has been rotated
// away, or nothing at all, and every one of those has to land somewhere sensible.

/** Segments of the fragment, with the leading `#` and any leading slash removed. */
function segments(hash: string): string[] {
  return hash.replace(/^#\/?/, '').split('/');
}

/**
 * The tab a fragment names, or the fallback when it names nothing valid. Callers pass their own
 * tab list so this module does not need to know what the tabs are.
 */
export function tabOf<T extends string>(hash: string, tabs: readonly T[], fallback: T): T {
  const first = segments(hash)[0];
  return (tabs as readonly string[]).includes(first) ? (first as T) : fallback;
}

/**
 * The log id in `#logs/<id>`, or null. Returns whatever was in the fragment — the caller checks
 * it against the whitelist the API returned, because only the server knows what exists.
 */
export function logIdOf(hash: string): string | null {
  const parts = segments(hash);
  if (parts[0] !== 'logs' || !parts[1]) return null;
  try {
    return decodeURIComponent(parts[1]);
  } catch {
    // A hand-mangled escape (`%zz`) throws rather than returning garbage; treat it as absent.
    return null;
  }
}

/** The fragment for a tab, or for one log within the logs tab. */
export function fragmentFor(tab: string, logId?: string): string {
  return logId ? `#${tab}/${encodeURIComponent(logId)}` : `#${tab}`;
}
