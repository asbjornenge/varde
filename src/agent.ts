import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { type Beacon, type Intent, type Scope, beaconId, checkBeacon, isExpired, lightBeacon, mailboxOf, retractBeacon } from './core/beacon.js'
import { b64u, nonce, sha256 } from './core/bytes.js'
import { canonicalize } from './core/canonical.js'
import type { Identity } from './core/identity.js'
import { type Mail, mailHash, openMail, sealMail } from './core/mail.js'
import { type Approval, type Quote, type Receipt, approveQuote, checkApproval, withdrawQuote } from './core/receipt.js'
import type { Sealed } from './core/seal.js'
import type { Embedder } from './matcher/embed.js'
import { type Match, Matcher } from './matcher/matcher.js'
import { type ConcedeOptions, type Negotiator, concede } from './negotiator.js'
import { RelayClient } from './relay/client.js'
import { type RoomOutcome, type RoomView, commitQuote, enterRoom, quoteStatus, visitRoom, withdrawFromQuote } from './room/client.js'
import type { DealState } from './room/server.js'
import { type Mandate, type Move, checkMandate } from './room/negotiation.js'

export const ROOM_PROTOCOL = 'varde-room/1'
/** The most proof of work this agent will do to light one beacon: about half a minute. */
export const MAX_POW_BITS = 24

/** What one side tells the other it can use after first contact. */
export interface Supports {
  protocols: string[]
  rooms: string[]
  trust: string[]
}

/** The result of a completed handshake: a counterpart whose key has been proven. */
export interface Contact {
  session: string
  role: 'lighter' | 'responder'
  peer: string
  /** Id of this agent's own beacon in the match, if it has one. */
  myBeacon?: string
  peerBeacon?: Beacon
  /** Where to send the counterpart sealed mail: their relay and the key to seal to. */
  reach?: { relay: string; encKey: string }
  /** The room both sides accept, or null if they will deal directly. */
  room: string | null
  protocol: string | null
  at: string
}

/** A quote this agent holds, and where it stands as far as the agent last heard. */
export interface HeldQuote {
  quote: Quote
  /** The room that issued it and decides it. */
  room: string
  state: DealState
  /** Parties whose approval the room holds. */
  approved: string[]
  receipt?: Receipt
}

/** A note exchanged with a contact, outside any room: a question, an answer, a detail. */
export interface Message {
  session: string
  from: 'me' | 'them'
  text: string
  at: string
}

export const MAX_MESSAGE_CHARS = 1000
/** Most messages kept from each side of one contact. Beyond this, sending is refused and incoming ones are dropped. */
export const MAX_MESSAGES_PER_SIDE = 30

/** What `news` has already reported, so each thing is told once. */
interface Seen {
  contacts: string[]
  messages: number
  turns: Record<string, string>
  quotes: Record<string, string>
}

export interface News {
  contacts: Contact[]
  messages: Message[]
  negotiations: ({ session: string } & RoomView)[]
  quotes: HeldQuote[]
}

export interface AgentState {
  beacons: Beacon[]
  contacts: Contact[]
  receipts: Receipt[]
  quotes?: HeldQuote[]
  messages?: Message[]
  negotiations?: Record<string, Mandate>
  /** What the owner's agent has already been told about, for `news`. */
  seen?: Seen
}

export interface AgentStore {
  load(): AgentState | undefined
  save(state: AgentState): void
}

export function fileStore(path: string): AgentStore {
  return {
    load: () => (existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as AgentState) : undefined),
    save: (state) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 })
    },
  }
}

export interface AgentOptions {
  identity: Identity
  /** The relay this agent publishes to and receives mail on. */
  relayUrl: string
  /** Other relays to read beacons from when listening. */
  listenRelays?: string[]
  /** Rooms this agent is willing to use, most preferred first. */
  rooms?: string[]
  embedder?: Embedder
  store?: AgentStore
  handshakeTimeoutMs?: number
  /**
   * DID of the owner's key. Deals then need the owner's approval, except at
   * prices covered by `autoCommit`. The owner's private key is never given
   * to the agent.
   */
  owner?: string
  /** A price at which the agent may approve alone: at or below it when paying, at or above when receiving. */
  autoCommit?: number
  /** Decide whether to answer a hello. Default: answer every valid one. */
  acceptHello?: (hello: { from: string; answering: Beacon; beacon?: Beacon }) => boolean
}

export interface LightInput {
  what: string
  intent?: Intent
  tags?: string[]
  scope?: Scope
  /** How long the beacon burns. Give this or `expires`. */
  ttlMs?: number
  expires?: string
  rooms?: string[]
  proofs?: unknown[]
}

export interface ListenQuery {
  /** Id of one of your own beacons: find its complements. */
  beacon?: string
  /** Or free text. */
  text?: string
  intent?: Intent
  where?: string
  limit?: number
  minScore?: number
}

export interface NegotiateInput extends ConcedeOptions {
  side: Mandate['side']
  limit: number
  currency: string
  maxTurns?: number
  /** Conditions the owner insists on: each key lists the values it will agree to. */
  require?: Mandate['terms']
  /** Pass the counterpart's free text to the negotiator. Off by default. */
  showNotes?: boolean
  /** How long the quote should stand, in seconds. The room uses the shortest in play. */
  holdSeconds?: number
  /** Approve the quote at once with the agent's own key, where the mandate allows it. Off by default. */
  commit?: boolean
  /** Replace the built-in scripted negotiator. */
  negotiator?: Negotiator
  timeoutMs?: number
  onEvent?: (e: Record<string, unknown>) => void
}

interface HelloBody {
  answering: string
  beacon?: Beacon
  replyTo: { relay: string; encKey: string }
  nonce: string
  supports: Supports
}

interface PendingOut {
  target: Beacon
  own?: Beacon
  nonce: string
  supports: Supports
  session?: string
  contact?: Contact
  resolve: (c: Contact) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

const sameMatch = (c: Contact, peer: string, mine?: string, theirs?: string) =>
  c.peer === peer && c.myBeacon === mine && (c.peerBeacon ? beaconId(c.peerBeacon) : undefined) === theirs

interface PendingIn {
  hello: Mail<HelloBody>
  answering: Beacon
  nonce: string
  supports: Supports
  at: number
}

const HELLO_MAX_AGE_MS = 10 * 60_000
const strings = (a: unknown): string[] => (Array.isArray(a) ? a.filter((s): s is string => typeof s === 'string').slice(0, 32) : [])
const asSupports = (s: unknown): Supports => {
  const x = (s ?? {}) as Record<string, unknown>
  return { protocols: strings(x.protocols), rooms: strings(x.rooms), trust: strings(x.trust) }
}

/** The overlap both sides compute independently: the lighter's order of preference wins. */
export function chooseOverlap(lighter: Supports, responder: Supports): { room: string | null; protocol: string | null } {
  return {
    room: lighter.rooms.find((r) => responder.rooms.includes(r)) ?? null,
    protocol: lighter.protocols.find((p) => responder.protocols.includes(p)) ?? null,
  }
}

export const sessionId = (helloHash: string, welcomeHash: string): string =>
  b64u(sha256(canonicalize({ hello: helloHash, welcome: welcomeHash })))

/**
 * One agent on the network: it lights beacons, listens for complements,
 * completes the handshake over sealed mail and sends a sandboxed negotiator
 * into a room.
 *
 * The handshake proves both keys. Each side signs the other's fresh nonce:
 *
 *   1. hello    responder -> lighter   names the beacon, own key, nonce R
 *   2. welcome  lighter -> responder   echoes nonce R, sends nonce L, supports
 *   3. confirm  responder -> lighter   echoes nonce L, states the overlap
 *   4. ack      lighter -> responder   agrees the overlap, or stays silent
 */
export class Agent extends EventEmitter {
  readonly identity: Identity
  readonly relayUrl: string
  readonly rooms: string[]
  readonly beacons = new Map<string, Beacon>()
  readonly contacts = new Map<string, Contact>()
  readonly receipts: Receipt[] = []
  readonly quotes = new Map<string, HeldQuote>()
  /** The mandate given for each negotiation this agent has entered, so every visit presents the same one. */
  readonly negotiations = new Map<string, Mandate>()
  private seen: Seen = { contacts: [], messages: 0, turns: {}, quotes: {} }
  readonly messages: Message[] = []
  private relays = new Map<string, RelayClient>()
  private pendingOut = new Map<string, PendingOut>()
  private pendingIn = new Map<string, PendingIn>()
  private seenHellos = new Map<string, number>()
  private queue: Promise<void> = Promise.resolve()
  private closed = false
  private connecting?: Promise<RelayClient>
  private retry?: NodeJS.Timeout

  private constructor(private opts: AgentOptions) {
    super()
    this.identity = opts.identity
    this.relayUrl = opts.relayUrl
    this.rooms = opts.rooms ?? []
    const saved = opts.store?.load()
    for (const b of saved?.beacons ?? []) if (!isExpired(b)) this.beacons.set(beaconId(b), b)
    for (const c of saved?.contacts ?? []) this.contacts.set(c.session, c)
    this.receipts.push(...(saved?.receipts ?? []))
    for (const q of saved?.quotes ?? []) this.quotes.set(q.quote.session, q)
    this.messages.push(...(saved?.messages ?? []))
    for (const [id, m] of Object.entries(saved?.negotiations ?? {})) this.negotiations.set(id, m)
    if (saved?.seen) this.seen = saved.seen
  }

  static async start(opts: AgentOptions): Promise<Agent> {
    const agent = new Agent(opts)
    await agent.home()
    return agent
  }

  get did() {
    return this.identity.did
  }

  private save() {
    this.opts.store?.save({ beacons: [...this.beacons.values()], contacts: [...this.contacts.values()], receipts: this.receipts, quotes: [...this.quotes.values()], messages: this.messages, negotiations: Object.fromEntries(this.negotiations), seen: this.seen })
  }

  /** The logged-in connection to this agent's own relay, reconnecting if it dropped. */
  private async home(): Promise<RelayClient> {
    if (this.closed) throw new Error('agent is closed')
    const existing = this.relays.get(this.relayUrl)
    if (existing && !existing.isClosed) return existing
    this.connecting ??= this.connectHome().finally(() => (this.connecting = undefined))
    return this.connecting
  }

  private async connectHome(): Promise<RelayClient> {
    const client = await RelayClient.connect(this.relayUrl, this.identity)
    if (this.closed) {
      client.close()
      throw new Error('agent is closed')
    }
    this.relays.set(this.relayUrl, client)
    // A relay may come back empty, or be a different one at the same address.
    // Beacons are self-contained, so lighting them again is all it takes.
    for (const [id, b] of this.beacons) {
      if (isExpired(b)) this.beacons.delete(id)
      else await client.publish(b).catch((e) => this.emit('warning', e))
    }
    await client.onMail((m) => {
      this.queue = this.queue
        .then(() => this.receive(m.sealed))
        .catch((e) => this.emit('warning', e))
        .then(() => client.ack([m.id]).catch(() => {}))
    })
    client.onClose(() => this.reconnect(200))
    return client
  }

  /** Mail only arrives over a live connection, so a lost one is restored without being asked. */
  private reconnect(delayMs: number) {
    if (this.closed) return
    clearTimeout(this.retry)
    this.retry = setTimeout(() => {
      this.home().catch(() => this.reconnect(Math.min(delayMs * 2, 5000)))
    }, delayMs)
    this.retry.unref()
  }

  private async relay(url: string): Promise<RelayClient> {
    if (url === this.relayUrl) return this.home()
    const existing = this.relays.get(url)
    if (existing && !existing.isClosed) return existing
    const client = await RelayClient.connect(url)
    this.relays.set(url, client)
    return client
  }

  private async post(relayUrl: string, to: string, encKey: string, type: string, body: unknown): Promise<Mail> {
    const { mail, sealed } = sealMail(this.identity, to, encKey, type, body)
    await (await this.relay(relayUrl)).sendMail(to, sealed)
    return mail
  }

  private supports(beacon?: Beacon): Supports {
    return {
      protocols: beacon?.accepts?.protocols ?? [ROOM_PROTOCOL],
      rooms: beacon?.accepts?.rooms ?? this.rooms,
      trust: beacon?.accepts?.trust ?? [],
    }
  }

  /** Lights a beacon: signs it, publishes it to the relay and keeps it. */
  async light(input: LightInput): Promise<{ id: string; beacon: Beacon }> {
    const expires = input.expires ?? new Date(Date.now() + (input.ttlMs ?? 24 * 60 * 60_000)).toISOString()
    const structured = input.intent !== undefined || (input.tags?.length ?? 0) > 0
    // Do whatever work the relay asks for, up to a point: a relay cannot make us mine without end.
    const home = await this.home()
    if (home.policy.powBits > MAX_POW_BITS) throw new Error(`the relay asks for ${home.policy.powBits} bits of proof of work, which is more than this agent will do`)
    const beacon = lightBeacon(this.identity, {
      pow: home.policy.powBits || undefined,
      what: structured ? { text: input.what, tags: input.tags?.length ? input.tags : undefined, intent: input.intent } : input.what,
      scope: input.scope && Object.keys(input.scope).length ? input.scope : undefined,
      expires,
      reachMe: [{ kind: 'mailbox', relay: this.relayUrl, encKey: this.identity.encPub }],
      proofs: input.proofs,
      accepts: { rooms: input.rooms ?? this.rooms, protocols: [ROOM_PROTOCOL] },
    })
    const id = await home.publish(beacon)
    this.beacons.set(id, beacon)
    this.emit('lit', { id, beacon })
    this.save()
    return { id, beacon }
  }

  /**
   * Finds beacons that complement one of yours, or that fit a text query.
   * Matching runs locally on beacons read straight from the relay.
   */
  async listen(q: ListenQuery): Promise<Match[]> {
    const own = q.beacon ? this.beacons.get(q.beacon) : undefined
    if (q.beacon && !own) throw new Error(`no live beacon of yours with id ${q.beacon}`)
    const found = new Map<string, Beacon>()
    for (const url of new Set([this.relayUrl, ...(this.opts.listenRelays ?? [])]))
      for (const b of await (await this.relay(url)).query({})) if (b.who !== this.did) found.set(beaconId(b), b)
    const all = [...found.values()]
    const matcher = new Matcher(this.opts.embedder)
    await matcher.add(all)
    return matcher.match({ beacon: own, text: q.text, intent: q.intent, where: q.where, limit: q.limit, minScore: q.minScore })
  }

  /** Fetches one live beacon from the relay by id. */
  async find(id: string): Promise<Beacon | undefined> {
    for (const url of new Set([this.relayUrl, ...(this.opts.listenRelays ?? [])])) {
      const [found] = await (await this.relay(url)).query({ ids: [id] })
      if (found) return found
    }
    return undefined
  }

  /**
   * Answers a beacon: runs the handshake as responder and resolves once both
   * keys are proven and the overlap is agreed. `as` names the beacon of yours
   * that this is a match for, if any.
   */
  async contact(target: Beacon, opts: { as?: string } = {}): Promise<Contact> {
    const problem = checkBeacon(target)
    if (problem) throw new Error(`cannot contact that beacon: ${problem}`)
    if (target.who === this.did) throw new Error('that is your own beacon')
    const box = mailboxOf(target)
    if (!box) throw new Error('that beacon has no mailbox; direct endpoints are not implemented yet')
    const own = opts.as ? this.beacons.get(opts.as) : undefined
    if (opts.as && !own) throw new Error(`no live beacon of yours with id ${opts.as}`)
    await this.home()
    // One handshake per match: answering the same beacon again returns the contact already made.
    for (const c of this.contacts.values()) if (sameMatch(c, target.who, opts.as, beaconId(target))) return c

    const supports = this.supports(own)
    const body: HelloBody = {
      answering: beaconId(target),
      beacon: own,
      replyTo: { relay: this.relayUrl, encKey: this.identity.encPub },
      nonce: nonce(),
      supports,
    }
    const { mail, sealed } = sealMail(this.identity, target.who, box.encKey, 'varde.hello', body)
    const key = mailHash(mail)
    const result = new Promise<Contact>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingOut.delete(key)
        reject(new Error('no answer: the handshake timed out'))
      }, this.opts.handshakeTimeoutMs ?? 30_000)
      this.pendingOut.set(key, { target, own, nonce: body.nonce, supports, resolve, reject, timer })
    })
    try {
      await (await this.relay(box.relay)).sendMail(target.who, sealed)
    } catch (e) {
      const p = this.pendingOut.get(key)
      if (p) clearTimeout(p.timer)
      this.pendingOut.delete(key)
      result.catch(() => {})
      throw e
    }
    return result
  }

  private async receive(sealed: Sealed): Promise<void> {
    const mail = openMail(this.identity, sealed)
    if (!mail) return
    const body = (mail.body ?? {}) as Record<string, any>
    switch (mail.type) {
      case 'varde.hello':
        return this.onHello(mail as Mail<HelloBody>)
      case 'varde.welcome':
        return this.onWelcome(mail, body)
      case 'varde.confirm':
        return this.onConfirm(mail, body)
      case 'varde.ack':
        return this.onAck(mail, body)
      case 'varde.message':
        return this.onMessage(mail, body)
    }
  }

  // Step 1 arrives at the lighter. Answer with step 2.
  private async onHello(mail: Mail<HelloBody>) {
    const now = Date.now()
    for (const [h, t] of this.seenHellos) if (t + HELLO_MAX_AGE_MS < now) this.seenHellos.delete(h)
    for (const [h, p] of this.pendingIn) if (p.at + HELLO_MAX_AGE_MS < now) this.pendingIn.delete(h)

    const body = mail.body
    const helloHash = mailHash(mail)
    if (Math.abs(now - Date.parse(mail.at)) > HELLO_MAX_AGE_MS || this.seenHellos.has(helloHash)) return
    const answering = this.beacons.get(body?.answering)
    if (!answering || isExpired(answering, now)) return
    if (typeof body.nonce !== 'string' || typeof body.replyTo?.relay !== 'string' || typeof body.replyTo?.encKey !== 'string') return
    // A responder that presents a beacon must have lit it.
    if (body.beacon !== undefined && (checkBeacon(body.beacon, now) !== null || body.beacon.who !== mail.from)) return
    if (this.opts.acceptHello && !this.opts.acceptHello({ from: mail.from, answering, beacon: body.beacon })) return
    if (this.pendingIn.size >= 500) return
    this.seenHellos.set(helloHash, now)

    // Crossing contact: both sides lit a beacon and each answered the other's
    // at the same moment. Only one handshake may survive, or the same match
    // If ours has already been answered it is the one in progress; otherwise
    // the hello from the lower DID wins. The loser's `contact()` call is
    // resolved by the surviving handshake.
    if (body.beacon) {
      const theirs = beaconId(body.beacon)
      for (const p of this.pendingOut.values())
        if (beaconId(p.target) === theirs && p.own && beaconId(p.own) === body.answering && (p.session || this.did < mail.from)) return
    }

    const supports = this.supports(answering)
    const mine = nonce()
    const welcome = await this.post(body.replyTo.relay, mail.from, body.replyTo.encKey, 'varde.welcome', {
      answering: body.answering,
      hello: helloHash,
      echo: body.nonce,
      nonce: mine,
      supports,
    })
    this.pendingIn.set(mailHash(welcome), { hello: mail, answering, nonce: mine, supports, at: now })
  }

  // Step 2 arrives at the responder. The lighter has signed our nonce with the
  // beacon's key, so it controls the contact point. Answer with step 3.
  private async onWelcome(mail: Mail, body: Record<string, any>) {
    const p = this.pendingOut.get(body.hello)
    if (!p || p.session) return
    if (mail.from !== p.target.who || body.echo !== p.nonce || body.answering !== beaconId(p.target)) return
    if (typeof body.nonce !== 'string') return
    const box = mailboxOf(p.target)!
    const welcomeHash = mailHash(mail)
    const chosen = chooseOverlap(asSupports(body.supports), p.supports)
    p.session = sessionId(body.hello, welcomeHash)
    p.contact = {
      session: p.session,
      role: 'responder',
      peer: p.target.who,
      myBeacon: p.own ? beaconId(p.own) : undefined,
      peerBeacon: p.target,
      reach: { relay: box.relay, encKey: box.encKey },
      room: chosen.room,
      protocol: chosen.protocol,
      at: new Date().toISOString(),
    }
    await this.post(box.relay, p.target.who, box.encKey, 'varde.confirm', {
      answering: body.answering,
      welcome: welcomeHash,
      echo: body.nonce,
      chosen,
      session: p.session,
    })
  }

  // Step 3 arrives at the lighter. The responder has signed our nonce, so it
  // controls its key too. Check the overlap ourselves, then send step 4.
  private async onConfirm(mail: Mail, body: Record<string, any>) {
    const p = this.pendingIn.get(body.welcome)
    if (!p || mail.from !== p.hello.from || body.echo !== p.nonce) return
    this.pendingIn.delete(body.welcome)
    const chosen = chooseOverlap(p.supports, asSupports(p.hello.body.supports))
    const session = sessionId(mailHash(p.hello), body.welcome)
    if (body.session !== session || canonicalize(body.chosen ?? null) !== canonicalize(chosen)) return
    const contact: Contact = {
      session,
      role: 'lighter',
      peer: mail.from,
      myBeacon: beaconId(p.answering),
      peerBeacon: p.hello.body.beacon,
      reach: { relay: p.hello.body.replyTo.relay, encKey: p.hello.body.replyTo.encKey },
      room: chosen.room,
      protocol: chosen.protocol,
      at: new Date().toISOString(),
    }
    this.contacts.set(session, contact)
    this.save()
    const reply = p.hello.body.replyTo
    await this.post(reply.relay, mail.from, reply.encKey, 'varde.ack', { session, confirm: mailHash(mail) })
    this.emit('contact', contact)
    // A crossing hello of our own for the same match is answered by this contact instead.
    for (const [key, out] of this.pendingOut) {
      if (!sameMatch(contact, out.target.who, out.own && beaconId(out.own), beaconId(out.target))) continue
      clearTimeout(out.timer)
      this.pendingOut.delete(key)
      out.resolve(contact)
    }
  }

  // Step 4 arrives at the responder: the lighter agrees.
  private async onAck(mail: Mail, body: Record<string, any>) {
    for (const [key, p] of this.pendingOut) {
      if (!p.session || p.session !== body.session || mail.from !== p.target.who) continue
      clearTimeout(p.timer)
      this.pendingOut.delete(key)
      this.contacts.set(p.session, p.contact!)
      this.save()
      this.emit('contact', p.contact!)
      p.resolve(p.contact!)
      return
    }
  }

  /**
   * Sends a contact a short note over sealed mail: a question before
   * negotiating, an answer, a detail the beacon left out. It commits nobody
   * and is not part of any quote.
   */
  async say(session: string, text: string): Promise<Message> {
    const contact = this.contacts.get(session)
    if (!contact) throw new Error(`no contact with session ${session}`)
    if (!contact.reach) throw new Error('this contact was made before messages existed; contact them again first')
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_MESSAGE_CHARS) throw new Error(`a message is 1 to ${MAX_MESSAGE_CHARS} characters`)
    if (this.messages.filter((m) => m.session === session && m.from === 'me').length >= MAX_MESSAGES_PER_SIDE)
      throw new Error('you have sent this contact as many messages as one contact allows')
    await this.post(contact.reach.relay, contact.peer, contact.reach.encKey, 'varde.message', { session, text })
    const message: Message = { session, from: 'me', text, at: new Date().toISOString() }
    this.messages.push(message)
    this.save()
    return message
  }

  // A note from a contact. Only the counterpart of that very session may add to it.
  private async onMessage(mail: Mail, body: Record<string, any>) {
    const contact = this.contacts.get(body.session)
    if (!contact || mail.from !== contact.peer) return
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > MAX_MESSAGE_CHARS) return
    if (this.messages.filter((m) => m.session === contact.session && m.from === 'them').length >= MAX_MESSAGES_PER_SIDE) return
    const message: Message = { session: contact.session, from: 'them', text: body.text, at: new Date().toISOString() }
    this.messages.push(message)
    this.save()
    this.emit('message', message)
  }

  /** Resolves when a contact next sends a note, or with undefined after `timeoutMs`. */
  waitForMessage(session: string | undefined, timeoutMs: number): Promise<Message | undefined> {
    return new Promise((resolve) => {
      const on = (m: Message) => {
        if (session && m.session !== session) return
        clearTimeout(timer)
        this.off('message', on)
        resolve(m)
      }
      const timer = setTimeout(() => {
        this.off('message', on)
        resolve(undefined)
      }, timeoutMs)
      this.on('message', on)
    })
  }

  /** Resolves with the next contact that satisfies `test`, including ones already made. */
  waitForContact(test: (c: Contact) => boolean = () => true, timeoutMs = 30_000): Promise<Contact> {
    for (const c of this.contacts.values()) if (test(c)) return Promise.resolve(c)
    return new Promise((resolve, reject) => {
      const on = (c: Contact) => {
        if (!test(c)) return
        clearTimeout(timer)
        this.off('contact', on)
        resolve(c)
      }
      const timer = setTimeout(() => {
        this.off('contact', on)
        reject(new Error('no contact arrived in time'))
      }, timeoutMs)
      this.on('contact', on)
    })
  }

  /**
   * Sends a sandboxed negotiator into the room agreed in the handshake. The
   * negotiator receives the mandate and the structured moves, and nothing else
   * this agent knows.
   */
  async negotiate(session: string, input: NegotiateInput): Promise<RoomOutcome> {
    const contact = this.contacts.get(session)
    if (!contact) throw new Error(`no contact with session ${session}`)
    if (!contact.room) throw new Error('this contact has no room in common; deal directly instead')
    const outcome = await enterRoom({
      roomUrl: contact.room,
      identity: this.identity,
      session,
      peer: contact.peer,
      beacon: contact.myBeacon ? this.beacons.get(contact.myBeacon) : undefined,
      mandate: {
        side: input.side, currency: input.currency, limit: input.limit, maxTurns: input.maxTurns, terms: input.require,
        owner: this.opts.owner, autoCommit: this.opts.owner ? this.opts.autoCommit : undefined, holdSeconds: input.holdSeconds,
      },
      commit: input.commit,
      negotiator: input.negotiator ?? concede({ target: input.target, step: input.step, unit: input.unit, terms: input.terms }),
      showNotes: input.showNotes,
      timeoutMs: input.timeoutMs,
      onEvent: input.onEvent,
    })
    if (outcome.outcome === 'quoted') this.hold({ quote: outcome.quote, room: contact.room, state: 'quoted', approved: [] })
    if (outcome.outcome === 'agreed')
      this.hold({ quote: outcome.receipt.quote, room: contact.room, state: 'agreed', approved: outcome.receipt.approvals.map((a) => a.party), receipt: outcome.receipt })
    return outcome
  }

  /**
   * Looks in on a negotiation, and optionally makes one move. The first visit
   * must give the mandate; it is remembered and presented on every later
   * visit, and the room refuses any attempt to change it. The parties do not
   * have to be there together: make a move, leave, and look in again later.
   */
  async visit(session: string, o: { mandate?: Pick<Mandate, 'side' | 'currency' | 'limit' | 'terms' | 'holdSeconds'>; move?: Move } = {}): Promise<RoomView> {
    const contact = this.contacts.get(session)
    if (!contact) throw new Error(`no contact with session ${session}`)
    if (!contact.room) throw new Error('this contact has no room in common; deal directly instead')
    let mandate = this.negotiations.get(session)
    if (!mandate) {
      if (!o.mandate) throw new Error('say which side you are on, the currency and your limit the first time you enter a negotiation')
      mandate = { ...o.mandate, owner: this.opts.owner, autoCommit: this.opts.owner ? this.opts.autoCommit : undefined }
      const problem = checkMandate(mandate)
      if (problem) throw new Error(problem)
      // Drop undefined fields so the mandate is byte-for-byte the same on every visit.
      mandate = JSON.parse(JSON.stringify(mandate)) as Mandate
    }
    const view = await visitRoom({
      roomUrl: contact.room,
      identity: this.identity,
      session,
      peer: contact.peer,
      beacon: contact.myBeacon ? this.beacons.get(contact.myBeacon) : undefined,
      mandate,
      move: o.move,
    })
    // Remembered only once the room has accepted it, so a refused first visit can be retried with other values.
    if (!this.negotiations.has(session)) {
      this.negotiations.set(session, mandate)
      this.save()
    }
    if (view.quote && !this.quotes.has(session)) this.hold({ quote: view.quote, room: contact.room, state: 'quoted', approved: [] })
    return view
  }

  /**
   * What has happened since this was last asked: new contacts, new notes,
   * negotiations where it is now this side's turn, and quotes that changed.
   * Made for an agent that is only awake now and then and asks on waking.
   */
  async news(): Promise<News> {
    const contacts = [...this.contacts.values()].filter((c) => !this.seen.contacts.includes(c.session))
    const messages = this.messages.slice(this.seen.messages).filter((m) => m.from === 'them')
    const negotiations: News['negotiations'] = []
    for (const session of this.negotiations.keys()) {
      if (this.quotes.has(session)) continue
      const view = await this.visit(session).catch(() => undefined)
      if (!view) continue
      // Worth telling when something moved: a new move, a turn that became ours, an ending.
      const mark = `${view.status}/${view.history.length}/${view.yourTurn}`
      if (this.seen.turns[session] !== mark) negotiations.push({ session, ...view })
      this.seen.turns[session] = mark
    }
    const quotes: HeldQuote[] = []
    for (const q of [...this.quotes.values()]) {
      const now = q.state === 'quoted' ? await this.refresh(q.quote.session).catch(() => q) : q
      const mark = `${now.state}/${now.approved.length}`
      if (this.seen.quotes[now.quote.session] !== mark) quotes.push(now)
      this.seen.quotes[now.quote.session] = mark
    }
    this.seen.contacts = [...this.contacts.keys()]
    this.seen.messages = this.messages.length
    this.save()
    return { contacts, messages, negotiations, quotes }
  }

  /**
   * Puts a beacon out before its time. The relay stops serving it and will
   * not take it back. Contacts and quotes already made are unaffected.
   */
  async douse(id: string): Promise<void> {
    const beacon = this.beacons.get(id)
    if (!beacon) throw new Error(`no live beacon of yours with id ${id}`)
    await (await this.home()).retract(retractBeacon(this.identity, beacon))
    this.beacons.delete(id)
    this.save()
    this.emit('doused', { id, beacon })
  }

  private hold(q: HeldQuote): HeldQuote {
    this.quotes.set(q.quote.session, q)
    if (q.receipt && !this.receipts.some((r) => r.quote.session === q.quote.session)) this.receipts.push(q.receipt)
    this.save()
    return q
  }

  /**
   * The quote for a session. A quote is issued when the second party signs,
   * which may be while this agent is away, so if none is held yet the room is
   * asked before giving up.
   */
  private async held(session: string): Promise<HeldQuote> {
    if (!this.quotes.has(session) && this.negotiations.has(session)) await this.visit(session).catch(() => {})
    const q = this.quotes.get(session)
    if (!q) throw new Error(`no quote for session ${session}`)
    return q
  }

  /** The owner whose approval deals need, if any. */
  get owner(): string | undefined {
    return this.opts.owner
  }

  /** Names, changes or removes the owner. Applies to quotes negotiated from now on. */
  setOwner(owner: string | undefined, autoCommit?: number) {
    this.opts = { ...this.opts, owner, autoCommit }
  }

  /** Asks the room where a quote stands: still open, approved by whom, made, withdrawn or lapsed. */
  async refresh(session: string): Promise<HeldQuote> {
    const q = await this.held(session)
    if (q.state !== 'quoted') return q
    const s = await quoteStatus(q.room, session, q.quote)
    return this.hold({ ...q, state: s.state, approved: s.approved, receipt: s.receipt })
  }

  /**
   * Says a binding yes to a quote. Pass the owner's signed approval when the
   * quote requires the owner's key; without one the agent signs itself, which
   * the room accepts only if the quote names the agent as approver. The deal
   * is made once the other side has approved as well.
   */
  async commit(session: string, approval?: Approval): Promise<HeldQuote> {
    const q = await this.held(session)
    const mine = q.quote.parties.find((p) => p.did === this.did)!
    if (!approval && mine.approver !== this.did)
      throw new Error('this quote needs the owner\'s approval: the agent may not commit to it alone')
    const a = approval ?? approveQuote(this.identity, q.quote, this.did)
    const problem = checkApproval(a, q.quote)
    if (problem) throw new Error(`that approval does not fit this quote: ${problem}`)
    const s = await commitQuote(q.room, q.quote, a)
    return this.hold({ ...q, state: s.state, approved: s.approved, receipt: s.receipt })
  }

  /** Says no to a quote. Needs no owner. Has no effect once the deal is made. */
  async withdraw(session: string): Promise<HeldQuote> {
    const q = await this.held(session)
    const s = await withdrawFromQuote(q.room, q.quote, withdrawQuote(this.identity, q.quote))
    return this.hold({ ...q, state: s.state, approved: s.approved, receipt: s.receipt })
  }

  close() {
    this.closed = true
    clearTimeout(this.retry)
    for (const p of this.pendingOut.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('agent is closed'))
    }
    this.pendingOut.clear()
    for (const r of this.relays.values()) r.close()
  }
}
