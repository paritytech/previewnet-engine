import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { loadNetwork } from '@parity/ppn-network-config';
import { peopleGenesis, turnProofEnv } from '../src/commands/turn.js';
import type { ServiceContext } from '../src/commands/service-context.js';

const GENESIS = `0x${'ab'.repeat(32)}`;

/** A People RPC that fails `failures` requests before answering chain_getBlockHash(0). */
async function people(failures: number): Promise<{ url: string; port: number; close: () => void }> {
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
  const port = (server.address() as AddressInfo).port;
  return { url: `ws://127.0.0.1:${port}`, port, close: () => server.close() };
}

describe('peopleGenesis', () => {
  // dub-api starts beside the chains, so People may not answer yet; turn-api refuses to boot
  // with proof issuance on and no genesis.
  it('waits for People to answer', async () => {
    const rpc = await people(2);
    try {
      assert.equal(await peopleGenesis(rpc.url, 5, 10), GENESIS);
    } finally {
      rpc.close();
    }
  });

  it('fails once People has not answered in time', async () => {
    const rpc = await people(10);
    try {
      await assert.rejects(peopleGenesis(rpc.url, 3, 10), /no genesis hash from ws:\/\/127\.0\.0\.1/);
    } finally {
      rpc.close();
    }
  });
});

describe('turnProofEnv', () => {
  const ctx = (network: string, ports: Record<string, string>) =>
    ({ net: loadNetwork(network), ports }) as unknown as ServiceContext;

  // Jollity proves as dim2.testnet on previewnet; without these settings turn-api answers its
  // issue-with-proof call with a 404.
  it("enables the proof route for the network file's products, against local People", async () => {
    const rpc = await people(0);
    try {
      assert.deepEqual(await turnProofEnv(ctx('previewnet', { PEOPLE_PORT: String(rpc.port), PPN_TURN_PROOF_PRODUCTS: '' })), {
        TURN_PROOF_ENABLED: 'true',
        TURN_PROOF_RPC_URL: rpc.url,
        TURN_PROOF_PRODUCTS: 'dim2.testnet',
        TURN_PROOF_GENESIS: GENESIS,
      });
    } finally {
      rpc.close();
    }
  });

  it('takes the products a deployment sets in ports.env over the network file', async () => {
    const rpc = await people(0);
    try {
      const env = await turnProofEnv(ctx('previewnet', { PEOPLE_PORT: String(rpc.port), PPN_TURN_PROOF_PRODUCTS: 'dim2.testnet, vox.testnet' }));
      assert.equal(env.TURN_PROOF_PRODUCTS, 'dim2.testnet,vox.testnet');
    } finally {
      rpc.close();
    }
  });

  it('leaves the route off for a network without products', async () => {
    assert.deepEqual(await turnProofEnv(ctx('polkadot', { PEOPLE_PORT: '1' })), {});
  });
});
