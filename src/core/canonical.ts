/**
 * Canonical JSON (RFC 8785 style): object keys sorted, no whitespace,
 * ECMAScript number and string serialisation. Everything Varde signs or
 * hashes is serialised with this function first, so two implementations
 * always sign the same bytes.
 */
export function canonicalize(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('cannot canonicalize a non-finite number')
    return JSON.stringify(v)
  }
  if (Array.isArray(v)) {
    return '[' + v.map((x) => canonicalize(x === undefined ? null : x)).join(',') + ']'
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(o[k])).join(',') + '}'
  }
  throw new Error(`cannot canonicalize a ${typeof v}`)
}
