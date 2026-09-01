#!/usr/bin/env node
// `ppn` — the single entry point. Everything this project does, other than deploying to a
// server, is a subcommand. See docs/ARCHITECTURE.md for why it is shaped this way.
//
// This launcher exists so the shell scripts and the Makefile have one stable path to call.
// All the logic lives in packages/cli, and everything it knows about a network comes from
// packages/network-config.

import fs from 'node:fs';
import path from 'node:path';

const CLI = path.join(import.meta.dirname, '..', 'packages', 'cli', 'dist', 'cli.js');

if (!fs.existsSync(CLI)) {
  console.error('ppn: not built — run `make build`');
  process.exit(1);
}

const { main } = await import(CLI);
await main(process.argv.slice(2));
