import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto'
import { b64u, unb64u } from './bytes.js'

/** An anonymous sealed box: only the holder of the recipient key can open it. */
export interface Sealed {
  epk: string
  nonce: string
  ct: string
}

const INFO = Buffer.from('varde/seal/v1')

function deriveKey(shared: Buffer, epk: Buffer, rpk: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([epk, rpk]), INFO, 32))
}

const x25519Public = (x: string) =>
  createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x }, format: 'jwk' })

/** Encrypts `plaintext` to an X25519 public key (base64url). */
export function seal(recipientEncPub: string, plaintext: Uint8Array): Sealed {
  const eph = generateKeyPairSync('x25519')
  const epk = (eph.publicKey.export({ format: 'jwk' }) as { x: string }).x
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: x25519Public(recipientEncPub) })
  const key = deriveKey(shared, unb64u(epk), unb64u(recipientEncPub))
  const iv = randomBytes(12)
  const cipher = createCipheriv('chacha20-poly1305', key, iv, { authTagLength: 16 })
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
  return { epk, nonce: b64u(iv), ct: b64u(ct) }
}

/** Opens a sealed box. Returns null if it was not sealed to this key or was altered. */
export function unseal(encPub: string, encPriv: string, sealed: Sealed): Buffer | null {
  try {
    const priv = createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', x: encPub, d: encPriv }, format: 'jwk' })
    const shared = diffieHellman({ privateKey: priv, publicKey: x25519Public(sealed.epk) })
    const key = deriveKey(shared, unb64u(sealed.epk), unb64u(encPub))
    const raw = unb64u(sealed.ct)
    if (raw.length < 16) return null
    const decipher = createDecipheriv('chacha20-poly1305', key, unb64u(sealed.nonce), { authTagLength: 16 })
    decipher.setAuthTag(raw.subarray(raw.length - 16))
    return Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()])
  } catch {
    return null
  }
}

export function isSealed(x: unknown): x is Sealed {
  const s = x as Sealed
  return !!s && typeof s.epk === 'string' && typeof s.nonce === 'string' && typeof s.ct === 'string'
}
