import { createHash } from 'node:crypto'

/** Turns text into vectors. Matching quality is whatever the embedder gives. */
export interface Embedder {
  name: string
  embed(texts: string[]): Promise<number[][]>
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

const STOP = new Set(
  'a an the and or for of to in on at by with from is are be am i we you it this that my our your looking look want wants wanted need needs seeking seek sell selling sale buy buying offer offering offers have has under over about around near area'.split(
    ' ',
  ),
)

export const tokens = (text: string): string[] =>
  text
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOP.has(t))

/**
 * The built-in embedder. It hashes words and character trigrams into a fixed
 * vector, so it needs no model and no network. It is lexical, not semantic:
 * "iPad" finds "iPad Air", but "tablet" does not find "iPad". Use `httpEmbedder`
 * with a real embedding model when meaning matters.
 */
export function hashEmbedder(dims = 512): Embedder {
  const slot = (feature: string): [number, number] => {
    const h = createHash('sha1').update(feature).digest()
    return [h.readUInt32BE(0) % dims, h[4] & 1 ? 1 : -1]
  }
  return {
    name: `hash-${dims}`,
    async embed(texts) {
      return texts.map((text) => {
        const v = new Array<number>(dims).fill(0)
        for (const word of tokens(text)) {
          const [i, s] = slot('w:' + word)
          v[i] += s * 2
          const padded = `^${word}$`
          for (let k = 0; k + 3 <= padded.length; k++) {
            const [j, sj] = slot('g:' + padded.slice(k, k + 3))
            v[j] += sj * 0.5
          }
        }
        const norm = Math.sqrt(v.reduce((n, x) => n + x * x, 0)) || 1
        return v.map((x) => x / norm)
      })
    },
  }
}

/**
 * Uses any service that speaks the OpenAI embeddings API (`POST {url}` with
 * `{model, input}`), for example a local Ollama or llama.cpp server.
 */
export function httpEmbedder(opts: { url: string; model: string; apiKey?: string }): Embedder {
  return {
    name: `http:${opts.model}`,
    async embed(texts) {
      const res = await fetch(opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
        body: JSON.stringify({ model: opts.model, input: texts }),
      })
      if (!res.ok) throw new Error(`embedding service answered ${res.status}`)
      const json = (await res.json()) as { data?: { index?: number; embedding: number[] }[] }
      if (!json.data || json.data.length !== texts.length) throw new Error('embedding service returned an unexpected shape')
      return [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding)
    },
  }
}

/** Picks the embedder from VARDE_EMBED_URL / VARDE_EMBED_MODEL / VARDE_EMBED_KEY, else the built-in one. */
export function embedderFromEnv(env: NodeJS.ProcessEnv = process.env): Embedder {
  if (env.VARDE_EMBED_URL && env.VARDE_EMBED_MODEL)
    return httpEmbedder({ url: env.VARDE_EMBED_URL, model: env.VARDE_EMBED_MODEL, apiKey: env.VARDE_EMBED_KEY })
  return hashEmbedder()
}
