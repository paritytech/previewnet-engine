// DUB's auth flow, shared by the tests that need a JWT: challenge -> signed proof -> token.
//
// No import from ./utils, for the same reason as dub-ready.ts: HTTP and crypto only.

import { createHash } from "node:crypto";
import { DUB_BASE } from "./dub-ready";

interface Signer {
  publicKey: Uint8Array;
  sign(message: Uint8Array): Uint8Array;
}

const b64 = (u8: Uint8Array) => Buffer.from(u8).toString("base64");
const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
const cat = (...arrs: Uint8Array[]) => new Uint8Array(Buffer.concat(arrs.map(Buffer.from)));

/** A JWT for `signer`'s sr25519 key, or throws with the backend's answer. */
export async function dubToken(signer: Signer, base = DUB_BASE): Promise<string> {
  const chRes = await fetch(`${base}/api/v1/auth/challenges`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const { challenge } = (await chRes.json()) as { challenge: string };

  // proof = sr25519(SHA256(challenge || clientId || SHA256(body)))
  const clientProof = signer.sign(
    sha256(cat(new Uint8Array(Buffer.from(challenge, "base64")), signer.publicKey, sha256(new Uint8Array(Buffer.from("{}")))))
  );
  const tokenRes = await fetch(`${base}/api/v1/auth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Auth-ClientId": b64(signer.publicKey),
      "Auth-Challenge": challenge,
      "Auth-ClientProof": b64(clientProof),
      "Auth-Attestation-Type": "none",
    },
    body: "{}",
  });
  if (tokenRes.status !== 200) {
    throw new Error(`auth token: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  return ((await tokenRes.json()) as { token: string }).token;
}
