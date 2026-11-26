import WebSocket from 'ws'
import { type Beacon, type Retraction, checkBeacon } from '../core/beacon.js'
import { nonce } from '../core/bytes.js'
import type { Filter } from '../core/filter.js'
import { type Identity, sign } from '../core/identity.js'
import type { Sealed } from '../core/seal.js'
import { RELAY_AUTH_CONTEXT, type RelayPolicy } from './server.js'

export interface Subscription {
  /** Resolves once the relay has sent every stored beacon that matches. */
  eose: Promise<void>
  close(): void
}

type Pending = { resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

/** A connection to one relay. Beacons are verified here, so the relay need not be trusted. */
export class RelayClient {
  private pending = new Map<string, Pending>()
  private subs = new Map<string, { onBeacon: (b: Beacon) => void; eose: () => void }>()
  private mailHandler?: (m: { id: string; sealed: Sealed }) => void
  private closed = false
  /** What this relay asks of publishers, as it stated when we connected. */
  policy: RelayPolicy = { powBits: 0, maxTtlMs: Infinity }
  private closeHandler?: () => void

  private constructor(
    readonly url: string,
    private ws: WebSocket,
    private timeoutMs: number,
  ) {}

  /** Connects, and logs in with `identity` if given (needed only to read mail). */
  static connect(url: string, identity?: Identity, timeoutMs = 10_000): Promise<RelayClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { maxPayload: 64 * 1024 })
      const client = new RelayClient(url, ws, timeoutMs)
      let ready = false
      const fail = (e: Error) => {
        if (!ready) reject(e)
        client.shutdown(e)
      }
      const timer = setTimeout(() => fail(new Error(`relay ${url} did not answer`)), timeoutMs)
      ws.on('error', (e) => fail(e as Error))
      ws.on('close', () => fail(new Error(`relay ${url} closed the connection`)))
      ws.on('message', (data) => {
        let m: Record<string, unknown>
        try {
          m = JSON.parse(data.toString())
        } catch {
          return
        }
        if (m.t === 'challenge' && !ready) {
          const p = m.policy as Partial<RelayPolicy> | undefined
          if (p && typeof p.powBits === 'number') client.policy = { powBits: p.powBits, maxTtlMs: typeof p.maxTtlMs === 'number' ? p.maxTtlMs : Infinity }
          const done = () => {
            ready = true
            clearTimeout(timer)
            resolve(client)
          }
          if (!identity) return done()
          const sig = sign(identity, RELAY_AUTH_CONTEXT, { nonce: m.nonce, did: identity.did })
          client.request({ t: 'auth', did: identity.did, sig }).then(done, fail)
          return
        }
        client.onMessage(m)
      })
    })
  }

  private onMessage(m: Record<string, unknown>) {
    if (m.t === 'ok' || m.t === 'error') {
      const p = typeof m.ref === 'string' ? this.pending.get(m.ref) : undefined
      if (!p) return
      this.pending.delete(m.ref as string)
      clearTimeout(p.timer)
      if (m.t === 'ok') p.resolve(m)
      else p.reject(new Error(`relay refused: ${String(m.reason)}`))
    } else if (m.t === 'beacon') {
      const sub = this.subs.get(String(m.sub))
      const beacon = m.beacon as Beacon
      // Never take the relay's word for it.
      if (sub && checkBeacon(beacon) === null) sub.onBeacon(beacon)
    } else if (m.t === 'eose') {
      this.subs.get(String(m.sub))?.eose()
    } else if (m.t === 'mail') {
      this.mailHandler?.({ id: String(m.id), sealed: m.sealed as Sealed })
    }
  }

  private request(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('relay connection is closed'))
    const ref = nonce(8)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(ref)
        reject(new Error('relay request timed out'))
      }, this.timeoutMs)
      this.pending.set(ref, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ ...msg, ref }))
    })
  }

  /** Publishes a beacon and returns its id. `pass` is the relay's trusted-publisher secret, for bridges. */
  async publish(beacon: Beacon, pass?: string): Promise<string> {
    return String((await this.request({ t: 'publish', beacon, ...(pass ? { pass } : {}) })).id)
  }

  /** Puts out a beacon before its time. The retraction is signed by the key that lit it. */
  async retract(retraction: Retraction): Promise<void> {
    await this.request({ t: 'retract', retraction })
  }

  subscribe(filter: Filter, onBeacon: (b: Beacon) => void): Subscription {
    const sub = nonce(8)
    let eose!: () => void
    const done = new Promise<void>((r) => (eose = r))
    this.subs.set(sub, { onBeacon, eose })
    this.request({ t: 'sub', sub, filter }).catch(() => eose())
    return {
      eose: done,
      close: () => {
        this.subs.delete(sub)
        if (!this.closed) this.request({ t: 'unsub', sub }).catch(() => {})
      },
    }
  }

  /** One-shot: every live beacon on the relay that matches the filter. */
  async query(filter: Filter = {}): Promise<Beacon[]> {
    const found: Beacon[] = []
    const sub = this.subscribe(filter, (b) => found.push(b))
    await sub.eose
    sub.close()
    return found
  }

  async sendMail(to: string, sealed: Sealed): Promise<void> {
    await this.request({ t: 'mail', to, sealed })
  }

  /** Starts mail delivery, including anything queued while offline. Requires login. */
  async onMail(handler: (m: { id: string; sealed: Sealed }) => void): Promise<void> {
    this.mailHandler = handler
    await this.request({ t: 'mailsub' })
  }

  async ack(ids: string[]): Promise<void> {
    await this.request({ t: 'ack', ids })
  }

  /** Called once if the connection is lost. Not called after `close()`. */
  onClose(handler: () => void) {
    this.closeHandler = handler
  }

  get isClosed() {
    return this.closed
  }

  private shutdown(e: Error) {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(e)
    }
    this.pending.clear()
    for (const s of this.subs.values()) s.eose()
    this.ws.terminate()
    const lost = this.closeHandler
    this.closeHandler = undefined
    lost?.()
  }

  close() {
    this.closeHandler = undefined
    this.shutdown(new Error('relay connection is closed'))
  }
}
