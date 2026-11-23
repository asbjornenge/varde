import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { cosine, hashEmbedder, httpEmbedder } from '../src/matcher/embed.js'

test('the built-in embedder ranks shared words above unrelated text', async () => {
  const [want, ipad, pizza] = await hashEmbedder().embed(['Looking for a used iPad Air', 'Selling iPad Air 64 GB', 'Italian restaurant, takes bookings'])
  assert.ok(cosine(want, ipad) > 0.4)
  assert.ok(cosine(want, pizza) < 0.1)
})

test('the HTTP embedder speaks the OpenAI embeddings shape', async () => {
  let seen: any
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      seen = { auth: req.headers.authorization, ...JSON.parse(body) }
      // Answer out of order: the client must sort by index.
      res.end(JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/embeddings`
  const vectors = await httpEmbedder({ url, model: 'm', apiKey: 'k' }).embed(['a', 'b'])
  assert.deepEqual(vectors, [[1, 0], [0, 1]])
  assert.deepEqual(seen, { auth: 'Bearer k', model: 'm', input: ['a', 'b'] })
  await assert.rejects(httpEmbedder({ url, model: 'm' }).embed(['only one']), /unexpected shape/)
  server.close()
})
