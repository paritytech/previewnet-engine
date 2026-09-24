import type { NetworkInfo } from "./types/zombienet";
import dgram from "node:dgram";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { entropyToMiniSecret } from "@polkadot-labs/hdkd-helpers";
import { DUB_BASE, waitForDubReady } from "./dub-ready";
import { dubToken } from "./dub-auth";

// The TURN relay end to end: eturnal answers STUN, DUB mints credentials and names the
// servers, and eturnal grants a relay allocation with exactly those credentials. The last
// step is the one that matters: it fails if the two sides disagree about the secret or realm.
//
// No import from ./utils: HTTP, UDP and crypto only.

const SUCCESS = 1 as const;
const FAILURE = 0 as const;

const HOST = "127.0.0.1";
const PORT = 3478;
const EXPECTED_SERVERS = [
  `stun:${HOST}:${PORT}`,
  `turn:${HOST}:${PORT}?transport=udp`,
  `turn:${HOST}:${PORT}?transport=tcp`,
];

const MAGIC = 0x2112a442;
const BINDING = 0x0001;
const ALLOCATE = 0x0003;
const ATTR = {
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  REALM: 0x0014,
  NONCE: 0x0015,
  XOR_RELAYED_ADDRESS: 0x0016,
  REQUESTED_TRANSPORT: 0x0019,
  XOR_MAPPED_ADDRESS: 0x0020,
};

type Attr = [type: number, value: Buffer];

function attr([type, value]: Attr): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(value.length, 2);
  return Buffer.concat([head, value, Buffer.alloc((4 - (value.length % 4)) % 4)]);
}

/** A STUN request; with `key`, signed with MESSAGE-INTEGRITY (RFC 5389 §15.4). */
function request(method: number, attrs: Attr[], key?: Buffer): { msg: Buffer; txid: Buffer } {
  const txid = randomBytes(12);
  let body = Buffer.concat(attrs.map(attr));
  const header = (len: number) => {
    const h = Buffer.alloc(20);
    h.writeUInt16BE(method, 0);
    h.writeUInt16BE(len, 2);
    h.writeUInt32BE(MAGIC, 4);
    txid.copy(h, 8);
    return h;
  };
  if (key) {
    // The HMAC covers the header with a length that already counts the integrity attribute.
    const mac = createHmac("sha1", key).update(Buffer.concat([header(body.length + 24), body])).digest();
    body = Buffer.concat([body, attr([ATTR.MESSAGE_INTEGRITY, mac])]);
  }
  return { msg: Buffer.concat([header(body.length), body]), txid };
}

interface Response {
  type: number;
  attrs: Map<number, Buffer>;
}

function parse(msg: Buffer): Response {
  const attrs = new Map<number, Buffer>();
  for (let off = 20; off + 4 <= msg.length; ) {
    const type = msg.readUInt16BE(off);
    const len = msg.readUInt16BE(off + 2);
    attrs.set(type, msg.subarray(off + 4, off + 4 + len));
    off += 4 + len + ((4 - (len % 4)) % 4);
  }
  return { type: msg.readUInt16BE(0), attrs };
}

function xorAddress(value: Buffer): string {
  const port = value.readUInt16BE(2) ^ (MAGIC >>> 16);
  const ip = [...value.subarray(4, 8)].map((b, i) => b ^ ((MAGIC >>> (24 - 8 * i)) & 0xff));
  return `${ip.join(".")}:${port}`;
}

const errorCode = (r: Response) => {
  const v = r.attrs.get(ATTR.ERROR_CODE);
  return v ? v[2] * 100 + v[3] : null;
};

/** One UDP socket per client: eturnal binds a nonce to the address it was issued to. */
async function withSocket<T>(fn: (send: (msg: Buffer, txid: Buffer) => Promise<Response>) => Promise<T>): Promise<T> {
  const sock = dgram.createSocket("udp4");
  const send = (msg: Buffer, txid: Buffer) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer from ${HOST}:${PORT}`)), 3000);
      const onMessage = (m: Buffer) => {
        if (m.length >= 20 && m.subarray(8, 20).equals(txid)) {
          clearTimeout(timer);
          sock.off("message", onMessage);
          resolve(parse(m));
        }
      };
      sock.on("message", onMessage);
      sock.send(msg, PORT, HOST, (err) => err && reject(err));
    });
  try {
    return await fn(send);
  } finally {
    sock.close();
  }
}

/** Allocate with long-term credentials: the 401 carries the nonce the signed retry needs. */
function allocate(username: string, password: string): Promise<Response> {
  return withSocket(async (send) => {
    const transport: Attr = [ATTR.REQUESTED_TRANSPORT, Buffer.from([17, 0, 0, 0])];
    const first = request(ALLOCATE, [transport]);
    const challenge = await send(first.msg, first.txid);
    if (errorCode(challenge) !== 401) throw new Error(`unauthenticated Allocate answered ${errorCode(challenge)}`);
    const realm = challenge.attrs.get(ATTR.REALM)!;
    const nonce = challenge.attrs.get(ATTR.NONCE)!;
    const key = createHash("md5").update(`${username}:${realm.toString()}:${password}`).digest();
    const signed = request(
      ALLOCATE,
      [transport, [ATTR.USERNAME, Buffer.from(username)], [ATTR.REALM, realm], [ATTR.NONCE, nonce]],
      key
    );
    return send(signed.msg, signed.txid);
  });
}

export async function run(nodeName: string, _networkInfo: NetworkInfo, _args: string[]): Promise<number> {
  try {
    console.log(`[TEST] TURN relay on ${HOST}:${PORT}, credentials via ${DUB_BASE} (from ${nodeName})`);

    const binding = request(BINDING, []);
    const mapped = (await withSocket((send) => send(binding.msg, binding.txid))).attrs.get(ATTR.XOR_MAPPED_ADDRESS);
    if (!mapped) {
      console.error("[TEST] FAIL STUN Binding returned no XOR-MAPPED-ADDRESS");
      return FAILURE;
    }
    console.log(`[TEST] ok STUN, mapped ${xorAddress(mapped)}`);

    if (!(await waitForDubReady({ timeoutMs: 300_000, pollMs: 5_000, log: console.log }))) return FAILURE;
    const signer = sr25519CreateDerive(entropyToMiniSecret(new Uint8Array(randomBytes(32))))("");
    const token = await dubToken(signer);

    const res = await fetch(`${DUB_BASE}/api/v1/turn/issue`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    if (res.status !== 201) {
      console.error(`[TEST] FAIL turn/issue: ${res.status} ${await res.text()}`);
      return FAILURE;
    }
    const creds = (await res.json()) as { servers: string[]; username: string; password: string; ttl: number };
    if (JSON.stringify(creds.servers) !== JSON.stringify(EXPECTED_SERVERS)) {
      console.error(`[TEST] FAIL ICE servers ${JSON.stringify(creds.servers)}, expected ${JSON.stringify(EXPECTED_SERVERS)}`);
      return FAILURE;
    }
    console.log(`[TEST] ok credentials issued for ${creds.username} (ttl ${creds.ttl}s)`);

    const granted = await allocate(creds.username, creds.password);
    const relayed = granted.attrs.get(ATTR.XOR_RELAYED_ADDRESS);
    if (granted.type !== 0x0103 || !relayed) {
      console.error(`[TEST] FAIL Allocate with DUB's credentials: error ${errorCode(granted)}`);
      return FAILURE;
    }
    console.log(`[TEST] ok relay allocated at ${xorAddress(relayed)}`);

    const refused = await allocate(creds.username, `${creds.password}x`);
    if (errorCode(refused) !== 401) {
      console.error(`[TEST] FAIL a wrong password was answered ${refused.type.toString(16)}, not 401`);
      return FAILURE;
    }
    console.log("[TEST] ok wrong password refused");
    return SUCCESS;
  } catch (err) {
    console.error(`[TEST] FAIL ${(err as Error).message}`);
    return FAILURE;
  }
}

// CommonJS export for Zombienet compatibility
export default { run };
