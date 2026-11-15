import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { waitForGenesisHash } from '../src/commands/turn.js';

const GENESIS = `0x${'ab'.repeat(32)}`;

/** A People RPC that fails `failures` requests before answering chain_getBlockHash(0). */
async function startPeopleRpc(failures: number): Promise<{ url: string; close: () => void }> {
  let seen = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (seen++ < failures) return res.destroy();
      const { method, params } = JSON.parse(body);
      assert.deepEqual([method, params], ['chain_getBlockHash', [0]]);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: GENESIS }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

describe('waitForGenesisHash', () => {
  // dub-api starts beside the chains, so People may not answer yet; turn-api exits at start
  // when the proof route is on and no genesis is set, and nothing restarts dub-api if it exits.
  it('waits for People to answer', async () => {
    const rpc = await startPeopleRpc(3);
    try {
      assert.equal(await waitForGenesisHash(rpc.url, async () => {}), GENESIS);
    } finally {
      rpc.close();
    }
  });
});
