import { type Beacon, type Intent, beaconId, isExpired, whatIntent, whatTags, whatText } from '../core/beacon.js'
import { type Embedder, cosine, hashEmbedder, tokens } from './embed.js'

export interface Match {
  id: string
  beacon: Beacon
  score: number
}

export interface MatchQuery {
  /** Find complements of this beacon (usually one of your own). */
  beacon?: Beacon
  /** Or search by free text. */
  text?: string
  intent?: Intent
  where?: string
  limit?: number
  /** Lowest similarity to return. The right value depends on the embedder. */
  minScore?: number
}

const DEFAULT_RADIUS_KM = 25

function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLon = rad(b.lon - a.lon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}

/** Places are compatible unless both sides state one and they do not meet. */
export function placesMeet(a: Beacon['scope'], b: Beacon['scope']): boolean {
  if (a?.geo && b?.geo)
    return haversineKm(a.geo, b.geo) <= (a.geo.radiusKm ?? DEFAULT_RADIUS_KM) + (b.geo.radiusKm ?? DEFAULT_RADIUS_KM)
  if (a?.where && b?.where) {
    const ta = new Set(tokens(a.where))
    return tokens(b.where).some((t) => ta.has(t))
  }
  return true
}

/** Time windows are compatible unless both sides state one and they do not overlap. */
export function timesMeet(a: Beacon['scope'], b: Beacon['scope']): boolean {
  const start = (s: Beacon['scope']) => (s?.from ? Date.parse(s.from) : -Infinity)
  const end = (s: Beacon['scope']) => (s?.until ? Date.parse(s.until) : Infinity)
  return start(a) <= end(b) && start(b) <= end(a)
}

const opposite = (i: Intent): Intent => (i === 'want' ? 'offer' : 'want')

const describe = (b: Beacon): string => [whatText(b), ...whatTags(b), b.scope?.topic ?? ''].join(' ')

/**
 * Pairs complementary beacons by meaning, place and time. A matcher is a
 * convenience and never a gatekeeper: it only ranks beacons anyone could
 * have read from a relay themselves.
 */
export class Matcher {
  private index = new Map<string, { beacon: Beacon; vector: number[] }>()

  constructor(
    readonly embedder: Embedder = hashEmbedder(),
    private now: () => number = Date.now,
  ) {}

  get size() {
    return this.index.size
  }

  async add(beacons: Beacon | Beacon[]): Promise<void> {
    const fresh = (Array.isArray(beacons) ? beacons : [beacons]).filter((b) => !this.index.has(beaconId(b)))
    if (!fresh.length) return
    const vectors = await this.embedder.embed(fresh.map(describe))
    fresh.forEach((beacon, i) => this.index.set(beaconId(beacon), { beacon, vector: vectors[i] }))
  }

  remove(id: string) {
    this.index.delete(id)
  }

  private sweep() {
    const t = this.now()
    for (const [id, e] of this.index) if (isExpired(e.beacon, t)) this.index.delete(id)
  }

  async match(q: MatchQuery): Promise<Match[]> {
    this.sweep()
    const text = q.beacon ? describe(q.beacon) : (q.text ?? '')
    if (!text.trim()) return []
    const [vector] = await this.embedder.embed([text])
    const mine = q.beacon ? beaconId(q.beacon) : undefined
    // A want is answered by offers, and an offer by wants.
    const wanted = q.intent ?? (q.beacon && whatIntent(q.beacon) ? opposite(whatIntent(q.beacon)!) : undefined)
    const scope = q.beacon?.scope ?? (q.where ? { where: q.where } : undefined)
    const out: Match[] = []
    for (const [id, e] of this.index) {
      if (id === mine || (q.beacon && e.beacon.who === q.beacon.who)) continue
      const intent = whatIntent(e.beacon)
      if (wanted && intent && intent !== wanted) continue
      if (!placesMeet(scope, e.beacon.scope) || !timesMeet(q.beacon?.scope, e.beacon.scope)) continue
      const score = cosine(vector, e.vector)
      if (score >= (q.minScore ?? 0.1)) out.push({ id, beacon: e.beacon, score: Math.round(score * 1000) / 1000 })
    }
    return out.sort((a, b) => b.score - a.score).slice(0, q.limit ?? 10)
  }
}
