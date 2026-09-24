// Tests for packages/network-config/src/turn.ts
// Run with: tsx --test tests/turn.test.ts

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { LOCAL_TURN_SECRET, eturnalConfig, nginxTurnStream, turnPorts, turnSecret } from '../src/turn.js';

describe('turnSecret', () => {
  it('falls back to the public dev secret locally', () => {
    assert.deepEqual(turnSecret(undefined, false), {
      base64: LOCAL_TURN_SECRET,
      plain: 'ppn-local-turn-secret',
    });
  });

  it('refuses to run a deployment on the dev secret', () => {
    assert.throws(() => turnSecret(undefined, true), /TURN_SECRET is not set/);
  });

  // turn-api keys the HMAC with the decoded bytes, eturnal with its secret string: one
  // secret, two readers, and they only agree on a printable string.
  it('rejects secrets that do not decode to printable ASCII', () => {
    assert.throws(() => turnSecret('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=', false), /printable ASCII/);
    assert.throws(() => turnSecret('not base64!', false), /printable ASCII/);
  });

  it('gives eturnal the key turn-api signs with', () => {
    const { base64, plain } = turnSecret(Buffer.from('s3cret-str1ng').toString('base64'), true);
    const user = '1784757652:0a0a0a0a0a0a0a0a';
    const apiSide = crypto.createHmac('sha1', Buffer.from(base64, 'base64')).update(user).digest('base64');
    const relaySide = crypto.createHmac('sha1', plain).update(user).digest('base64');
    assert.equal(apiSide, relaySide);
  });
});

describe('eturnalConfig', () => {
  it('whitelists loopback peers on a laptop and relays from the listen address', () => {
    const yml = eturnalConfig({ listenIp: '127.0.0.1', runDir: '/tmp/run' });
    assert.match(yml, /whitelist_peers:\n {4}- "127\.0\.0\.1"/);
    assert.match(yml, /relay_ipv4_addr: "127\.0\.0\.1"/);
    assert.match(yml, /realm: "previewnet\.local"/);
  });

  it('keeps the public listener direct and the PROXY-protocol one on loopback', () => {
    const yml = eturnalConfig({ listenIp: '203.0.113.4', runDir: '/tmp/run' });
    assert.ok(!yml.includes('whitelist_peers'));
    assert.match(yml, /ip: "203\.0\.113\.4"\n {6}port: 3478\n {6}transport: udp/);
    assert.match(yml, /ip: "127\.0\.0\.1"\n {6}port: 3479\n {6}transport: tcp\n {6}proxy_protocol: true/);
    assert.match(yml, /relay_min_port: 49152\n {2}relay_max_port: 49407/);
  });

  it('never writes the secret to disk', () => {
    assert.ok(!/secret/.test(eturnalConfig({ listenIp: '127.0.0.1', runDir: '/tmp/run' })));
  });
});

describe('nginxTurnStream', () => {
  it('terminates TLS and forwards with the PROXY protocol', () => {
    const block = nginxTurnStream();
    assert.match(block, new RegExp(`listen ${turnPorts().tls} ssl;`));
    assert.match(block, new RegExp(`server 127\\.0\\.0\\.1:${turnPorts().proxy};`));
    assert.match(block, /proxy_protocol on;/);
  });
});
