import { createServer } from 'node:http'
import { RelayClient } from '../relay/client.js'
import type { Embedder } from './embed.js'
import { Matcher } from './matcher.js'

export interface MatcherService {
  port: number
  url: string
  matcher: Matcher
  close(): Promise<void>
}

/**
 * A matcher as a service: it subscribes to a relay, indexes every beacon and
 * answers `GET /matches?beacon=<id>` and `GET /search?q=<text>`.
 */
export async function startMatcher(opts: { relayUrl: string; port?: number; host?: string; embedder?: Embedder }): Promise<MatcherService> {
  const matcher = new Matcher(opts.embedder)
  const relay = await RelayClient.connect(opts.relayUrl)
  let queue = Promise.resolve()
  const sub = relay.subscribe({}, (b) => {
    queue = queue.then(() => matcher.add(b)).catch(() => {})
  })
  await sub.eose
  await queue

  const server = createServer(async (req, res) => {
    const reply = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    try {
      const url = new URL(req.url ?? '/', 'http://x')
      const limit = Math.min(Number(url.searchParams.get('limit')) || 10, 50)
      await queue
      if (req.method === 'GET' && url.pathname === '/matches') {
        const [beacon] = await relay.query({ ids: [url.searchParams.get('beacon') ?? ''] })
        if (!beacon) return reply(404, { error: 'no live beacon with that id' })
        return reply(200, { matches: await matcher.match({ beacon, limit }) })
      }
      if (req.method === 'GET' && url.pathname === '/search') {
        const text = url.searchParams.get('q') ?? ''
        return reply(200, { matches: await matcher.match({ text, where: url.searchParams.get('where') ?? undefined, limit }) })
      }
      reply(404, { error: 'not found' })
    } catch (e) {
      reply(500, { error: (e as Error).message })
    }
  })
  const host = opts.host ?? '127.0.0.1'
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, host, resolve)
  })
  const port = (server.address() as { port: number }).port
  return {
    port,
    url: `http://${host}:${port}`,
    matcher,
    close: () =>
      new Promise<void>((resolve) => {
        sub.close()
        relay.close()
        server.close(() => resolve())
      }),
  }
}
