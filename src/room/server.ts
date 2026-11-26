import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { type WebSocket, WebSocketServer } from 'ws'
import { type Beacon, beaconId, checkBeacon } from '../core/beacon.js'
import { nonce } from '../core/bytes.js'
import { type Identity, isDid, verifyObject } from '../core/identity.js'
import {
  type Approval,
  type Quote,
  type QuoteBody,
  type Receipt,
  type Withdrawal,
  checkApproval,
  checkQuote,
  checkWithdrawal,
  issueReceipt,
  signQuote,
  verifyQuoteSig,
} from '../core/receipt.js'
import { canonicalize } from '../core/canonical.js'
import { type Mandate, type Move, type MoveEvent, Negotiation, type NegotiationSnapshot, type Terms, approverFor, checkMandate } from './negotiation.js'

/**
 * A room is a neutral service two agents enter to negotiate under rules
 * neither controls. It verifies both keys against the beacons that brought
 * them, enforces each mandate in code, caps turns and bytes, and carries only
 * structured moves.
 *
 * The parties need not be present together. Each looks in, sees where things
 * stand, makes a move if it is its turn, and leaves; the room keeps the
 * session until it is settled or its time runs out.
 *
 * What the negotiators agree becomes a quote, which the room keeps. The deal
 * is made, and the receipt issued, only when both sides' approvers have
 * approved it. So an agent can collect quotes from several counterparts and
 * take them to its owner before anything is binding.
 */
export interface RoomOptions {
  identity: Identity
  port?: number
  host?: string
  /** Hard cap on turns per session. Default 12. */
  maxTurns?: number
  /** Hard cap on bytes each party may send in a session. Default 16 KiB. */
  maxBytesPerParty?: number
  /**
   * How long a session is kept while its parties come and go. A negotiation
   * that has not reached a quote by then ends. Default 7 days.
   */
  sessionTtlMs?: number
  /** How long a quote stands when neither mandate says. Default 24 hours. */
  defaultHoldMs?: number
  /** The longest a quote may stand, whatever the mandates say. Default 7 days. */
  maxHoldMs?: number
  /** Keep quotes and receipts in this file, so they survive a restart. */
  dataFile?: string
  now?: () => number
}

export interface Room {
  port: number
  url: string
  did: string
  close(): Promise<void>
  stats(): { sessions: number; quotes: number }
}

export const ROOM_JOIN_CONTEXT = 'room-join'

export interface JoinRequest {
  t: 'join'
  session: string
  did: string
  /** The counterpart this party expects to meet. */
  peer: string
  /** The room's challenge for this connection. */
  nonce: string
  beacon?: Beacon
  mandate: Mandate
  sig: string
}

export type DealState = 'quoted' | 'agreed' | 'withdrawn' | 'lapsed'

/** What the room says about a quote when asked, and after every change to it. */
export interface RoomStatus {
  t: 'status'
  session: string
  state: DealState
  quote: Quote
  /** Parties whose approval the room holds. */
  approved: string[]
  withdrawnBy?: string
  receipt?: Receipt
}

/** One side of a session, as the room remembers it between visits. */
interface Party {
  did: string
  peer: string
  beaconId?: string
  mandate: Mandate
  bytes: number
  quoteSig?: string
}

/** A negotiation the room is keeping. The parties come and go; this stays. */
interface Session {
  id: string
  createdAt: number
  parties: Record<string, Party>
  status: 'waiting' | 'open' | 'signing' | 'ended'
  reason?: string
  negotiation?: NegotiationSnapshot
  quote?: QuoteBody
}

/** What a party is told about its session whenever it looks in. Never includes the other side's mandate. */
export interface RoomState {
  t: 'state'
  session: string
  room: string
  /** `waiting`: the other side has not come yet. `signing`: terms are agreed and the quote awaits signatures. */
  status: Session['status'] | 'quoted'
  reason?: string
  currency?: string
  maxTurns?: number
  remaining?: number
  yourTurn: boolean
  /** The party expected to open when both are present. */
  first?: string
  history: (Omit<MoveEvent, 'note'> & { untrustedNote?: string })[]
  offer?: { from: string; price: number; terms?: Terms }
  /** A quote this party is asked to sign. */
  sign?: QuoteBody
  quote?: Quote
  /** The session ends by itself at this time if nothing has been agreed. */
  deadline: string
}

interface Deal {
  state: DealState
  quote: Quote
  approvals: Record<string, Approval>
  withdrawnBy?: string
  receipt?: Receipt
}

const DAY = 24 * 60 * 60_000

export async function startRoom(opts: RoomOptions): Promise<Room> {
  const now = opts.now ?? Date.now
  const roomMaxTurns = opts.maxTurns ?? 12
  const maxBytes = opts.maxBytesPerParty ?? 16 * 1024
  const sessionTtlMs = opts.sessionTtlMs ?? 7 * DAY
  const defaultHoldMs = opts.defaultHoldMs ?? DAY
  const maxHoldMs = opts.maxHoldMs ?? 7 * DAY
  const sessions = new Map<string, Session>()
  const live = new Map<string, Negotiation>()
  /** Who is connected right now, per session and party. */
  const present = new Map<string, Map<string, Set<WebSocket>>>()
  const deals = new Map<string, Deal>()
  const watchers = new Map<string, Set<WebSocket>>()

  if (opts.dataFile && existsSync(opts.dataFile)) {
    const saved = JSON.parse(readFileSync(opts.dataFile, 'utf8')) as { deals?: Deal[]; sessions?: Session[] }
    for (const d of saved.deals ?? []) if (checkQuote(d.quote) === null && d.quote.room === opts.identity.did) deals.set(d.quote.session, d)
    for (const s of saved.sessions ?? []) sessions.set(s.id, s)
  }
  function persist() {
    if (!opts.dataFile) return
    mkdirSync(dirname(opts.dataFile), { recursive: true })
    for (const [id, n] of live) {
      const s = sessions.get(id)
      if (s) s.negotiation = n.snapshot()
    }
    const tmp = `${opts.dataFile}.tmp`
    writeFileSync(tmp, JSON.stringify({ deals: [...deals.values()], sessions: [...sessions.values()] }), { mode: 0o600 })
    renameSync(tmp, opts.dataFile)
  }

  const wss = new WebSocketServer({ port: opts.port ?? 0, host: opts.host ?? '127.0.0.1', maxPayload: 16 * 1024 })
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve)
    wss.once('error', reject)
  })

  const send = (ws: WebSocket, msg: object) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }
  const connections = (s: Session, did?: string): WebSocket[] =>
    [...(present.get(s.id) ?? new Map<string, Set<WebSocket>>())].flatMap(([d, set]) => (did === undefined || d === did ? [...set] : []))
  const broadcast = (s: Session, msg: object) => {
    for (const ws of connections(s)) send(ws, msg)
  }

  // ---- Negotiation ------------------------------------------------------

  /** The running rules for a session, brought back from what was saved if need be. */
  function rules(s: Session): Negotiation | undefined {
    let n = live.get(s.id)
    if (!n && s.negotiation) {
      n = Negotiation.restore(s.negotiation)
      live.set(s.id, n)
    }
    return n
  }

  const deadlineOf = (s: Session) => s.createdAt + sessionTtlMs

  function view(s: Session, did: string): RoomState {
    const n = rules(s)
    const party = s.parties[did]
    return {
      t: 'state',
      session: s.id,
      room: opts.identity.did,
      status: s.status,
      ...(s.reason ? { reason: s.reason } : {}),
      ...(n ? { currency: n.currency, maxTurns: n.maxTurns, remaining: n.remaining, first: n.first } : {}),
      yourTurn: !!n && s.status === 'open' && n.mayMove(did),
      history: (n?.history ?? []).map(({ note, ...e }) => ({ ...e, ...(note !== undefined ? { untrustedNote: note } : {}) })),
      ...(n?.offer && s.status === 'open' ? { offer: n.offer } : {}),
      ...(s.quote && party && !party.quoteSig ? { sign: s.quote } : {}),
      deadline: new Date(deadlineOf(s)).toISOString(),
    }
  }

  /** Tells everyone who is connected where things stand, each from their own side. */
  function tell(s: Session) {
    for (const did of Object.keys(s.parties)) for (const ws of connections(s, did)) send(ws, view(s, did))
  }

  function end(s: Session, reason: string) {
    if (s.status === 'ended') return
    s.status = 'ended'
    s.reason = reason
    persist()
    broadcast(s, { t: 'end', session: s.id, reason })
    tell(s)
  }

  /** Ends a session whose time has run out. Sessions wait for their parties, but not for ever. */
  function expire(s: Session) {
    if (s.status !== 'ended' && deadlineOf(s) <= now()) end(s, 'expired')
  }

  function join(ws: WebSocket, challenge: string, req: JoinRequest): { session: Session; did: string } | { deal: Deal; did: string } | string {
    if (!req || typeof req.session !== 'string' || req.session.length < 16 || req.session.length > 128)
      return 'join needs a session id'
    if (!isDid(req.did) || !isDid(req.peer) || req.did === req.peer) return 'join needs your DID and a different peer DID'
    if (req.nonce !== challenge) return 'stale challenge'
    // The signature covers the mandate, the session and this room's challenge.
    if (!verifyObject(req.did, ROOM_JOIN_CONTEXT, req)) return 'bad signature'
    const bad = checkMandate(req.mandate)
    if (bad) return bad
    let bId: string | undefined
    if (req.beacon !== undefined) {
      const problem = checkBeacon(req.beacon, now())
      if (problem) return `beacon rejected: ${problem}`
      if (req.beacon.who !== req.did) return 'that beacon was lit by another key'
      bId = beaconId(req.beacon)
    }

    // A session that already produced a quote is over: its parties are shown the quote.
    const d = deal(req.session)
    if (d) return d.quote.parties.some((p) => p.did === req.did) ? { deal: d, did: req.did } : 'session is full'

    let s = sessions.get(req.session)
    if (s) expire(s)
    if (!s) {
      s = { id: req.session, createdAt: now(), parties: {}, status: 'waiting' }
      sessions.set(s.id, s)
    }
    const known = s.parties[req.did]
    if (known) {
      // Coming back. What was authorised at the start stands: a mandate cannot be loosened mid-way.
      if (known.peer !== req.peer || canonicalize(known.mandate) !== canonicalize(req.mandate)) return 'your mandate for this session is already set'
      if (bId && !known.beaconId) known.beaconId = bId
    } else {
      const others = Object.values(s.parties)
      if (others.length >= 2) return 'session is full'
      if (others.length === 1 && (others[0].peer !== req.did || others[0].did !== req.peer)) return 'parties do not name each other'
      if (s.status === 'ended') return `session is over: ${s.reason}`
      s.parties[req.did] = { did: req.did, peer: req.peer, beaconId: bId, mandate: req.mandate, bytes: 0 }
    }
    const here = present.get(s.id) ?? new Map<string, Set<WebSocket>>()
    here.set(req.did, (here.get(req.did) ?? new Set()).add(ws))
    present.set(s.id, here)
    send(ws, { t: 'joined', session: s.id, room: opts.identity.did })
    if (!known && Object.keys(s.parties).length === 2) start(s)
    persist()
    return { session: s, did: req.did }
  }

  function start(s: Session) {
    const [a, b] = Object.values(s.parties)
    if (!a.beaconId && !b.beaconId) return end(s, 'no-beacon')
    let n: Negotiation
    try {
      n = new Negotiation(a, b, roomMaxTurns)
    } catch {
      // Says only that the mandates do not fit together, never what they hold.
      return end(s, 'incompatible-mandates')
    }
    live.set(s.id, n)
    s.status = 'open'
    broadcast(s, { t: 'start', session: s.id, room: opts.identity.did, first: n.first, maxTurns: n.maxTurns, currency: n.currency })
  }

  function move(s: Session, party: Party, ws: WebSocket, m: Move) {
    const n = rules(s)
    if (!n || s.status !== 'open') return send(ws, { t: 'refused', reason: s.status === 'waiting' ? 'the other side has not joined yet' : 'not accepting moves now' })
    const result = n.move(party.did, m)
    if (!result.ok) {
      send(ws, { t: 'refused', reason: result.reason, remaining: result.remaining })
      if (result.over) end(s, n.endReason ?? 'turn-limit')
      else persist()
      return
    }
    const { note, ...event } = result.event
    // Free text is data, never instruction: it travels in its own labelled field.
    broadcast(s, { t: 'move', session: s.id, ...event, ...(note !== undefined ? { untrustedNote: note } : {}) })
    if (n.status === 'ended') return end(s, n.endReason!)
    if (n.status === 'agreed') {
      const price = n.agreedPrice!
      const side = (x: Party) => ({
        did: x.did,
        side: x.mandate.side,
        ...(x.beaconId ? { beacon: x.beaconId } : {}),
        approver: approverFor(x.mandate, x.did, price),
      })
      const [a, b] = Object.values(s.parties)
      const hold = Math.min(maxHoldMs, ...[a, b].map((x) => (x.mandate.holdSeconds !== undefined ? x.mandate.holdSeconds * 1000 : defaultHoldMs)))
      s.quote = {
        v: 1,
        kind: 'varde.quote',
        room: opts.identity.did,
        session: s.id,
        parties: [side(a), side(b)],
        terms: { price, currency: n.currency, ...(n.agreedTerms ? { conditions: n.agreedTerms } : {}) },
        turns: n.turns,
        at: new Date(now()).toISOString(),
        validUntil: new Date(now() + hold).toISOString(),
      }
      s.status = 'signing'
      broadcast(s, { t: 'sign', session: s.id, quote: s.quote })
    }
    persist()
  }

  function signed(s: Session, party: Party, ws: WebSocket, sig: unknown) {
    if (!s.quote || typeof sig !== 'string' || !verifyQuoteSig(party.did, s.quote, sig)) return send(ws, { t: 'refused', reason: 'bad quote signature' })
    party.quoteSig = sig
    const all = Object.values(s.parties)
    if (!all.every((x) => x.quoteSig)) return persist()
    const sigs: Record<string, string> = { [opts.identity.did]: signQuote(opts.identity, s.quote) }
    for (const x of all) sigs[x.did] = x.quoteSig!
    const quote: Quote = { ...s.quote, sigs }
    deals.set(s.id, { state: 'quoted', quote, approvals: {} })
    // The negotiation is over. Whoever is still connected now watches the quote.
    watchers.set(s.id, new Set(connections(s)))
    broadcast(s, { t: 'quote', session: s.id, quote })
    sessions.delete(s.id)
    live.delete(s.id)
    present.delete(s.id)
    persist()
  }

  // ---- Quotes ------------------------------------------------------------

  function statusOf(session: string, d: Deal): RoomStatus {
    return {
      t: 'status',
      session,
      state: d.state,
      quote: d.quote,
      approved: Object.keys(d.approvals),
      ...(d.withdrawnBy ? { withdrawnBy: d.withdrawnBy } : {}),
      ...(d.receipt ? { receipt: d.receipt } : {}),
    }
  }

  /** Looks a quote up, lapsing it first if its time has run out. */
  function deal(session: unknown): Deal | undefined {
    const d = typeof session === 'string' ? deals.get(session) : undefined
    if (d && d.state === 'quoted' && Date.parse(d.quote.validUntil) <= now()) {
      d.state = 'lapsed'
      persist()
      announce(session as string, d)
    }
    return d
  }

  function announce(session: string, d: Deal) {
    const status = statusOf(session, d)
    for (const ws of watchers.get(session) ?? []) send(ws, status)
  }

  function watch(ws: WebSocket, session: string) {
    const set = watchers.get(session) ?? new Set()
    set.add(ws)
    watchers.set(session, set)
  }

  function commit(ws: WebSocket, session: unknown, approval: Approval) {
    const d = deal(session)
    if (!d) return send(ws, { t: 'refused', reason: 'no quote for that session' })
    watch(ws, session as string)
    if (d.state === 'quoted') {
      const problem = checkApproval(approval, d.quote)
      if (problem) return send(ws, { t: 'refused', reason: problem })
      d.approvals[approval.party] = approval
      const [a, b] = d.quote.parties.map((p) => d.approvals[p.did])
      if (a && b) {
        d.receipt = issueReceipt(opts.identity, d.quote, [a, b], now())
        d.state = 'agreed'
      }
      persist()
    } else if (d.state !== 'agreed') return send(ws, { t: 'refused', reason: `the quote is ${d.state}` })
    announce(session as string, d)
  }

  function withdraw(ws: WebSocket, session: unknown, withdrawal: Withdrawal) {
    const d = deal(session)
    if (!d) return send(ws, { t: 'refused', reason: 'no quote for that session' })
    watch(ws, session as string)
    if (d.state === 'agreed') return send(ws, { t: 'refused', reason: 'the deal is already made' })
    if (d.state === 'quoted') {
      const problem = checkWithdrawal(withdrawal, d.quote)
      if (problem) return send(ws, { t: 'refused', reason: problem })
      d.state = 'withdrawn'
      d.withdrawnBy = withdrawal.party
      persist()
    }
    announce(session as string, d)
  }

  const sweep = setInterval(() => {
    for (const [session, d] of deals) {
      deal(session)
      // Dead quotes are kept a week for anyone still asking, then dropped.
      if ((d.state === 'lapsed' || d.state === 'withdrawn') && Date.parse(d.quote.validUntil) + 7 * DAY < now()) deals.delete(session)
    }
    for (const [id, s] of sessions) {
      expire(s)
      // A session that ended is remembered for a week, so a party that returns learns why.
      if (s.status === 'ended' && deadlineOf(s) + 7 * DAY < now()) {
        sessions.delete(id)
        live.delete(id)
      }
    }
  }, 1000)
  sweep.unref()

  wss.on('connection', (ws) => {
    const challenge = nonce()
    let at: { session: Session; did: string } | undefined
    send(ws, { t: 'challenge', nonce: challenge, room: opts.identity.did })
    ws.on('error', () => ws.terminate())
    ws.on('close', () => {
      // Leaving ends nothing. The session waits for its parties to come back.
      if (at) present.get(at.session.id)?.get(at.did)?.delete(ws)
      for (const set of watchers.values()) set.delete(ws)
    })
    ws.on('message', (data) => {
      const raw = data.toString()
      let m: Record<string, unknown>
      try {
        m = JSON.parse(raw)
        if (!m || typeof m !== 'object') throw new Error()
      } catch {
        return send(ws, { t: 'refused', reason: 'not JSON' })
      }
      // Quotes are handled on any connection: whoever holds a valid signed
      // approval or withdrawal may deliver it.
      if (m.t === 'commit') return commit(ws, m.session, m.approval as Approval)
      if (m.t === 'withdraw') return withdraw(ws, m.session, m.withdrawal as Withdrawal)
      if (m.t === 'status') {
        const d = deal(m.session)
        if (!d) return send(ws, { t: 'refused', reason: 'no quote for that session' })
        watch(ws, m.session as string)
        return send(ws, statusOf(m.session as string, d))
      }

      if (!at) {
        if (m.t !== 'join') return send(ws, { t: 'refused', reason: 'join first' })
        const result = join(ws, challenge, m as unknown as JoinRequest)
        if (typeof result === 'string') {
          send(ws, { t: 'refused', reason: result })
          return ws.close()
        }
        if ('deal' in result) {
          // The negotiation already produced a quote. Show it, and keep this party posted on it.
          const { deal: d, did } = result
          watch(ws, d.quote.session)
          send(ws, { t: 'joined', session: d.quote.session, room: opts.identity.did })
          const state: RoomState = { t: 'state', session: d.quote.session, room: opts.identity.did, status: 'quoted', yourTurn: false, history: [], quote: d.quote, deadline: d.quote.validUntil }
          void did
          send(ws, state)
          return send(ws, { t: 'quote', session: d.quote.session, quote: d.quote })
        }
        at = result
        const s = at.session
        send(ws, view(s, at.did))
        // What this party missed while away and still has to act on.
        if (s.status === 'ended') send(ws, { t: 'end', session: s.id, reason: s.reason })
        else if (s.quote && !s.parties[at.did].quoteSig) send(ws, { t: 'sign', session: s.id, quote: s.quote })
        return
      }
      const s = at.session
      const party = s.parties[at.did]
      if (s.status === 'ended') return send(ws, { t: 'end', session: s.id, reason: s.reason })
      party.bytes += Buffer.byteLength(raw)
      if (party.bytes > maxBytes) return end(s, 'byte-limit')
      if (m.t === 'move') move(s, party, ws, m.move as Move)
      else if (m.t === 'signed') signed(s, party, ws, m.sig)
      else return send(ws, { t: 'refused', reason: 'unknown message type' })
      // Everyone connected sees where things stand after each step, from their own side.
      if (sessions.has(s.id)) tell(s)
    })
  })

  const port = (wss.address() as { port: number }).port
  return {
    port,
    url: `ws://${opts.host ?? '127.0.0.1'}:${port}`,
    did: opts.identity.did,
    stats: () => ({ sessions: [...sessions.values()].filter((s) => s.status !== 'ended').length, quotes: [...deals.values()].filter((d) => d.state === 'quoted').length }),
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweep)
        for (const c of wss.clients) c.terminate()
        wss.close(() => resolve())
      }),
  }
}
