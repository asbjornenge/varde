import { b64u, sha256 } from './bytes.js'
import { canonicalize } from './canonical.js'
import { type Identity, isDid, sign, signObject, verify, verifyObject } from './identity.js'

/**
 * A deal is made in two steps, so that a person can decide between them.
 *
 *   1. The negotiators agree, and the room issues a QUOTE: the terms and how
 *      long they stand. It is signed by both agents and the room, and it
 *      commits nobody.
 *   2. Each side sends an APPROVAL of the quote, signed by whoever the quote
 *      names as that side's approver, normally the owner. Once the room holds
 *      both, it issues the RECEIPT.
 *
 * Until then either side may send a WITHDRAWAL, and the quote lapses by
 * itself at `validUntil`.
 */

export interface QuoteParty {
  did: string
  side: 'pay' | 'receive'
  /** Id of the beacon that brought this party to the room, if it had one. */
  beacon?: string
  /**
   * The key that must sign this party's approval. It is the owner's key when
   * the mandate names one, and the agent's own key otherwise or when the
   * owner allowed the agent to commit at this price.
   */
  approver: string
}

export interface Terms {
  price: number
  currency: string
  /** Conditions beyond price that were part of the accepted offer. */
  conditions?: Record<string, string | number>
}

export interface QuoteBody {
  v: 1
  kind: 'varde.quote'
  room: string
  session: string
  parties: [QuoteParty, QuoteParty]
  terms: Terms
  turns: number
  at: string
  /** The quote can be approved until this time. */
  validUntil: string
}

/** Negotiated terms that stand for a while. Signed by both agents and the room. */
export interface Quote extends QuoteBody {
  sigs: Record<string, string>
}

/** One side's binding yes to a quote. */
export interface Approval {
  v: 1
  kind: 'varde.approval'
  quote: string
  party: string
  by: string
  at: string
  sig: string
}

/** One side's no. Signed by the agent: declining needs no owner. */
export interface Withdrawal {
  v: 1
  kind: 'varde.withdrawal'
  quote: string
  party: string
  at: string
  sig: string
}

/** A record of a completed deal: the quote, both approvals, and the room's signature over them. */
export interface Receipt {
  v: 1
  kind: 'varde.receipt'
  quote: Quote
  approvals: [Approval, Approval]
  at: string
  sig: string
}

const QUOTE = 'quote'
const APPROVAL = 'approval'
const WITHDRAWAL = 'withdrawal'
const RECEIPT = 'receipt'

export const quoteBody = (q: Quote | QuoteBody): QuoteBody => {
  const { sigs: _sigs, ...body } = q as Quote
  return body
}

/** A quote's id is the hash of its terms, so an approval can only ever apply to those terms. */
export const quoteId = (q: Quote | QuoteBody): string => b64u(sha256(canonicalize(quoteBody(q))))

export const signQuote = (id: Identity, body: QuoteBody): string => sign(id, QUOTE, body)
export const verifyQuoteSig = (did: string, body: QuoteBody, sig: string): boolean => verify(did, QUOTE, body, sig)

/** Returns null if the quote is well formed and signed by both agents and the room. */
export function checkQuote(q: Quote): string | null {
  if (!q || q.v !== 1 || q.kind !== 'varde.quote') return 'not a quote'
  if (!isDid(q.room) || !Array.isArray(q.parties) || q.parties.length !== 2) return 'malformed'
  if (!q.sigs || typeof q.sigs !== 'object') return 'missing signatures'
  if (Number.isNaN(Date.parse(q.validUntil)) || Number.isNaN(Date.parse(q.at))) return 'malformed'
  const signers = [q.room, q.parties[0].did, q.parties[1].did]
  if (new Set(signers).size !== 3) return 'room and parties must be three different keys'
  const body = quoteBody(q)
  for (const p of q.parties) if (!isDid(p.did) || !isDid(p.approver)) return 'malformed'
  for (const did of signers)
    if (typeof q.sigs[did] !== 'string' || !verifyQuoteSig(did, body, q.sigs[did])) return `bad or missing signature from ${did}`
  return null
}

/** Signs an approval of `quote` for `party`. `id` is the approver: the owner, or the agent itself. */
export function approveQuote(id: Identity, quote: Quote | QuoteBody, party: string, now = Date.now()): Approval {
  return signObject(id, APPROVAL, {
    v: 1 as const,
    kind: 'varde.approval' as const,
    quote: quoteId(quote),
    party,
    by: id.did,
    at: new Date(now).toISOString(),
  })
}

/** Returns null if `a` is a valid approval of `quote` by the approver the quote names for that party. */
export function checkApproval(a: Approval, quote: Quote | QuoteBody): string | null {
  if (!a || a.v !== 1 || a.kind !== 'varde.approval') return 'not an approval'
  if (a.quote !== quoteId(quote)) return 'approval is for another quote'
  const party = quote.parties.find((p) => p.did === a.party)
  if (!party) return 'approval names someone who is not a party'
  if (a.by !== party.approver) return 'approval is not signed by the key this quote requires'
  if (!verifyObject(a.by, APPROVAL, a)) return 'bad signature'
  return null
}

export function withdrawQuote(id: Identity, quote: Quote | QuoteBody, now = Date.now()): Withdrawal {
  return signObject(id, WITHDRAWAL, {
    v: 1 as const,
    kind: 'varde.withdrawal' as const,
    quote: quoteId(quote),
    party: id.did,
    at: new Date(now).toISOString(),
  })
}

export function checkWithdrawal(w: Withdrawal, quote: Quote | QuoteBody): string | null {
  if (!w || w.v !== 1 || w.kind !== 'varde.withdrawal') return 'not a withdrawal'
  if (w.quote !== quoteId(quote)) return 'withdrawal is for another quote'
  if (!quote.parties.some((p) => p.did === w.party)) return 'withdrawal names someone who is not a party'
  if (!verifyObject(w.party, WITHDRAWAL, w)) return 'bad signature'
  return null
}

const receiptPayload = (quote: Quote, approvals: Approval[], at: string) => ({ quote: quoteId(quote), approvals, at })

export function issueReceipt(room: Identity, quote: Quote, approvals: [Approval, Approval], now = Date.now()): Receipt {
  const at = new Date(now).toISOString()
  return { v: 1, kind: 'varde.receipt', quote, approvals, at, sig: sign(room, RECEIPT, receiptPayload(quote, approvals, at)) }
}

/**
 * Returns null if the receipt holds: a quote signed by all three, an approval
 * from each side's required approver made before the quote lapsed, and the
 * room's signature over the lot. A room cannot forge one, because it cannot
 * sign for the approvers.
 */
export function checkReceipt(r: Receipt): string | null {
  if (!r || r.v !== 1 || r.kind !== 'varde.receipt') return 'not a receipt'
  const q = checkQuote(r.quote)
  if (q) return q
  if (!Array.isArray(r.approvals) || r.approvals.length !== 2) return 'a receipt needs two approvals'
  if (new Set(r.approvals.map((a) => a?.party)).size !== 2) return 'a receipt needs an approval from each party'
  for (const a of r.approvals) {
    const problem = checkApproval(a, r.quote)
    if (problem) return problem
  }
  if (Number.isNaN(Date.parse(r.at)) || Date.parse(r.at) > Date.parse(r.quote.validUntil)) return 'issued after the quote lapsed'
  if (typeof r.sig !== 'string' || !verify(r.quote.room, RECEIPT, receiptPayload(r.quote, r.approvals, r.at), r.sig))
    return 'bad or missing signature from the room'
  return null
}
