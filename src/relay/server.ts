import { timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { type WebSocket, WebSocketServer } from 'ws'
import { type Beacon, beaconId, checkBeacon, isExpired } from '../core/beacon.js'
import { nonce } from '../core/bytes.js'
import { type Filter, isFilter, matchesFilter } from '../core/filter.js'
import { powBits } from '../core/pow.js'
import { isDid, verify } from '../core/identity.js'
import { type Sealed, isSealed } from '../core/seal.js'

/**
 * A relay does two things: it accepts published beacons and serves filtered
 * subscriptions. It also holds sealed mail for agents that are not online.
 * It keeps no accounts and decides nothing: beacons are self-authenticating
 * and mail is ciphertext, so a relay can be replaced at any time.
 */
export interface RelayOptions {
  port?: number
  host?: string
  /** Longest time a beacon may stay lit. Default 180 days. */
  maxTtlMs?: number
  /** Most live beacons one key may hold. Default 200. */
  maxPerWho?: number
  /** How long undelivered mail is kept. Default 24 hours. */
  mailTtlMs?: number
  maxMailPerRecipient?: number
  maxSubsPerConnection?: number
  sweepMs?: number
  /** Bits of proof of work a beacon must carry to be accepted. Default 0: none. */
  minPowBits?: number
  /** Messages one connection may send: a burst, then a steady rate per second. Default 60 and 20. */
  messageBurst?: number
  messagesPerSecond?: number
  /** Most simultaneous connections from one address. Default 200. */
  maxConnectionsPerAddress?: number
  /** Beacons and mail one address may send per minute. Default 600 each. */
  publishesPerMinute?: number
  mailPerMinute?: number
  /**
   * A shared secret for publishers the operator trusts, such as a bridge that
   * feeds in beacons it has already vetted from another network. A publish
   * that carries it skips proof of work and the per-address limit. Signature
   * and expiry are still checked.
   */
  trustedPass?: string
  /** Take the client address from X-Forwarded-For. Only behind a proxy you run. */
  trustProxy?: boolean
  /**
   * Keep beacons and undelivered mail in this file, so a restart loses
   * nothing. Without it the relay holds everything in memory.
   */
  dataFile?: string
  now?: () => number
}

export interface Relay {
  port: number
  url: string
  close(): Promise<void>
  /** Removes expired beacons and mail now. Runs on a timer as well. */
  sweep(): void
  stats(): { beacons: number; mail: number; connections: number }
}

interface StoredMail {
  id: string
  to: string
  sealed: Sealed
  at: number
}

interface Conn {
  ws: WebSocket
  address: string
  bucket: Bucket
  challenge: string
  did?: string
  mailSub: boolean
  subs: Map<string, Filter>
}

/** What a relay asks of those who publish to it. Sent with the opening challenge. */
export interface RelayPolicy {
  powBits: number
  maxTtlMs: number
}

/** A token bucket: `burst` at once, refilled at `perSecond`. */
class Bucket {
  private tokens: number
  private at: number
  constructor(
    private burst: number,
    private perSecond: number,
    now: number,
  ) {
    this.tokens = burst
    this.at = now
  }
  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.perSecond)
    this.at = now
    if (this.tokens < 1) return false
    this.tokens--
    return true
  }
}

export const RELAY_AUTH_CONTEXT = 'relay-auth'
const DAY = 24 * 60 * 60 * 1000

export async function startRelay(opts: RelayOptions = {}): Promise<Relay> {
  const now = opts.now ?? Date.now
  const maxTtlMs = opts.maxTtlMs ?? 180 * DAY
  const maxPerWho = opts.maxPerWho ?? 200
  const mailTtlMs = opts.mailTtlMs ?? DAY
  const maxMail = opts.maxMailPerRecipient ?? 200
  const maxSubs = opts.maxSubsPerConnection ?? 32

  const minPowBits = opts.minPowBits ?? 0
  const policy: RelayPolicy = { powBits: minPowBits, maxTtlMs }
  const maxPerAddress = opts.maxConnectionsPerAddress ?? 200
  const perAddress = new Map<string, { conns: number; publish: Bucket; mail: Bucket }>()
  const addressState = (address: string) => {
    let s = perAddress.get(address)
    if (!s) {
      const perMin = (n: number) => new Bucket(n, n / 60, Date.now())
      s = { conns: 0, publish: perMin(opts.publishesPerMinute ?? 600), mail: perMin(opts.mailPerMinute ?? 600) }
      perAddress.set(address, s)
    }
    return s
  }

  const beacons = new Map<string, Beacon>()
  const mail = new Map<string, StoredMail[]>()
  const conns = new Set<Conn>()

  if (opts.dataFile && existsSync(opts.dataFile)) {
    const saved = JSON.parse(readFileSync(opts.dataFile, 'utf8')) as { beacons?: Beacon[]; mail?: StoredMail[] }
    // Stored beacons are checked like any other: the file is not trusted either.
    for (const b of saved.beacons ?? []) if (checkBeacon(b, now()) === null) beacons.set(beaconId(b), b)
    for (const m of saved.mail ?? []) if (m.at + mailTtlMs > now()) mail.set(m.to, [...(mail.get(m.to) ?? []), m])
  }
  let dirty: NodeJS.Timeout | undefined
  function flush() {
    clearTimeout(dirty)
    dirty = undefined
    if (!opts.dataFile) return
    mkdirSync(dirname(opts.dataFile), { recursive: true })
    const tmp = `${opts.dataFile}.tmp`
    writeFileSync(tmp, JSON.stringify({ beacons: [...beacons.values()], mail: [...mail.values()].flat() }), { mode: 0o600 })
    renameSync(tmp, opts.dataFile)
  }
  const changed = () => {
    if (opts.dataFile && !dirty) dirty = setTimeout(flush, 50)
  }

  const wss = new WebSocketServer({ port: opts.port ?? 0, host: opts.host ?? '127.0.0.1', maxPayload: 64 * 1024 })
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve)
    wss.once('error', reject)
  })

  const send = (c: Conn, msg: object) => {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg))
  }

  function sweep() {
    const t = now()
    for (const [id, b] of beacons) if (isExpired(b, t)) beacons.delete(id)
    for (const [to, list] of mail) {
      const kept = list.filter((m) => m.at + mailTtlMs > t)
      if (kept.length) mail.set(to, kept)
      else mail.delete(to)
    }
    changed()
  }
  const timer = setInterval(sweep, opts.sweepMs ?? 5000)
  timer.unref()

  function publish(c: Conn, ref: unknown, beacon: Beacon, pass?: unknown) {
    const trusted = !!opts.trustedPass && typeof pass === 'string' && pass.length === opts.trustedPass.length && timingSafeEqual(Buffer.from(pass), Buffer.from(opts.trustedPass))
    const problem = checkBeacon(beacon, now())
    if (problem) return send(c, { t: 'error', ref, reason: problem })
    if (Date.parse(beacon.expires) - now() > maxTtlMs) return send(c, { t: 'error', ref, reason: 'expires too far ahead' })
    const id = beaconId(beacon)
    if (!beacons.has(id)) {
      if (!trusted && minPowBits && powBits(beacon) < minPowBits) return send(c, { t: 'error', ref, reason: `needs ${minPowBits} bits of proof of work` })
      if (!trusted && !addressState(c.address).publish.take(Date.now())) return send(c, { t: 'error', ref, reason: 'rate limited' })
      let held = 0
      for (const b of beacons.values()) if (b.who === beacon.who && !isExpired(b, now())) held++
      // The cap per key holds for trusted publishers too: it bounds what any one key can occupy.
      if (held >= maxPerWho) return send(c, { t: 'error', ref, reason: 'too many live beacons for this key' })
      beacons.set(id, beacon)
      changed()
      for (const other of conns)
        for (const [sub, filter] of other.subs)
          if (matchesFilter(beacon, filter)) send(other, { t: 'beacon', sub, beacon })
    }
    send(c, { t: 'ok', ref, id })
  }

  function subscribe(c: Conn, ref: unknown, sub: unknown, filter: unknown) {
    if (typeof sub !== 'string' || sub.length > 64 || !isFilter(filter))
      return send(c, { t: 'error', ref, reason: 'sub needs an id and a filter' })
    if (!c.subs.has(sub) && c.subs.size >= maxSubs) return send(c, { t: 'error', ref, reason: 'too many subscriptions' })
    c.subs.set(sub, filter)
    const t = now()
    for (const b of beacons.values()) if (!isExpired(b, t) && matchesFilter(b, filter)) send(c, { t: 'beacon', sub, beacon: b })
    send(c, { t: 'eose', sub })
  }

  function acceptMail(c: Conn, ref: unknown, to: unknown, sealed: unknown) {
    if (!isDid(to) || !isSealed(sealed)) return send(c, { t: 'error', ref, reason: 'mail needs a recipient and a sealed body' })
    if (!addressState(c.address).mail.take(Date.now())) return send(c, { t: 'error', ref, reason: 'rate limited' })
    const list = mail.get(to) ?? []
    if (list.length >= maxMail) return send(c, { t: 'error', ref, reason: 'mailbox full' })
    const m: StoredMail = { id: nonce(12), to, sealed, at: now() }
    list.push(m)
    mail.set(to, list)
    changed()
    for (const other of conns) if (other.did === to && other.mailSub) send(other, { t: 'mail', id: m.id, sealed: m.sealed })
    send(c, { t: 'ok', ref, id: m.id })
  }

  wss.on('connection', (ws, req) => {
    const forwarded = opts.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : ''
    const address = forwarded || req.socket.remoteAddress || 'unknown'
    const from = addressState(address)
    if (from.conns >= maxPerAddress) {
      ws.close(1013, 'too many connections')
      return
    }
    from.conns++
    const c: Conn = { ws, address, bucket: new Bucket(opts.messageBurst ?? 60, opts.messagesPerSecond ?? 20, Date.now()), challenge: nonce(), mailSub: false, subs: new Map() }
    conns.add(c)
    ws.on('close', () => {
      conns.delete(c)
      from.conns--
    })
    ws.on('error', () => ws.terminate())
    send(c, { t: 'challenge', nonce: c.challenge, policy })

    ws.on('message', (data) => {
      if (!c.bucket.take(Date.now())) return send(c, { t: 'error', reason: 'rate limited' })
      let m: Record<string, unknown>
      try {
        m = JSON.parse(data.toString())
        if (!m || typeof m !== 'object') throw new Error()
      } catch {
        return send(c, { t: 'error', reason: 'not JSON' })
      }
      const ref = m.ref
      switch (m.t) {
        case 'publish':
          return publish(c, ref, m.beacon as Beacon, m.pass)
        case 'sub':
          return subscribe(c, ref, m.sub, m.filter)
        case 'unsub':
          c.subs.delete(String(m.sub))
          return send(c, { t: 'ok', ref })
        case 'auth': {
          // Reading a mailbox requires proving control of its key.
          const did = m.did
          if (!isDid(did) || typeof m.sig !== 'string' || !verify(did, RELAY_AUTH_CONTEXT, { nonce: c.challenge, did }, m.sig))
            return send(c, { t: 'error', ref, reason: 'auth failed' })
          c.did = did
          return send(c, { t: 'ok', ref })
        }
        case 'mail':
          return acceptMail(c, ref, m.to, m.sealed)
        case 'mailsub': {
          if (!c.did) return send(c, { t: 'error', ref, reason: 'auth required' })
          c.mailSub = true
          send(c, { t: 'ok', ref })
          const t = now()
          for (const item of mail.get(c.did) ?? [])
            if (item.at + mailTtlMs > t) send(c, { t: 'mail', id: item.id, sealed: item.sealed })
          return
        }
        case 'ack': {
          if (!c.did) return send(c, { t: 'error', ref, reason: 'auth required' })
          const ids = Array.isArray(m.ids) ? m.ids : []
          const kept = (mail.get(c.did) ?? []).filter((x) => !ids.includes(x.id))
          if (kept.length) mail.set(c.did, kept)
          else mail.delete(c.did)
          changed()
          return send(c, { t: 'ok', ref })
        }
        default:
          return send(c, { t: 'error', ref, reason: 'unknown message type' })
      }
    })
  })

  const port = (wss.address() as { port: number }).port
  return {
    port,
    url: `ws://${opts.host ?? '127.0.0.1'}:${port}`,
    sweep,
    stats: () => ({
      beacons: beacons.size,
      mail: [...mail.values()].reduce((n, l) => n + l.length, 0),
      connections: conns.size,
    }),
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(timer)
        flush()
        for (const c of conns) c.ws.terminate()
        wss.close(() => resolve())
      }),
  }
}
