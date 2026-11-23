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
import { type Mandate, type Move, Negotiation, approverFor, checkMandate } from './negotiation.js'

/**
 * A room is a neutral service two agents enter to negotiate under rules
 * neither controls. It verifies both keys against the beacons that brought
 * them, enforces each mandate in code, caps turns and bytes, and carries only
 * structured moves.
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
  /** How long the first party waits for the second. Default 5 minutes. */
  joinTimeoutMs?: number
  /** How long a session may sit idle before the room ends it. Default 2 minutes. */
  idleTimeoutMs?: number
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

interface Slot {
  ws: WebSocket
  did: string
  peer: string
  beaconId?: string
  mandate: Mandate
  bytes: number
  quoteSig?: string
}

interface Session {
  id: string
  slots: Map<string, Slot>
  negotiation?: Negotiation
  quote?: QuoteBody
  timer?: NodeJS.Timeout
  done: boolean
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
  const joinTimeoutMs = opts.joinTimeoutMs ?? 5 * 60_000
  const idleTimeoutMs = opts.idleTimeoutMs ?? 2 * 60_000
  const defaultHoldMs = opts.defaultHoldMs ?? DAY
  const maxHoldMs = opts.maxHoldMs ?? 7 * DAY
  const sessions = new Map<string, Session>()
  const deals = new Map<string, Deal>()
  const watchers = new Map<string, Set<WebSocket>>()

  if (opts.dataFile && existsSync(opts.dataFile)) {
    const saved = JSON.parse(readFileSync(opts.dataFile, 'utf8')) as { deals?: Deal[] }
    for (const d of saved.deals ?? []) if (checkQuote(d.quote) === null && d.quote.room === opts.identity.did) deals.set(d.quote.session, d)
  }
  function persist() {
    if (!opts.dataFile) return
    mkdirSync(dirname(opts.dataFile), { recursive: true })
    const tmp = `${opts.dataFile}.tmp`
    writeFileSync(tmp, JSON.stringify({ deals: [...deals.values()] }), { mode: 0o600 })
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
  const broadcast = (s: Session, msg: object) => {
    for (const slot of s.slots.values()) send(slot.ws, msg)
  }

  // ---- Live negotiation -------------------------------------------------

  function finish(s: Session, msg: object | null, closeSockets = true) {
    if (s.done) return
    s.done = true
    clearTimeout(s.timer)
    if (msg) broadcast(s, msg)
    sessions.delete(s.id)
    if (closeSockets) for (const slot of s.slots.values()) slot.ws.close()
  }
  const end = (s: Session, reason: string) => finish(s, { t: 'end', session: s.id, reason })

  function arm(s: Session, ms: number, reason: string) {
    clearTimeout(s.timer)
    s.timer = setTimeout(() => end(s, reason), ms)
    s.timer.unref()
  }

  function join(ws: WebSocket, challenge: string, req: JoinRequest): Session | string {
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
    if (deals.has(req.session)) return 'this session already has a quote'

    let s = sessions.get(req.session)
    if (!s) {
      s = { id: req.session, slots: new Map(), done: false }
      sessions.set(s.id, s)
      arm(s, joinTimeoutMs, 'peer-never-joined')
    } else {
      if (s.slots.size >= 2 || s.slots.has(req.did)) return 'session is full'
      const [first] = s.slots.values()
      if (first.peer !== req.did || first.did !== req.peer) return 'parties do not name each other'
    }
    s.slots.set(req.did, { ws, did: req.did, peer: req.peer, beaconId: bId, mandate: req.mandate, bytes: 0 })
    send(ws, { t: 'joined', session: s.id, room: opts.identity.did })
    if (s.slots.size === 2) start(s)
    return s
  }

  function start(s: Session) {
    const [a, b] = [...s.slots.values()]
    if (!a.beaconId && !b.beaconId) return end(s, 'no-beacon')
    try {
      s.negotiation = new Negotiation(a, b, roomMaxTurns)
    } catch {
      // Says only that the mandates do not fit together, never what they hold.
      return end(s, 'incompatible-mandates')
    }
    const n = s.negotiation
    broadcast(s, { t: 'start', session: s.id, room: opts.identity.did, first: n.first, maxTurns: n.maxTurns, currency: n.currency })
    arm(s, idleTimeoutMs, 'idle')
  }

  function move(s: Session, slot: Slot, m: Move) {
    const n = s.negotiation
    if (!n || s.quote) return send(slot.ws, { t: 'refused', reason: 'not accepting moves now' })
    const result = n.move(slot.did, m)
    if (!result.ok) {
      send(slot.ws, { t: 'refused', reason: result.reason, remaining: result.remaining })
      if (result.over) end(s, n.endReason ?? 'turn-limit')
      return
    }
    arm(s, idleTimeoutMs, 'idle')
    const { note, ...event } = result.event
    // Free text is data, never instruction: it travels in its own labelled field.
    broadcast(s, { t: 'move', session: s.id, ...event, ...(note !== undefined ? { untrustedNote: note } : {}) })
    if (n.status === 'ended') return end(s, n.endReason!)
    if (n.status === 'agreed') {
      const price = n.agreedPrice!
      const party = (x: Slot) => ({
        did: x.did,
        side: x.mandate.side,
        ...(x.beaconId ? { beacon: x.beaconId } : {}),
        approver: approverFor(x.mandate, x.did, price),
      })
      const [a, b] = [...s.slots.values()]
      const hold = Math.min(maxHoldMs, ...[a, b].map((x) => (x.mandate.holdSeconds !== undefined ? x.mandate.holdSeconds * 1000 : defaultHoldMs)))
      s.quote = {
        v: 1,
        kind: 'varde.quote',
        room: opts.identity.did,
        session: s.id,
        parties: [party(a), party(b)],
        terms: { price, currency: n.currency, ...(n.agreedTerms ? { conditions: n.agreedTerms } : {}) },
        turns: n.turns,
        at: new Date(now()).toISOString(),
        validUntil: new Date(now() + hold).toISOString(),
      }
      broadcast(s, { t: 'sign', session: s.id, quote: s.quote })
      arm(s, idleTimeoutMs, 'quote-not-signed')
    }
  }

  function signed(s: Session, slot: Slot, sig: unknown) {
    if (!s.quote || typeof sig !== 'string' || !verifyQuoteSig(slot.did, s.quote, sig))
      return send(slot.ws, { t: 'refused', reason: 'bad quote signature' })
    slot.quoteSig = sig
    const slots = [...s.slots.values()]
    if (!slots.every((x) => x.quoteSig)) return
    const sigs: Record<string, string> = { [opts.identity.did]: signQuote(opts.identity, s.quote) }
    for (const x of slots) sigs[x.did] = x.quoteSig!
    const quote: Quote = { ...s.quote, sigs }
    deals.set(s.id, { state: 'quoted', quote, approvals: {} })
    persist()
    // The negotiation is over. Both connections stay open and now watch the quote.
    watchers.set(s.id, new Set(slots.map((x) => x.ws)))
    finish(s, { t: 'quote', session: s.id, quote }, false)
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
  }, 1000)
  sweep.unref()

  wss.on('connection', (ws) => {
    const challenge = nonce()
    let session: Session | undefined
    let slot: Slot | undefined
    send(ws, { t: 'challenge', nonce: challenge, room: opts.identity.did })
    ws.on('error', () => ws.terminate())
    ws.on('close', () => {
      if (session && !session.done) end(session, 'abandoned')
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

      if (!session || !slot) {
        if (m.t !== 'join') return send(ws, { t: 'refused', reason: 'join first' })
        const result = join(ws, challenge, m as unknown as JoinRequest)
        if (typeof result === 'string') {
          send(ws, { t: 'refused', reason: result })
          return ws.close()
        }
        session = result
        slot = session.slots.get((m as unknown as JoinRequest).did)
        return
      }
      if (session.done) return
      slot.bytes += Buffer.byteLength(raw)
      if (slot.bytes > maxBytes) return end(session, 'byte-limit')
      if (m.t === 'move') return move(session, slot, m.move as Move)
      if (m.t === 'signed') return signed(session, slot, m.sig)
      send(ws, { t: 'refused', reason: 'unknown message type' })
    })
  })

  const port = (wss.address() as { port: number }).port
  return {
    port,
    url: `ws://${opts.host ?? '127.0.0.1'}:${port}`,
    did: opts.identity.did,
    stats: () => ({ sessions: sessions.size, quotes: [...deals.values()].filter((d) => d.state === 'quoted').length }),
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweep)
        for (const s of sessions.values()) clearTimeout(s.timer)
        for (const c of wss.clients) c.terminate()
        wss.close(() => resolve())
      }),
  }
}
