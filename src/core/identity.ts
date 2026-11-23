import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
} from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { b64u, base58decode, base58encode, unb64u } from './bytes.js'
import { canonicalize } from './canonical.js'

/**
 * An agent identity: an Ed25519 key for signing (it is the DID) and an X25519
 * key for receiving sealed mail. The encryption key is published inside each
 * beacon's mailbox entry, so the beacon signature vouches for it.
 */
export interface Identity {
  did: string
  signPub: string
  signPriv: string
  encPub: string
  encPriv: string
}

const ED25519_MULTICODEC = Buffer.from([0xed, 0x01])
const DID_PREFIX = 'did:key:z'

export function didFromPublicKey(raw: Uint8Array): string {
  if (raw.length !== 32) throw new Error('an Ed25519 public key is 32 bytes')
  return DID_PREFIX + base58encode(Buffer.concat([ED25519_MULTICODEC, raw]))
}

/** Returns the raw 32-byte Ed25519 public key in a did:key, or throws. */
export function publicKeyFromDid(did: string): Buffer {
  if (typeof did !== 'string' || !did.startsWith(DID_PREFIX)) {
    throw new Error('only did:key identifiers with an Ed25519 key are supported')
  }
  const bytes = base58decode(did.slice(DID_PREFIX.length))
  if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) {
    throw new Error('did:key does not hold an Ed25519 key')
  }
  return bytes.subarray(2)
}

export function isDid(did: unknown): did is string {
  try {
    publicKeyFromDid(did as string)
    return true
  } catch {
    return false
  }
}

export function createIdentity(): Identity {
  const ed = generateKeyPairSync('ed25519')
  const x = generateKeyPairSync('x25519')
  const edJwk = ed.privateKey.export({ format: 'jwk' }) as { x: string; d: string }
  const xJwk = x.privateKey.export({ format: 'jwk' }) as { x: string; d: string }
  return {
    did: didFromPublicKey(unb64u(edJwk.x)),
    signPub: edJwk.x,
    signPriv: edJwk.d,
    encPub: xJwk.x,
    encPriv: xJwk.d,
  }
}

/** Loads the identity stored at `path`, creating and saving one if absent. */
export function loadOrCreateIdentity(path: string): Identity {
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as Identity
  const id = createIdentity()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(id, null, 2), { mode: 0o600 })
  return id
}

/**
 * The bytes that are signed: a domain-separation line naming what kind of
 * object this is, then the canonical JSON. The context stops a signature made
 * for one purpose (say, a relay login) from being replayed as another (a
 * receipt).
 */
function signingInput(context: string, obj: unknown): Buffer {
  return Buffer.from(`varde/${context}/v1\n${canonicalize(obj)}`, 'utf8')
}

export function sign(id: Identity, context: string, obj: unknown): string {
  const key = createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: id.signPub, d: id.signPriv },
    format: 'jwk',
  })
  return b64u(edSign(null, signingInput(context, obj), key))
}

export function verify(did: string, context: string, obj: unknown, sig: string): boolean {
  try {
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: b64u(publicKeyFromDid(did)) },
      format: 'jwk',
    })
    return edVerify(null, signingInput(context, obj), key, unb64u(sig))
  } catch {
    return false
  }
}

/** Signs `obj` and returns it with a `sig` field. Any existing `sig` is ignored. */
export function signObject<T extends object>(id: Identity, context: string, obj: T): T & { sig: string } {
  const { sig: _old, ...body } = obj as T & { sig?: string }
  return { ...(body as T), sig: sign(id, context, body) }
}

/** Verifies an object produced by `signObject` against the signer's DID. */
export function verifyObject(did: string, context: string, obj: { sig?: unknown }): boolean {
  if (!obj || typeof obj.sig !== 'string') return false
  const { sig, ...body } = obj
  return verify(did, context, body, sig)
}
