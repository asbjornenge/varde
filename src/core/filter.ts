import { type Beacon, type Intent, beaconId, whatIntent, whatTags, whatText } from './beacon.js'

/** What a listener asks a relay for. Every given field must match. */
export interface Filter {
  ids?: string[]
  who?: string[]
  /** Matches if the beacon carries any of these tags. */
  tags?: string[]
  intent?: Intent
  /** Case-insensitive substring of scope.where. */
  where?: string
  /** Case-insensitive substring of the what text. */
  text?: string
  /** Only beacons lit at or after this time. */
  since?: string
}

const lower = (s: string) => s.toLocaleLowerCase()

export function matchesFilter(b: Beacon, f: Filter): boolean {
  if (f.ids && !f.ids.includes(beaconId(b))) return false
  if (f.who && !f.who.includes(b.who)) return false
  if (f.intent && whatIntent(b) !== f.intent) return false
  if (f.tags && f.tags.length) {
    const tags = whatTags(b).map(lower)
    if (!f.tags.some((t) => tags.includes(lower(t)))) return false
  }
  if (f.where && !lower(b.scope?.where ?? '').includes(lower(f.where))) return false
  if (f.text && !lower(whatText(b)).includes(lower(f.text))) return false
  if (f.since && Date.parse(b.lit) < Date.parse(f.since)) return false
  return true
}

export function isFilter(f: unknown): f is Filter {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return false
  const x = f as Record<string, unknown>
  const strs = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((s) => typeof s === 'string'))
  const str = (v: unknown) => v === undefined || typeof v === 'string'
  return strs(x.ids) && strs(x.who) && strs(x.tags) && str(x.intent) && str(x.where) && str(x.text) && str(x.since)
}
