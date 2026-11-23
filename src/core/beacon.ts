import { b64u, sha256 } from './bytes.js'
import { canonicalize } from './canonical.js'
import { type Identity, isDid, signObject, verifyObject } from './identity.js'
import { minePow } from './pow.js'

export type Intent = 'want' | 'offer'

/** `what` is free text. The object form adds optional tags and an intent hint. */
export type What = string | { text: string; tags?: string[]; intent?: Intent }

export interface Scope {
  /** A place in free text, e.g. "Stavanger area". */
  where?: string
  /** A precise place. `radiusKm` is how far the lighter is willing to go. */
  geo?: { lat: number; lon: number; radiusKm?: number }
  /** Time window the want or offer applies to (ISO 8601). */
  from?: string
  until?: string
  topic?: string
}

export type ReachMe =
  /** Sealed mail dropped on a relay. `encKey` is the X25519 key to seal to. */
  | { kind: 'mailbox'; relay: string; encKey: string }
  /** An always-online agent with a declared protocol such as a2a, mcp or https. */
  | { kind: 'endpoint'; protocol: string; url: string }

export interface Accepts {
  rooms?: string[]
  protocols?: string[]
  trust?: string[]
}

export interface Beacon {
  v: 1
  /** DID of the agent that lit the beacon. The DID only: the signature lives in `sig`. */
  who: string
  what: What
  scope?: Scope
  /** When the beacon was lit (ISO 8601). */
  lit: string
  /** When the beacon burns out (ISO 8601). */
  expires: string
  reachMe: ReachMe[]
  proofs?: unknown[]
  accepts?: Accepts
  /** Ed25519 signature by `who` over the canonical JSON of every other field. */
  sig: string
}

export type BeaconInput = Omit<Beacon, 'v' | 'who' | 'lit' | 'sig'> & {
  lit?: string
  /** Attach this many bits of proof of work, as a relay may require. */
  pow?: number
}

export const BEACON_CONTEXT = 'beacon'
export const MAX_BEACON_BYTES = 8 * 1024
export const MAX_WHAT_CHARS = 2000

/** Signs a beacon with the lighter's key. */
export function lightBeacon(id: Identity, input: BeaconInput, now = Date.now()): Beacon {
  const content = JSON.parse(
    JSON.stringify({
      v: 1 as const,
      who: id.did,
      what: input.what,
      scope: input.scope,
      lit: input.lit ?? new Date(now).toISOString(),
      expires: input.expires,
      reachMe: input.reachMe,
      proofs: input.proofs,
      accepts: input.accepts,
    }),
  )
  if (input.pow) content.proofs = [...(content.proofs ?? []), minePow(content, input.pow)]
  const beacon = signObject(id, BEACON_CONTEXT, content as Omit<Beacon, 'sig'>)
  // Drop undefined optionals so the stored object equals what was signed.
  const clean = JSON.parse(JSON.stringify(beacon)) as Beacon
  const problem = checkBeacon(clean, now)
  if (problem) throw new Error(`cannot light beacon: ${problem}`)
  return clean
}

/** A beacon's id is the hash of its signed content, so it cannot be forged. */
export function beaconId(b: Beacon): string {
  const { sig: _sig, ...body } = b
  return b64u(sha256(canonicalize(body)))
}

export const whatText = (b: Beacon): string => (typeof b.what === 'string' ? b.what : b.what.text)
export const whatTags = (b: Beacon): string[] => (typeof b.what === 'string' ? [] : (b.what.tags ?? []))
export const whatIntent = (b: Beacon): Intent | undefined =>
  typeof b.what === 'string' ? undefined : b.what.intent

export const isExpired = (b: Beacon, now = Date.now()): boolean => Date.parse(b.expires) <= now

export const mailboxOf = (b: Beacon) =>
  b.reachMe.find((r): r is Extract<ReachMe, { kind: 'mailbox' }> => r.kind === 'mailbox')

const isIso = (s: unknown): s is string => typeof s === 'string' && !Number.isNaN(Date.parse(s))
const isStrings = (a: unknown, max = 32): a is string[] =>
  Array.isArray(a) && a.length <= max && a.every((s) => typeof s === 'string' && s.length <= 256)

function checkShape(b: Beacon): string | null {
  if (!b || typeof b !== 'object') return 'not an object'
  if (b.v !== 1) return 'unsupported version'
  if (!isDid(b.who)) return 'who is not a did:key'
  if (typeof b.sig !== 'string') return 'missing sig'
  if (typeof b.what === 'string') {
    if (!b.what.trim() || b.what.length > MAX_WHAT_CHARS) return 'what must be 1-2000 characters'
  } else if (b.what && typeof b.what === 'object') {
    if (typeof b.what.text !== 'string' || !b.what.text.trim() || b.what.text.length > MAX_WHAT_CHARS)
      return 'what.text must be 1-2000 characters'
    if (b.what.tags !== undefined && !isStrings(b.what.tags)) return 'what.tags must be strings'
    if (b.what.intent !== undefined && b.what.intent !== 'want' && b.what.intent !== 'offer')
      return 'what.intent must be want or offer'
  } else return 'missing what'
  if (!isIso(b.lit)) return 'lit is not a timestamp'
  if (!isIso(b.expires)) return 'expires is not a timestamp'
  if (Date.parse(b.expires) <= Date.parse(b.lit)) return 'expires must be after lit'
  if (!Array.isArray(b.reachMe) || b.reachMe.length < 1 || b.reachMe.length > 8)
    return 'reachMe needs one to eight entries'
  for (const r of b.reachMe) {
    if (!r || typeof r !== 'object') return 'invalid reachMe entry'
    if (r.kind === 'mailbox') {
      if (typeof r.relay !== 'string' || typeof r.encKey !== 'string') return 'mailbox needs relay and encKey'
    } else if (r.kind === 'endpoint') {
      if (typeof r.protocol !== 'string' || typeof r.url !== 'string') return 'endpoint needs protocol and url'
    } else return 'unknown reachMe kind'
  }
  if (b.scope !== undefined) {
    const s = b.scope
    if (!s || typeof s !== 'object') return 'scope must be an object'
    if (s.where !== undefined && typeof s.where !== 'string') return 'scope.where must be text'
    if (s.topic !== undefined && typeof s.topic !== 'string') return 'scope.topic must be text'
    if (s.from !== undefined && !isIso(s.from)) return 'scope.from is not a timestamp'
    if (s.until !== undefined && !isIso(s.until)) return 'scope.until is not a timestamp'
    if (s.geo !== undefined) {
      const g = s.geo
      if (!g || !Number.isFinite(g.lat) || !Number.isFinite(g.lon) || Math.abs(g.lat) > 90 || Math.abs(g.lon) > 180)
        return 'scope.geo needs a valid lat and lon'
      if (g.radiusKm !== undefined && !(Number.isFinite(g.radiusKm) && g.radiusKm >= 0))
        return 'scope.geo.radiusKm must be a non-negative number'
    }
  }
  if (b.proofs !== undefined && !Array.isArray(b.proofs)) return 'proofs must be an array'
  if (b.accepts !== undefined) {
    const a = b.accepts
    if (!a || typeof a !== 'object') return 'accepts must be an object'
    for (const k of ['rooms', 'protocols', 'trust'] as const)
      if (a[k] !== undefined && !isStrings(a[k])) return `accepts.${k} must be strings`
  }
  return null
}

/**
 * Full check of a beacon received from anywhere: shape, size, signature and
 * expiry. Returns null when the beacon is good, otherwise the reason it is not.
 * Because this needs nothing but the beacon, relays never have to be trusted.
 */
export function checkBeacon(b: Beacon, now = Date.now()): string | null {
  let size: number
  try {
    size = Buffer.byteLength(canonicalize(b))
  } catch {
    return 'not canonical JSON'
  }
  if (size > MAX_BEACON_BYTES) return 'too large'
  const shape = checkShape(b)
  if (shape) return shape
  if (!verifyObject(b.who, BEACON_CONTEXT, b)) return 'bad signature'
  if (isExpired(b, now)) return 'expired'
  return null
}
