import { b64u, sha256 } from './bytes.js'
import { canonicalize } from './canonical.js'
import { type Identity, signObject, verifyObject } from './identity.js'
import { type Sealed, seal, unseal } from './seal.js'

/**
 * A mail message is signed by the sender, then sealed to the recipient. The
 * relay that carries it sees only the recipient's DID and ciphertext.
 */
export interface Mail<B = unknown> {
  v: 1
  type: string
  from: string
  to: string
  at: string
  body: B
  sig: string
}

const MAIL_CONTEXT = 'mail'

export function sealMail(id: Identity, to: string, toEncKey: string, type: string, body: unknown, now = Date.now()) {
  const mail: Mail = signObject(id, MAIL_CONTEXT, {
    v: 1 as const,
    type,
    from: id.did,
    to,
    at: new Date(now).toISOString(),
    body,
  })
  return { mail, sealed: seal(toEncKey, Buffer.from(JSON.stringify(mail))) }
}

/** Opens mail addressed to `id`. Returns null unless it decrypts and the sender's signature holds. */
export function openMail(id: Identity, sealed: Sealed): Mail | null {
  const plain = unseal(id.encPub, id.encPriv, sealed)
  if (!plain) return null
  try {
    const mail = JSON.parse(plain.toString('utf8')) as Mail
    if (mail.v !== 1 || mail.to !== id.did || typeof mail.type !== 'string') return null
    if (!verifyObject(mail.from, MAIL_CONTEXT, mail)) return null
    return mail
  } catch {
    return null
  }
}

export const mailHash = (mail: Mail): string => b64u(sha256(canonicalize(mail)))
