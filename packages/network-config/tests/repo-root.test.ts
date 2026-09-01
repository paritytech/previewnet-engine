// The repo root has to be found, not counted to.
//
// Counting `..` from import.meta.dirname shipped two bugs in one session: a fork config that
// pointed zombienet at `packages/bin/polkadot`, and a `generate` that defaulted its output to
// `packages/bin/` — the second invisible locally, because make passes the path explicitly,
// and reachable only on the server, where it does not.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { repoRoot, packageRoot, workspaceRoot, networksDirs, defaultHome } from '../src/repo-root.js';

const ROOT = repoRoot();

describe('repoRoot', () => {
  it('lands on the directory that actually holds the repo', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'networks')));
    assert.ok(fs.existsSync(path.join(ROOT, 'config', 'ports.env')));
    assert.ok(fs.existsSync(path.join(ROOT, 'pnpm-workspace.yaml')));
    assert.notEqual(path.basename(ROOT), 'packages');
  });

  // Every caller sits at a different depth, and the same file resolves from src/ under tsx
  // and from dist/ after a build. All of them must agree.
  it('gives the same answer from every depth a caller can run at', () => {
    const depths = [
      'packages/network-config/src',
      'packages/network-config/dist',
      'packages/cli/dist/commands',
      'packages/cli/src/commands',
    ];
    for (const rel of depths) {
      assert.equal(repoRoot(path.join(ROOT, rel)), ROOT, `wrong root from ${rel}`);
    }
  });

  // A useless starting point is not fatal any more, and should not be: once published, the
  // code and the data live in different packages, so the search tries the entry point and the
  // working directory too. What must never happen is returning a directory that lacks the
  // markers — a wrong root reads the wrong defaults silently.
  it('falls back to another candidate rather than returning a wrong root', () => {
    const resolved = repoRoot(path.parse(ROOT).root);
    assert.equal(resolved, ROOT);
    assert.ok(fs.existsSync(path.join(resolved, 'config', 'ports.env')));
    assert.ok(fs.existsSync(path.join(resolved, 'scripts')));
  });

  it('prefers PPN_PACKAGE_ROOT, the explicit answer for an unusual layout', () => {
    const saved = process.env.PPN_PACKAGE_ROOT;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ppn-pkg-'));
    fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'config', 'ports.env'), 'RELAY_ALICE_PORT=10000\n');
    fs.mkdirSync(path.join(tmp, 'scripts'));
    process.env.PPN_PACKAGE_ROOT = tmp;
    try {
      assert.equal(packageRoot(), tmp);
    } finally {
      if (saved === undefined) delete process.env.PPN_PACKAGE_ROOT;
      else process.env.PPN_PACKAGE_ROOT = saved;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('packageRoot vs workspaceRoot', () => {
  // The split exists so the tool can run from node_modules while a run's state and network
  // definitions stay wherever the caller keeps them. In a checkout they must stay identical,
  // or every existing path silently moves.
  it('are the same directory in a checkout', () => {
    assert.equal(packageRoot(), ROOT);
    assert.equal(workspaceRoot(), ROOT);
  });

  // The package-root fallback distinguishes a checkout from an install. A checkout reached
  // through the entry point is a workspace even when the cwd is elsewhere — zombienet's custom
  // processes run from the spawn's temp tree, and they must still find the repo. An installed
  // package (under node_modules) never is: it is replaced wholesale by the next
  // `npm install -g`, so state — 540 MB of bin/, a chain database — goes to the per-user home.
  it('falls back to a checkout, or to the per-user home — never into node_modules', () => {
    const savedHome = process.env.PPN_HOME;
    const savedXdg = process.env.XDG_DATA_HOME;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ppn-userhome-'));
    const neutral = fs.mkdtempSync(path.join(os.tmpdir(), 'ppn-neutral-'));
    // A fake *installed* package: a package root that lives under node_modules and, like the
    // published CLI, ships descriptors.
    const installed = path.join(tmp, 'node_modules', '@parity', 'ppn');
    fs.mkdirSync(path.join(installed, 'config'), { recursive: true });
    fs.writeFileSync(path.join(installed, 'config', 'ports.env'), '# marker\n');
    fs.mkdirSync(path.join(installed, 'networks'), { recursive: true });
    try {
      delete process.env.PPN_HOME;
      process.env.XDG_DATA_HOME = tmp;
      assert.equal(defaultHome(), path.join(tmp, 'ppn'));

      // These tests run inside the checkout: the entry point anchors packageRoot at the repo,
      // which has networks/ and is not under node_modules — so it wins over the user home.
      assert.equal(workspaceRoot(neutral), ROOT);

      // Anchored at an installed copy instead, the same call must refuse the package and land
      // on the user home, descriptors or not.
      process.env.PPN_PACKAGE_ROOT = installed;
      assert.equal(workspaceRoot(neutral), path.join(tmp, 'ppn'));
    } finally {
      delete process.env.PPN_PACKAGE_ROOT;
      if (savedHome === undefined) delete process.env.PPN_HOME;
      else process.env.PPN_HOME = savedHome;
      if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = savedXdg;
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(neutral, { recursive: true, force: true });
    }
  });

  it('follows PPN_HOME for the workspace, leaving the package where it is', () => {
    const saved = process.env.PPN_HOME;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ppn-home-'));
    fs.mkdirSync(path.join(tmp, 'networks'));
    process.env.PPN_HOME = tmp;
    try {
      assert.equal(workspaceRoot(), tmp);
      assert.equal(packageRoot(), ROOT, 'the package must not move with PPN_HOME');
      // Both are searched, workspace first, so a workspace adds networks without hiding any.
      assert.deepEqual(networksDirs(), [path.join(tmp, 'networks'), path.join(ROOT, 'networks')]);
    } finally {
      if (saved === undefined) delete process.env.PPN_HOME;
      else process.env.PPN_HOME = saved;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports one directory when they coincide, not the same one twice', () => {
    assert.deepEqual(networksDirs(), [path.join(ROOT, 'networks')]);
  });
});
