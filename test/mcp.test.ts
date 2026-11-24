import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createIdentity } from '../src/core/identity.js'
import { checkReceipt } from '../src/core/receipt.js'
import { type Relay, startRelay } from '../src/relay/server.js'
import { type Room, startRoom } from '../src/room/server.js'

let relay: Relay
let room: Room
const dirs: string[] = []
const clients: Client[] = []

const node = (script: string, args: string[], env: Record<string, string>) =>
  execFileSync(process.execPath, ['--import', 'tsx', script, ...args], { env: { ...process.env, ...env } as Record<string, string>, encoding: 'utf8' })

async function mcp(extra: Record<string, string> = {}): Promise<{ client: Client; home: string }> {
  const home = mkdtempSync(join(tmpdir(), 'varde-test-'))
  dirs.push(home)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/mcp/server.ts'],
      env: { ...process.env, VARDE_HOME: home, VARDE_RELAY: relay.url, VARDE_ROOMS: room.url, ...extra } as Record<string, string>,
    }),
  )
  clients.push(client)
  return { client, home }
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
  if (res.isError) throw new Error(res.content[0].text)
  return JSON.parse(res.content[0].text)
}

before(async () => {
  relay = await startRelay()
  room = await startRoom({ identity: createIdentity() })
})
after(async () => {
  for (const c of clients) await c.close()
  await room.close()
  await relay.close()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

test('with only the MCP tools: beacons, a quote, the owner\'s approval from the command line, then a receipt', async () => {
  // The owner's key lives in its own directory, which the agent's process is never told about.
  const ownerHome = mkdtempSync(join(tmpdir(), 'varde-owner-'))
  dirs.push(ownerHome)
  const ownerDid = node('src/bin/owner.ts', [], { VARDE_OWNER_HOME: ownerHome }).match(/did:key:\w+/)![0]

  const { client: seller } = await mcp()
  const { client: buyer, home: buyerHome } = await mcp({ VARDE_OWNER: ownerDid })
  const asOwner = (...args: string[]) => node('src/bin/owner.ts', args, { VARDE_OWNER_HOME: ownerHome, VARDE_HOME: buyerHome })
  assert.deepEqual(
    (await seller.listTools()).tools.map((t) => t.name).sort(),
    ['commit', 'contact', 'contacts', 'light', 'listen', 'message', 'messages', 'negotiate', 'quotes', 'withdraw'],
  )

  const offer = await call(seller, 'light', { what: 'Selling a used iPad Air, 64 GB', intent: 'offer', where: 'Stavanger', ttlHours: 720 })
  const want = await call(buyer, 'light', { what: 'Looking for a used iPad Air, under 4000 kr', intent: 'want', where: 'Stavanger area' })
  const heard = await call(buyer, 'listen', { beacon: want.id })
  assert.equal(heard.matches[0].id, offer.id)

  const contact = await call(buyer, 'contact', { beacon: offer.id, as: want.id })
  assert.equal(contact.room, room.url)
  const sellerSide = await call(seller, 'contacts', { waitSeconds: 5 })
  assert.equal(sellerSide.contacts[0].session, contact.session)

  // Negotiating gives each side a quote. Nothing is binding.
  const [bought, sold] = await Promise.all([
    call(buyer, 'negotiate', { session: contact.session, side: 'pay', currency: 'NOK', limit: 4000, target: 2800 }),
    call(seller, 'negotiate', { session: contact.session, side: 'receive', currency: 'NOK', limit: 3200, target: 4400 }),
  ])
  assert.deepEqual([bought.outcome, sold.outcome], ['quoted', 'quoted'])
  assert.equal(bought.quoteId, sold.quoteId)
  assert.ok(bought.price >= 3200 && bought.price <= 4000)
  assert.deepEqual([bought.needsOwnerApproval, sold.needsOwnerApproval], [true, false])
  assert.equal((await call(buyer, 'contacts')).receipts.length, 0)

  // The buyer's agent cannot commit by itself. The seller's can, and then waits.
  await assert.rejects(call(buyer, 'commit', { session: contact.session }), /owner's approval/)
  const waiting = await call(seller, 'commit', { session: contact.session })
  assert.deepEqual([waiting.state, waiting.youApproved, waiting.counterpartApproved], ['quoted', true, false])

  // The owner looks at the quote and approves it, with a key only the owner holds.
  assert.match(asOwner('quotes'), new RegExp(`pay ${bought.price} NOK[\\s\\S]*needs your approval`))
  assert.match(asOwner('approve', contact.session), /approved: pay/)

  const done = await call(buyer, 'commit', { session: contact.session })
  assert.equal(done.state, 'agreed')
  assert.equal(checkReceipt(done.receipt), null)
  assert.deepEqual(done.receipt.approvals.map((a: { by: string }) => a.by).sort(), [ownerDid, offer.you].sort())

  // The seller learns of the deal the next time it looks.
  const sellerQuotes = await call(seller, 'quotes')
  assert.equal(sellerQuotes.quotes[0].state, 'agreed')
  assert.equal((await call(seller, 'contacts')).receipts.length, 1)

  await assert.rejects(call(buyer, 'contact', { beacon: 'nope' }), /no live beacon/)
})
