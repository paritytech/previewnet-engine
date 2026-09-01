// What the published packages contain.
//
// Two things are being defended here.
//
// **The CLI ships the networks it can run.** `ppn` is an engine, and an engine with no
// descriptor cannot do anything: a fresh `npm i -g @parity/ppn` used to install, run, and fail
// with "no networks/ directory found", leaving the user to find a descriptor by hand from a
// repo they may not have. So the descriptors travel with the CLI.
//
// They name deployment endpoints (previewnet.substrate.dev), which an earlier revision
// deliberately kept out of a public tarball. That constraint has been dropped: the sources are
// public, and the address of a preview network is not a secret. The *library* still ships none
// — it is a config reader, and a consumer of it brings its own.
//
// **The package is complete.** zombienet's custom_processes exec a command path, so the
// launchers have to be inside the tarball or an installed `ppn start` dies on the first
// service. `files` being package-relative while those live at the repo root is precisely the
// trap: they are staged by `prepack`, and if that ever stops working the package still packs,
// just uselessly.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');

/** Anything that identifies where this network is actually deployed. */
const MUST_NOT_APPEAR = [/previewnet\.substrate\.dev/i, /pdp-stg-scw\.parity\.io/i];

interface Packed {
  files: string[];
  tarball: string;
  read: (rel: string) => string;
  /** Permission bits as unpacked, for the executable-bit check. */
  mode: (rel: string) => number;
  grepAll: (pattern: RegExp) => string[];
}

let tmp: string;

/** Pack a workspace package the way CI does, unpack it, and hand back what is inside. */
function pack(pkgDir: string): Packed {
  const dest = fs.mkdtempSync(path.join(tmp, 'pack-'));
  // pnpm, not npm: it resolves `workspace:*` to the real version at pack time. Packing with
  // npm publishes the protocol verbatim and every consumer install dies with
  // EUNSUPPORTEDPROTOCOL, so the guard has to pack the way CI does.
  execFileSync('pnpm', ['pack', '--pack-destination', dest], {
    cwd: path.join(REPO, pkgDir),
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const tgz = fs.readdirSync(dest).find((f) => f.endsWith('.tgz'));
  assert.ok(tgz, `no tarball produced for ${pkgDir}`);
  const out = path.join(dest, 'unpacked');
  fs.mkdirSync(out);
  execFileSync('tar', ['xzf', path.join(dest, tgz!), '-C', out, '--strip-components=1']);

  const files: string[] = [];
  const walk = (dir: string, prefix = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else files.push(rel);
    }
  };
  walk(out);

  return {
    files,
    tarball: path.join(dest, tgz!),
    read: (rel) => fs.readFileSync(path.join(out, rel), 'utf-8'),
    mode: (rel) => fs.statSync(path.join(out, rel)).mode,
    grepAll: (pattern) =>
      files.filter((f) => {
        try {
          return pattern.test(fs.readFileSync(path.join(out, f), 'utf-8'));
        } catch {
          return false; // binary or unreadable — nothing textual to leak
        }
      }),
  };
}

describe('published packages', () => {
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ppn-publish-'));
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  describe('@parity/ppn-network-config', () => {
    it('ships compiled code and its own default ports, nothing else', () => {
      const p = pack('packages/network-config');
      assert.ok(p.files.includes('package.json'));
      // Its own default, needed by the config generators. Without it, anything that reads a
      // port fails in an install that has the library but not the CLI.
      assert.ok(p.files.includes('config/ports.env'), 'config/ports.env is not in the package');
      assert.ok(p.files.some((f) => f === 'dist/index.js'), 'no dist/index.js');
      assert.ok(p.files.some((f) => f === 'dist/index.d.ts'), 'no type declarations');
      assert.equal(p.files.filter((f) => f.startsWith('src/')).length, 0, 'sources leaked');
      assert.equal(p.files.filter((f) => f.includes('.test.')).length, 0, 'tests leaked');
      assert.equal(p.files.filter((f) => f.startsWith('networks/')).length, 0, 'descriptors leaked');
    });

    // Both of these were real: importing the package ran `loadNetwork(previewnet)` and
    // `loadPortsEnv()` at module scope, so a consumer that only wanted the types got an
    // unhandled throw during module evaluation — before any of its own code ran.
    it('imports with no workspace present, doing no work at module scope', () => {
      const p = pack('packages/network-config');
      const dir = fs.mkdtempSync(path.join(tmp, 'import-'));
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', type: 'module' }));
      execFileSync('npm', ['install', '--silent', p.tarball], { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] });
      const out = execFileSync(
        process.execPath,
        ['--input-type=module', '-e', "import * as m from '@parity/ppn-network-config'; console.log(typeof m.loadNetwork);"],
        { cwd: dir, encoding: 'utf-8', env: { ...process.env, PPN_HOME: undefined, PPN_PACKAGE_ROOT: undefined } }
      );
      assert.equal(out.trim(), 'function');
    });

    it('names no deployment endpoint', () => {
      const p = pack('packages/network-config');
      for (const pattern of MUST_NOT_APPEAR) {
        assert.deepEqual(p.grepAll(pattern), [], `${pattern} appears in the tarball`);
      }
    });

    // npm only includes a LICENSE that sits in the package directory, and none is committed
    // there — prepack copies the repo-root file in, postpack removes it. If that staging
    // breaks, the package publishes with a license field and no license text.
    it('ships the license text', () => {
      const p = pack('packages/network-config');
      assert.ok(p.files.includes('LICENSE'), 'LICENSE is not in the package');
    });
  });

  describe('@parity/ppn', () => {
    it('ships the launchers zombienet has to exec', () => {
      const p = pack('packages/cli');
      // If prepack silently stops staging these, an installed `ppn start` brings up nodes and
      // then fails on every custom process.
      for (const launcher of [
        'scripts/omni-node.sh',
        'scripts/eth-rpc.sh',
        'scripts/ipfs-daemon.sh',
        'scripts/patch-bootnodes.sh',
      ]) {
        assert.ok(p.files.includes(launcher), `${launcher} is not in the package`);
      }
      assert.ok(p.files.includes('config/ports.env'), 'config/ports.env is not in the package');
      assert.ok(p.files.some((f) => f === 'dist/bin.js'), 'the bin entry point is missing');
    });

    // `prepack` copies config/ wholesale, so anything the packer's own machine happened to
    // leave there ships too. ports.local.env is written by `ppn start` and holds that machine's
    // absolute data-dir paths and the network it last ran — gitignored precisely because it is
    // not shareable. Shipping it also silently overrides the consumer's network selection.
    it('ships no file generated by a local run', () => {
      const p = pack('packages/cli');
      assert.ok(
        !p.files.includes('config/ports.local.env'),
        'config/ports.local.env (generated by `ppn start`) is in the package'
      );
      assert.equal(
        p.files.filter((f) => f.endsWith('.local.env')).length,
        0,
        'a generated *.local.env leaked into the package'
      );
    });

    // The launchers are exec'd by zombienet from inside node_modules, while the binaries they
    // run live in the *workspace* that `ppn fetch` filled. Resolving bin/ relative to the
    // script's own location therefore points at a directory the package does not contain —
    // and under `set -e` a `cd` into it ends the launcher before any fallback can run. The
    // file-list assertions above cannot see this: the script ships perfectly and still cannot
    // find a single binary.
    it('resolves binaries from the workspace, not from its own directory', () => {
      const p = pack('packages/cli');
      assert.equal(
        p.files.filter((f) => f.startsWith('bin/')).length,
        0,
        'the package ships a bin/ — these assertions assume it does not'
      );
      // The resolution itself lives in scripts/lib/workspace.sh, which every launcher
      // sources; PPN_HOME is consulted there.
      assert.ok(
        /PPN_HOME/.test(p.read('scripts/lib/workspace.sh')),
        'the workspace helper never consults PPN_HOME'
      );
      for (const launcher of ['scripts/omni-node.sh', 'scripts/eth-rpc.sh']) {
        const body = p.read(launcher);
        assert.ok(
          body.includes('lib/workspace.sh'),
          `${launcher} does not source the workspace helper`
        );
        assert.ok(
          !/\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)\/\.\.\/bin" && pwd\)/.test(body),
          `${launcher} resolves bin/ from its own location, which does not exist once installed`
        );
      }
    });

    // Five launchers each grew their own copy of workspace resolution and each broke a
    // different way installed. The rule is now one file; every launcher that touches bin/
    // must source it — and it must ship.
    it('launchers resolve the workspace through the shared helper', () => {
      const p = pack('packages/cli');
      assert.ok(p.files.includes('scripts/lib/workspace.sh'), 'the workspace helper is not in the package');
      const needsBin = p.files.filter((f) => f.startsWith('scripts/') && f.endsWith('.sh'))
        .filter((f) => {
          const body = p.read(f);
          return /BIN_DIR=|REPO_BIN=/.test(body) && f !== 'scripts/lib/workspace.sh';
        });
      for (const l of needsBin) {
        assert.ok(
          p.read(l).includes('lib/workspace.sh'),
          `${l} sets a bin dir without sourcing scripts/lib/workspace.sh — it will resolve into node_modules`
        );
      }
    });

    // npm does not preserve the executable bit outside `bin`, so a launcher that is 0755 in the
    // repo installs as 0644. zombienet execs these by path — it probes each with `--help`
    // before spawning anything — and the failure is `Permission denied (os error 13)` raised
    // inside a Rust panic, pointing at a file that exists and reads correctly. Nothing in a
    // checkout can reproduce it, because there the bit is set by git.
    it('either ships the launchers executable or restores the bit at run time', () => {
      const p = pack('packages/cli');
      const unreadable = p.files.filter(
        (f) => f.startsWith('scripts/') && f.endsWith('.sh') && !(p.mode(f) & 0o111)
      );
      if (unreadable.length > 0) {
        // The tarball lost the bit, so the CLI has to put it back before zombienet looks.
        const start = fs.readFileSync(
          path.join(REPO, 'packages/cli/src/commands/start.ts'),
          'utf-8'
        );
        assert.match(
          start,
          /chmodSync/,
          `${unreadable.length} launcher(s) ship non-executable and nothing chmods them back`
        );
      }
    });

    // The launchers exec the CLI entry point, which is bin/ppn.mjs in a checkout and
    // dist/bin.js in the package (no bin/ ships). A hardcoded checkout path broke every
    // custom_process on an npm install — silently, because zombienet does not gate a spawn
    // on its custom processes: the chains came up, and cores/services just never arrived.
    it('service launchers fall back to the packaged entry point', () => {
      const p = pack('packages/cli');
      const launchers = p.files.filter((f) => f.startsWith('scripts/') && f.endsWith('.sh'));
      for (const l of launchers) {
        const body = p.read(l);
        if (!body.includes('ppn.mjs')) continue;
        assert.ok(
          body.includes('dist/bin.js'),
          `${l} execs bin/ppn.mjs with no dist/bin.js fallback — dead on an npm install`
        );
      }
    });

    // The UI is built output (packages/dashboard-ui -> web/), untracked in git: the tarball
    // is its only distribution, so prepack must build it and the pack must carry it.
    it('ships the compiled dashboard UI', () => {
      const p = pack('packages/cli');
      assert.ok(p.files.includes('web/index.html'), 'web/index.html is not in the package');
      assert.ok(
        p.files.some((f) => /^web\/assets\/index-.+\.js$/.test(f)),
        'no compiled UI bundle in the package'
      );
    });

    it('depends on the library by version, not by workspace protocol', () => {
      const p = pack('packages/cli');
      const deps = JSON.parse(p.read('package.json')).dependencies ?? {};
      for (const [name, range] of Object.entries(deps)) {
        assert.ok(
          !String(range).startsWith('workspace:'),
          `${name} would publish as "${range}", which no consumer can install`
        );
      }
    });

    it('declares a working bin entry', () => {
      const p = pack('packages/cli');
      const manifest = JSON.parse(p.read('package.json'));
      assert.deepEqual(Object.keys(manifest.bin ?? {}), ['ppn']);
      const target = String(manifest.bin.ppn).replace(/^\.\//, '');
      assert.ok(p.files.includes(target), `bin points at ${target}, which is not shipped`);
    });

    // Without these an install is inert: `ppn show`/`start` fail with "no networks/ directory
    // found", and the user has to obtain a descriptor from somewhere before the tool does
    // anything at all. previewnet in particular has to be here — it is the only network that
    // can be spawned from genesis, so it is the only one a fresh install can bring up.
    it('ships the descriptors it can run', () => {
      const p = pack('packages/cli');
      const shipped = p.files.filter((f) => f.startsWith('networks/') && f.endsWith('.json'));
      assert.ok(shipped.length > 0, 'no descriptors in the package — an install cannot run anything');
      assert.ok(
        shipped.includes('networks/previewnet.json'),
        'previewnet is missing, so a fresh install has nothing spawnable from genesis'
      );
      // Each one has to survive the trip intact: the loader refuses a malformed descriptor,
      // and a truncated copy would only surface on someone else's machine.
      for (const f of shipped) JSON.parse(p.read(f));
    });

    // The dashboard resolves its UI relative to its own compiled code — dist/commands/../../web
    // — so `packages/cli/web` has to be inside whatever is installed. The npm tarball gets it
    // from `files`; `ppn dist` needs it listed explicitly, and did not have it: staging served
    // the API and answered `{"error":"not found"}` at /. Nothing else caught that, because every
    // other test runs from a checkout where the directory exists whether it ships or not.
    it('ships the dashboard UI the server serves at /', () => {
      const p = pack('packages/cli');
      assert.ok(p.files.includes('web/index.html'), 'no web/index.html in the npm tarball');
      assert.ok(
        p.files.some((f) => f.startsWith('web/assets/') && f.endsWith('.js')),
        'no built UI bundle in the npm tarball'
      );
    });

    it('leaks no sources, tests or downloaded artifacts', () => {
      const p = pack('packages/cli');
      assert.equal(p.files.filter((f) => f.startsWith('src/')).length, 0, 'sources leaked');
      assert.equal(p.files.filter((f) => f.includes('.test.')).length, 0, 'tests leaked');
      assert.equal(p.files.filter((f) => f.startsWith('bin/')).length, 0, 'bin/ artifacts leaked');
      assert.equal(p.files.filter((f) => f.includes('node_modules')).length, 0, 'node_modules leaked');
    });

    // Same staging as the library: the repo-root LICENSE only reaches the tarball because
    // prepack copies it into the package directory.
    it('ships the license text', () => {
      const p = pack('packages/cli');
      assert.ok(p.files.includes('LICENSE'), 'LICENSE is not in the package');
    });
  });
});
