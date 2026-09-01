// Tests for src/lib/route.ts
//
// The fragment is user-editable input — typed in an address bar, pasted from chat, left over
// from an older build. Every malformed shape has to land on a real page rather than render
// blank, so the fallbacks are the contract here, not an afterthought.

import { describe, it, expect } from 'vitest';
import { tabOf, logIdOf, fragmentFor } from './route';

const TABS = ['overview', 'provenance', 'logs'] as const;
const tab = (hash: string) => tabOf(hash, TABS, 'overview');

describe('tabOf', () => {
  it('reads the tab a fragment names', () => {
    expect(tab('#overview')).toBe('overview');
    expect(tab('#provenance')).toBe('provenance');
    expect(tab('#logs')).toBe('logs');
  });

  it('ignores a second segment belonging to the tab', () => {
    expect(tab('#logs/alice-paseo-validator')).toBe('logs');
  });

  it('tolerates a leading slash, as some clients add when rewriting links', () => {
    expect(tab('#/logs')).toBe('logs');
    expect(tab('#/logs/eth-rpc')).toBe('logs');
  });

  it('falls back to overview for anything it does not recognise', () => {
    for (const hash of ['', '#', '#/', '#nope', '#Logs', '#logs2', '#../etc/passwd', '#%%%']) {
      expect(tab(hash), `hash ${JSON.stringify(hash)}`).toBe('overview');
    }
  });
});

describe('logIdOf', () => {
  it('reads the log id from the logs fragment', () => {
    expect(logIdOf('#logs/alice-paseo-validator')).toBe('alice-paseo-validator');
    expect(logIdOf('#/logs/eth-rpc')).toBe('eth-rpc');
  });

  it('is null when no log is named, or another tab is open', () => {
    expect(logIdOf('#logs')).toBe(null);
    expect(logIdOf('#logs/')).toBe(null);
    expect(logIdOf('#overview/alice')).toBe(null);
    expect(logIdOf('')).toBe(null);
  });

  it('decodes an escaped id, and refuses a mangled escape instead of throwing', () => {
    expect(logIdOf('#logs/eth%2Drpc')).toBe('eth-rpc');
    // decodeURIComponent throws on this; a blank logs tab beats an uncaught error.
    expect(logIdOf('#logs/%zz')).toBe(null);
  });
});

describe('fragmentFor', () => {
  it('round-trips a tab, and a log within the logs tab', () => {
    expect(fragmentFor('provenance')).toBe('#provenance');
    expect(fragmentFor('logs', 'alice-paseo-validator')).toBe('#logs/alice-paseo-validator');
    expect(logIdOf(fragmentFor('logs', 'dub-api'))).toBe('dub-api');
    expect(tab(fragmentFor('logs', 'dub-api'))).toBe('logs');
  });
});
