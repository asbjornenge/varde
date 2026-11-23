import { isDid } from '../core/identity.js'

/**
 * The rules of a room, as plain code with no I/O. A mandate is enforced here,
 * outside any model, so a negotiator cannot be talked past its limit: the
 * room refuses the move before the other side ever sees it.
 */

/** What a party authorises its negotiator to do. Never shown to the other side. */
export interface Mandate {
  /** `pay`: limit is the most it may pay. `receive`: limit is the least it may accept. */
  side: 'pay' | 'receive'
  currency: string
  limit: number
  /** The party's own cap on turns. The room uses the lowest cap in play. */
  maxTurns?: number
  /**
   * Conditions beyond price that the party insists on. Each key lists the
   * values it will agree to, for example `{ time: ["18:30", "19:00"] }`. An
   * offer that omits a listed key, or gives another value, is outside the mandate.
   */
  terms?: Record<string, TermValue[]>
  /**
   * DID of the owner's key. When set, the deal is only made once this key has
   * approved the quote. Without it the agent's own key approves.
   */
  owner?: string
  /**
   * A price at which the agent may approve without its owner: at or below it
   * when paying, at or above it when receiving. Only meaningful with `owner`.
   */
  autoCommit?: number
  /** How long this party lets a quote stand, in seconds. The room uses the shortest in play. */
  holdSeconds?: number
}

/** The key that must approve a quote at `price` for the party `did` holding mandate `m`. */
export function approverFor(m: Mandate, did: string, price: number): string {
  if (!m.owner) return did
  if (m.autoCommit !== undefined && (m.side === 'pay' ? price <= m.autoCommit : price >= m.autoCommit)) return did
  return m.owner
}

export type TermValue = string | number
/** Conditions attached to an offer, for example `{ time: "19:00", partySize: 2 }`. */
export type Terms = Record<string, TermValue>

export interface Move {
  kind: 'offer' | 'counter' | 'accept' | 'reject'
  price?: number
  /** Conditions beyond price. Structured data, so the room can check them. */
  terms?: Terms
  /** Free text. Carried to the other side marked as untrusted, and capped. */
  note?: string
}

export interface MoveEvent {
  from: string
  kind: Move['kind']
  price?: number
  terms?: Terms
  note?: string
  /** Turns used so far, and how many are left for the whole session. */
  turn: number
  remaining: number
}

export type MoveResult =
  | { ok: true; event: MoveEvent }
  /** `over` is set when the refusal used up the last turn. */
  | { ok: false; reason: string; remaining: number; over: boolean }

export const MAX_NOTE_CHARS = 280
export const MAX_PRICE = 1e12

export function checkMandate(m: Mandate): string | null {
  if (!m || typeof m !== 'object') return 'missing mandate'
  if (m.side !== 'pay' && m.side !== 'receive') return 'mandate.side must be pay or receive'
  if (typeof m.currency !== 'string' || !/^[A-Za-z]{2,8}$/.test(m.currency)) return 'mandate.currency must be a short code'
  if (!validPrice(m.limit)) return 'mandate.limit must be a positive amount with at most two decimals'
  if (m.maxTurns !== undefined && !(Number.isInteger(m.maxTurns) && m.maxTurns >= 1)) return 'mandate.maxTurns must be a positive integer'
  if (m.owner !== undefined && !isDid(m.owner)) return 'mandate.owner must be a did:key'
  if (m.autoCommit !== undefined && !validPrice(m.autoCommit)) return 'mandate.autoCommit must be a positive amount'
  if (m.holdSeconds !== undefined && !(Number.isFinite(m.holdSeconds) && m.holdSeconds >= 1)) return 'mandate.holdSeconds must be at least 1'
  if (m.terms !== undefined) {
    if (!m.terms || typeof m.terms !== 'object' || Array.isArray(m.terms)) return 'mandate.terms must be an object'
    const keys = Object.keys(m.terms)
    if (keys.length > MAX_TERMS) return `mandate.terms may name at most ${MAX_TERMS} conditions`
    for (const k of keys) {
      const allowed = m.terms[k]
      if (!TERM_KEY.test(k) || !Array.isArray(allowed) || allowed.length < 1 || allowed.length > 32 || !allowed.every(validTermValue))
        return 'mandate.terms must map short names to lists of allowed values'
    }
  }
  return null
}

export const MAX_TERMS = 8
const TERM_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/
const validTermValue = (v: unknown): v is TermValue =>
  (typeof v === 'string' && v.length >= 1 && v.length <= 64) || (typeof v === 'number' && Number.isFinite(v))

export function validTerms(t: unknown): t is Terms {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return false
  const keys = Object.keys(t)
  return keys.length <= MAX_TERMS && keys.every((k) => TERM_KEY.test(k) && validTermValue((t as Terms)[k]))
}

export function validPrice(p: unknown): p is number {
  return typeof p === 'number' && Number.isFinite(p) && p > 0 && p <= MAX_PRICE && Math.round(p * 100) === p * 100
}

/** True if agreeing to `price` on these conditions is within the mandate. */
export function withinMandate(m: Mandate, price: number, terms: Terms = {}): boolean {
  if (m.side === 'pay' ? price > m.limit : price < m.limit) return false
  for (const [key, allowed] of Object.entries(m.terms ?? {})) if (!allowed.includes(terms[key])) return false
  return true
}

export class Negotiation {
  readonly maxTurns: number
  readonly currency: string
  /** The party that moves first: the receiving side names a price. */
  readonly first: string
  status: 'open' | 'agreed' | 'ended' = 'open'
  endReason?: string
  agreedPrice?: number
  agreedTerms?: Terms
  turns = 0
  private toMove: string
  private standing?: { from: string; price: number; terms?: Terms }
  private mandates: Map<string, Mandate>

  constructor(a: { did: string; mandate: Mandate }, b: { did: string; mandate: Mandate }, roomMaxTurns: number) {
    if (a.did === b.did) throw new Error('a party cannot negotiate with itself')
    if (a.mandate.side === b.mandate.side) throw new Error('both parties are on the same side')
    if (a.mandate.currency.toUpperCase() !== b.mandate.currency.toUpperCase()) throw new Error('currencies differ')
    this.mandates = new Map([
      [a.did, a.mandate],
      [b.did, b.mandate],
    ])
    this.currency = a.mandate.currency.toUpperCase()
    this.maxTurns = Math.min(roomMaxTurns, a.mandate.maxTurns ?? Infinity, b.mandate.maxTurns ?? Infinity)
    this.first = a.mandate.side === 'receive' ? a.did : b.did
    this.toMove = this.first
  }

  get remaining() {
    return this.maxTurns - this.turns
  }

  private other(did: string): string {
    for (const d of this.mandates.keys()) if (d !== did) return d
    throw new Error('unreachable')
  }

  private end(reason: string) {
    this.status = 'ended'
    this.endReason = reason
  }

  /**
   * Applies a move. Every attempt costs a turn, including refused ones, so
   * neither side can be drained by a counterpart that keeps trying.
   */
  move(did: string, move: Move): MoveResult {
    const mandate = this.mandates.get(did)
    if (!mandate) return { ok: false, reason: 'not a party to this session', remaining: this.remaining, over: false }
    if (this.status !== 'open') return { ok: false, reason: 'session is over', remaining: this.remaining, over: true }

    this.turns++
    const refuse = (reason: string): MoveResult => {
      if (this.remaining <= 0) this.end('turn-limit')
      return { ok: false, reason, remaining: this.remaining, over: this.status !== 'open' }
    }

    if (did !== this.toMove) return refuse('not your turn')
    if (!move || typeof move !== 'object') return refuse('malformed move')
    if (move.note !== undefined && (typeof move.note !== 'string' || move.note.length > MAX_NOTE_CHARS))
      return refuse(`note must be text of at most ${MAX_NOTE_CHARS} characters`)

    let price: number | undefined
    let terms: Terms | undefined
    switch (move.kind) {
      case 'offer':
      case 'counter':
        if (move.kind === 'counter' && !this.standing) return refuse('nothing to counter')
        if (!validPrice(move.price)) return refuse('price must be a positive amount with at most two decimals')
        if (move.terms !== undefined && !validTerms(move.terms)) return refuse('terms must be a small flat object of short values')
        if (!withinMandate(mandate, move.price, move.terms)) return refuse('outside your mandate')
        price = move.price
        terms = move.terms && Object.keys(move.terms).length ? { ...move.terms } : undefined
        this.standing = { from: did, price, terms }
        this.toMove = this.other(did)
        break
      case 'accept':
        if (!this.standing || this.standing.from === did) return refuse('no offer from the other side to accept')
        if (!withinMandate(mandate, this.standing.price, this.standing.terms)) return refuse('outside your mandate')
        price = this.standing.price
        terms = this.standing.terms
        this.status = 'agreed'
        this.agreedPrice = price
        this.agreedTerms = terms
        break
      case 'reject':
        this.end('rejected')
        break
      default:
        return refuse('unknown move kind')
    }

    const event: MoveEvent = { from: did, kind: move.kind, price, terms, note: move.note, turn: this.turns, remaining: this.remaining }
    if (this.status === 'open' && this.remaining <= 0) this.end('turn-limit')
    return { ok: true, event }
  }
}
