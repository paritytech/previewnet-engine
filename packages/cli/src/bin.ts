#!/usr/bin/env node
// The `ppn` executable. Everything it can do lives in ./cli.ts; this only hands off argv.
//
// One thing has to happen first. The launchers and the neutral defaults ship in *this* package,
// while the code that reads them ships in @parity/ppn-network-config — so that library cannot
// find them by looking outward from itself: once installed, it only ever reaches node_modules.
// This file is inside the package that carries the data, so it is the one place that can say
// where the data is. In a checkout it resolves to the repo root and changes nothing.
//
// argv[1] is not a substitute: npm installs the bin as a symlink under node_modules/.bin, so
// walking up from it lands in the consumer's project, not in this package.

import fs from 'node:fs';
import path from 'node:path';

if (!process.env.PPN_PACKAGE_ROOT) {
  let dir = import.meta.dirname;
  for (let i = 0; i < 8; i++) {
    if (
      fs.existsSync(path.join(dir, 'config', 'ports.env')) &&
      fs.existsSync(path.join(dir, 'scripts'))
    ) {
      process.env.PPN_PACKAGE_ROOT = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

const { main } = await import('./cli.js');
await main(process.argv.slice(2));
