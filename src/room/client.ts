import WebSocket from 'ws'
import type { Beacon } from '../core/beacon.js'
import { canonicalize } from '../core/canonical.js'
import { type Identity, signObject } from '../core/identity.js'
import {
  type Approval,
  type Quote,
  type QuoteBody,
  type Receipt,
  type Withdrawal,
  approveQuote,
  checkQuote,
  checkReceipt,
  quoteBody,
  signQuote,
} from '../core/receipt.js'
import type { Negotiator, NegotiatorView } from '../negotiator.js'
import { type Mandate, type Move, type Terms, approverFor, withinMandate } from './negotiation.js'
import { type JoinRequest, ROOM_JOIN_CONTEXT, type RoomStatus } from './server.js'

export interface EnterRoomOptions {
  roomUrl: string
  identity: Identity
  /** Session id both parties derived from their handshake. */
  session: string
  peer: string
  /** The beacon that brought this party here, if it lit one. */
  beacon?: Beacon
  mandate: Mandate
  negotiator: Negotiator
  /** Pass the counterpart's notes to the negotiator. Off by default. */
  showNotes?: boolean
  /**
   * Approve the quote with the agent's own key as soon as it is issued, and
   * wait for the receipt. Only possible when the mandate lets the agent
   * approve. Off by default: the quote is returned for someone to decide on.
   */
  commit?: boolean
  /** Give up if the whole negotiation takes longer than this. Default 5 minutes. */
  timeoutMs?: number
  onEvent?: (e: Record<string, unknown>) => void
}

export type RoomOutcome = (
  /** Terms were agreed and stand until `quote.validUntil`. Nobody is committed yet. */
  | { outcome: 'quoted'; quote: Quote }
  /** Both sides approved. The deal is made. */
  | { outcome: 'agreed'; receipt: Receipt }
  | { outcome: 'ended'; reason: string }
) & {
  history: NegotiatorView['history']
  /** Reasons the room gave for refusing this party's own moves. */
  refusals: string[]
}

/**
 * Joins a room and plays the negotiation through to a quote. The party checks
 * the quote itself before signing it, so a dishonest room cannot record terms
 * that were not agreed, that break this party's mandate, or that name the
 * wrong key as its approver.
 */
export function enterRoom(opts: EnterRoomOptions): Promise<RoomOutcome> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(opts.roomUrl, { maxPayload: 64 * 1024 })
    const me = opts.identity.did
    const history: NegotiatorView['history'] = []
    let roomDid: string | undefined
    let remaining = 0
    let agreed: { price: number; terms?: Terms } | undefined
    let signedBody: QuoteBody | undefined
    let quote: Quote | undefined
    let started = false
    let lastRefusal: string | undefined
    const refusals: string[] = []
    let settled = false

    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
      ws.close()
    }
    const ended = (reason: string) => settle(() => resolve({ outcome: 'ended', reason, history, refusals }))
    // A quote in hand is a result, even if waiting for the receipt runs out of time.
    const giveUp = (reason: string) => (quote ? settle(() => resolve({ outcome: 'quoted', quote: quote!, history, refusals })) : ended(reason))
    const timer = setTimeout(() => giveUp('timeout'), opts.timeoutMs ?? 5 * 60_000)
    const send = (m: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m))

    async function play() {
      const mine = history.filter((h) => h.by === 'me' && h.price !== undefined)
      const last = history[history.length - 1]
      const view: NegotiatorView = {
        side: opts.mandate.side,
        currency: opts.mandate.currency,
        limit: opts.mandate.limit,
        history: history.map((h) => (opts.showNotes ? h : { by: h.by, kind: h.kind, price: h.price, terms: h.terms })),
        required: opts.mandate.terms,
        theirOffer: last && last.by === 'them' ? last.price : undefined,
        theirTerms: last && last.by === 'them' ? last.terms : undefined,
        lastRefusal,
        myLastOffer: mine.length ? mine[mine.length - 1].price : undefined,
        remaining,
      }
      let move: Move
      try {
        move = await opts.negotiator(view)
      } catch {
        move = { kind: 'reject' }
      }
      lastRefusal = undefined
      send({ t: 'move', move })
    }

    ws.on('error', (e) => settle(() => reject(e)))
    ws.on('close', () => giveUp('room-closed'))
    ws.on('message', (data) => {
      let m: Record<string, any>
      try {
        m = JSON.parse(data.toString())
      } catch {
        return
      }
      opts.onEvent?.(m)
      switch (m.t) {
        case 'challenge': {
          roomDid = m.room
          const join: JoinRequest = signObject(opts.identity, ROOM_JOIN_CONTEXT, {
            t: 'join' as const,
            session: opts.session,
            did: me,
            peer: opts.peer,
            nonce: m.nonce,
            beacon: opts.beacon,
            mandate: opts.mandate,
          })
          return send(join)
        }
        case 'start':
          remaining = m.maxTurns
          started = true
          if (m.first === me) void play()
          return
        case 'move': {
          remaining = m.remaining
          const by = m.from === me ? 'me' : 'them'
          history.push({ by, kind: m.kind, price: m.price, ...(m.terms ? { terms: m.terms } : {}), ...(m.untrustedNote !== undefined ? { untrustedNote: m.untrustedNote } : {}) })
          if (m.kind === 'accept') agreed = { price: m.price, terms: m.terms }
          else if (by === 'them' && (m.kind === 'offer' || m.kind === 'counter')) void play()
          return
        }
        case 'refused':
          // The room would not let us in, or would not take our approval.
          if (!started || quote) return giveUp(`refused: ${m.reason}`)
          // The room refused our own move. Tell the negotiator why and let it
          // try again; every attempt has cost a turn, so this cannot go on.
          refusals.push(String(m.reason))
          lastRefusal = String(m.reason)
          if (typeof m.remaining === 'number') remaining = m.remaining
          if (remaining > 0 && agreed === undefined) void play()
          return
        case 'sign': {
          const q = m.quote as QuoteBody
          const self = q.parties?.find((p) => p.did === me)
          const other = q.parties?.find((p) => p.did === opts.peer)
          const fine =
            q.kind === 'varde.quote' &&
            q.room === roomDid &&
            q.session === opts.session &&
            self?.side === opts.mandate.side &&
            !!other &&
            agreed !== undefined &&
            q.terms?.price === agreed.price &&
            canonicalize(q.terms.conditions ?? {}) === canonicalize(agreed.terms ?? {}) &&
            q.terms?.currency?.toUpperCase() === opts.mandate.currency.toUpperCase() &&
            withinMandate(opts.mandate, q.terms.price, q.terms.conditions) &&
            // The room must name the right key as our approver: the owner's, unless the mandate lets the agent decide.
            self.approver === approverFor(opts.mandate, me, q.terms.price) &&
            Date.parse(q.validUntil) > Date.now()
          if (!fine) return ended('quote-did-not-match')
          signedBody = q
          return send({ t: 'signed', sig: signQuote(opts.identity, q) })
        }
        case 'quote': {
          const q = m.quote as Quote
          if (checkQuote(q) !== null || canonicalize(quoteBody(q)) !== canonicalize(signedBody)) return ended('quote-invalid')
          quote = q
          const selfApproves = q.parties.find((p) => p.did === me)?.approver === me
          if (!opts.commit || !selfApproves) return settle(() => resolve({ outcome: 'quoted', quote: q, history, refusals }))
          return send({ t: 'commit', session: opts.session, approval: approveQuote(opts.identity, q, me) })
        }
        case 'status': {
          const s = m as RoomStatus
          if (!quote || s.session !== opts.session) return
          if (s.state === 'agreed') {
            const receipt = s.receipt
            if (!receipt || checkReceipt(receipt) !== null || canonicalize(receipt.quote) !== canonicalize(quote)) return ended('receipt-invalid')
            return settle(() => resolve({ outcome: 'agreed', receipt, history, refusals }))
          }
          if (s.state !== 'quoted') return ended(s.state)
          return
        }
        case 'end':
          return ended(String(m.reason))
      }
    })
  })
}

/** One request to a room about a quote: connect, send, read the answer, hang up. */
function ask(roomUrl: string, message: object, timeoutMs = 10_000): Promise<RoomStatus> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(roomUrl, { maxPayload: 64 * 1024 })
    const done = (fn: () => void) => {
      clearTimeout(timer)
      ws.removeAllListeners('close')
      fn()
      ws.close()
    }
    const timer = setTimeout(() => done(() => reject(new Error('the room did not answer'))), timeoutMs)
    ws.on('error', (e) => done(() => reject(e)))
    ws.on('close', () => done(() => reject(new Error('the room closed the connection'))))
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString())
      if (m.t === 'challenge') ws.send(JSON.stringify(message))
      else if (m.t === 'status') done(() => resolve(m as RoomStatus))
      else if (m.t === 'refused') done(() => reject(new Error(`the room refused: ${m.reason}`)))
    })
  })
}

/**
 * Checks what a room says about a quote before anyone relies on it: the quote
 * must be the one we hold, and a receipt must verify by itself.
 */
function vetted(status: RoomStatus, expected?: Quote): RoomStatus {
  if (checkQuote(status.quote) !== null) throw new Error('the room returned an invalid quote')
  if (expected && canonicalize(status.quote) !== canonicalize(expected)) throw new Error('the room returned a different quote')
  if (status.state === 'agreed' && (!status.receipt || checkReceipt(status.receipt) !== null || canonicalize(status.receipt.quote) !== canonicalize(status.quote)))
    throw new Error('the room returned an invalid receipt')
  return status
}

/** Asks the room where a quote stands. */
export const quoteStatus = async (roomUrl: string, session: string, expected?: Quote): Promise<RoomStatus> =>
  vetted(await ask(roomUrl, { t: 'status', session }), expected)

/** Delivers an approval. If the other side has approved too, the answer carries the receipt. */
export const commitQuote = async (roomUrl: string, quote: Quote, approval: Approval): Promise<RoomStatus> =>
  vetted(await ask(roomUrl, { t: 'commit', session: quote.session, approval }), quote)

export const withdrawFromQuote = async (roomUrl: string, quote: Quote, withdrawal: Withdrawal): Promise<RoomStatus> =>
  vetted(await ask(roomUrl, { t: 'withdraw', session: quote.session, withdrawal }), quote)
