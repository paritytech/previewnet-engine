// A PAPI signer from a secret URI — //Alice by default, the operator's PPN_SUDO_URI on
// a deployable-profile network. sr25519 only, which is what the dev accounts and the
// profile scheme's preflight (`dot account add`) both use.
//
// Browser-clean: hdkd-helpers is pure JS (@noble crypto), no wasm init, no node: imports.

import {
  createDerive,
  sr25519,
  sr25519Derive,
  DEV_MINI_SECRET,
  mnemonicToMiniSecret,
  ss58Address,
} from '@polkadot-labs/hdkd-helpers';
import { getPolkadotSigner, type PolkadotSigner } from 'polkadot-api/signer';

export interface ParsedSuri {
  /** Mnemonic phrase or 0x-prefixed 32-byte seed; '' means the dev phrase. */
  phrase: string;
  /** Derivation junctions, e.g. '//Alice' or '//op/soft', possibly ''. */
  paths: string;
  password?: string;
}

/**
 * Split a secret URI into phrase, junctions and password:
 * `[phrase | 0xseed] [//hard[/soft]...] [///password]`.
 * hdkd-helpers' own parseSuri refuses a URI without a phrase, which is exactly the
 * common case here (//Alice), hence this one.
 */
export function splitSuri(uri: string): ParsedSuri {
  const passwordAt = uri.indexOf('///');
  const password = passwordAt >= 0 ? uri.slice(passwordAt + 3) : undefined;
  const rest = passwordAt >= 0 ? uri.slice(0, passwordAt) : uri;
  const pathsAt = rest.indexOf('/');
  return {
    phrase: (pathsAt >= 0 ? rest.slice(0, pathsAt) : rest).trim(),
    paths: pathsAt >= 0 ? rest.slice(pathsAt) : '',
    ...(password !== undefined ? { password } : {}),
  };
}

export interface SudoSigner {
  signer: PolkadotSigner;
  publicKey: Uint8Array;
  address: (ss58Prefix?: number) => string;
}

export function signerFromUri(uri: string): SudoSigner {
  const { phrase, paths, password } = splitSuri(uri);

  let seed: Uint8Array | string;
  if (phrase === '') {
    seed = DEV_MINI_SECRET;
  } else if (phrase.startsWith('0x')) {
    const hex = phrase.slice(2);
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error('a raw-seed sudo URI must be 0x followed by 64 hex characters');
    }
    seed = Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
  } else {
    seed = mnemonicToMiniSecret(phrase, password);
  }

  const keyPair = createDerive({ seed, curve: sr25519, derive: sr25519Derive })(paths);
  return {
    signer: getPolkadotSigner(keyPair.publicKey, 'Sr25519', keyPair.sign),
    publicKey: keyPair.publicKey,
    address: (ss58Prefix = 42) => ss58Address(keyPair.publicKey, ss58Prefix),
  };
}
