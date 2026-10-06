// config/secrets.env.example is the list of keys a secrets file may hold, in three sections:
// always, deployable and optional. Everything here reads that file; nothing lists keys itself.

import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from '@parity/ppn-network-config';

export type Section = 'always' | 'deployable' | 'optional';

/** The keys of each section of the example, in file order. */
export function secretSections(file = path.join(repoRoot(), 'config', 'secrets.env.example')): Record<Section, string[]> {
  const sections: Record<Section, string[]> = { always: [], deployable: [], optional: [] };
  let current: Section | null = null;
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    const heading = line.match(/^# ---- (\w+) ----$/);
    if (heading) {
      if (!(heading[1] in sections)) throw new Error(`${file}: unknown section "${heading[1]}"`);
      current = heading[1] as Section;
      continue;
    }
    const key = line.match(/^([A-Z_][A-Z0-9_]*)=/)?.[1];
    if (!key) continue;
    if (!current) throw new Error(`${file}: ${key} is outside a section`);
    sections[current].push(key);
  }
  return sections;
}

/** The keys a file must hold, non-empty, under `profile`. */
export function requiredSecrets(profile: string): string[] {
  const s = secretSections();
  return profile === 'deployable' ? [...s.always, ...s.deployable] : s.always;
}

/** What is wrong with a secrets file's contents; empty when nothing is. */
export function checkSecrets(values: Record<string, string>): string[] {
  const s = secretSections();
  const profile = values['PPN_PROFILE'];
  if (profile !== 'local' && profile !== 'deployable') {
    return [`PPN_PROFILE: must be local or deployable, not "${profile ?? ''}"`];
  }
  const required = requiredSecrets(profile);
  const allowed = new Set([...required, ...s.optional]);
  const problems: string[] = [];
  for (const key of required) {
    if (!values[key]) problems.push(`${key}: missing`);
  }
  for (const key of Object.keys(values)) {
    if (allowed.has(key)) continue;
    problems.push(
      s.deployable.includes(key)
        ? `${key}: deployable only, and this file is local`
        : `${key}: not in config/secrets.env.example`
    );
  }
  return problems;
}
