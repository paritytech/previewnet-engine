// Sudo signing URI resolution, shared with the profile scheme in docs/PROFILES.md:
// explicit env wins, then the deployable profile's secrets file, then //Alice — which is
// sudo on every chain of a local or forked PPN network (the bite overrides Sudo::Key).
//
// Pure text-in, string-out so it is testable; reading the file is the caller's job.

export function parseEnvFile(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    vars[m[1]] = m[2].replace(/^["'](.*)["']$/, '$1');
  }
  return vars;
}

export function resolveSudoUri(
  envUri: string | undefined,
  secretsText: string | null
): string {
  if (envUri) return envUri;
  if (secretsText) {
    const uri = parseEnvFile(secretsText).PPN_SUDO_URI;
    if (uri) return uri;
  }
  return '//Alice';
}
