import type { Mandate, Move, Terms } from './room/negotiation.js'

/**
 * A sandboxed negotiator sees only this: its goal, its limit and the
 * structured moves so far. It has no access to the owner's files, tools or
 * memory, so there is nothing for the other side to extract. Notes from the
 * counterpart are withheld unless the caller opts in.
 */
export interface NegotiatorView {
  side: Mandate['side']
  currency: string
  /** The owner's limit. The room enforces it too, whatever the negotiator does. */
  limit: number
  /** Offers so far, oldest first. */
  history: { by: 'me' | 'them'; kind: Move['kind']; price?: number; terms?: Terms; untrustedNote?: string }[]
  /** Conditions the owner insists on, as given in the mandate. */
  required?: Mandate['terms']
  /** The other side's standing offer, if any, and the conditions attached to it. */
  theirOffer?: number
  theirTerms?: Terms
  /** Why the room refused this negotiator's previous move, if it did. */
  lastRefusal?: string
  myLastOffer?: number
  /** Turns left for the whole session, counting the one about to be played. */
  remaining: number
}

export type Negotiator = (view: NegotiatorView) => Move | Promise<Move>

export interface ConcedeOptions {
  /** The price to open at. */
  target: number
  /** Fraction of the gap to the limit given up each round. Default 0.35. */
  step?: number
  /** Prices are rounded to a multiple of this. Default 1. */
  unit?: number
  /** Conditions to attach to every offer. An offer from the other side must match them to be accepted. */
  terms?: Terms
}

/**
 * A deterministic negotiator: open at the target, concede a fixed fraction of
 * the remaining gap each round, accept as soon as the other side's offer is at
 * least as good as its own next one, and never cross the limit.
 */
export function concede(opts: ConcedeOptions): Negotiator {
  const step = opts.step ?? 0.35
  const unit = opts.unit ?? 1
  return (v) => {
    const pay = v.side === 'pay'
    const within = (p: number) => (pay ? p <= v.limit : p >= v.limit)
    const clamp = (p: number) => (pay ? Math.min(p, v.limit) : Math.max(p, v.limit))
    const round = (p: number) => clamp(Math.round(p / unit) * unit)

    let next: number
    if (v.myLastOffer === undefined) next = round(opts.target)
    else {
      next = round(v.myLastOffer + (v.limit - v.myLastOffer) * step)
      // Always move at least one unit toward the limit until it is reached.
      if (next === v.myLastOffer && next !== v.limit) next = clamp(v.myLastOffer + (pay ? unit : -unit))
    }

    const mine = opts.terms
    const termsFit =
      Object.entries(mine ?? {}).every(([k, x]) => v.theirTerms?.[k] === x) &&
      Object.entries(v.required ?? {}).every(([k, allowed]) => allowed.includes(v.theirTerms?.[k] as never))
    const t = v.theirOffer
    if (t !== undefined && within(t) && termsFit) {
      if (pay ? t <= next : t >= next) return { kind: 'accept' }
      // No room left to haggle: a deal inside the limit beats no deal.
      if (v.remaining <= 2) return { kind: 'accept' }
    }
    if (v.remaining <= 1) return { kind: 'reject' }
    if (v.remaining === 2) next = v.limit
    return { kind: t === undefined ? 'offer' : 'counter', price: next, ...(mine ? { terms: mine } : {}) }
  }
}
