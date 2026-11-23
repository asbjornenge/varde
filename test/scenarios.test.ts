import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Agent, type AgentState } from '../src/agent.js'
import { beaconId, lightBeacon } from '../src/core/beacon.js'
import { createIdentity } from '../src/core/identity.js'
import { openMail, sealMail } from '../src/core/mail.js'
import { checkReceipt } from '../src/core/receipt.js'
import { type Negotiator, concede } from '../src/negotiator.js'
import { RelayClient } from '../src/relay/client.js'
import { startRelay } from '../src/relay/server.js'
import { startRoom } from '../src/room/server.js'

const HOUR = 60 * 60_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const memoryStore = () => {
  let state: AgentState | undefined
  return { load: () => state, save: (s: AgentState) => void (state = JSON.parse(JSON.stringify(s))) }
}

test('a table for tonight: place, time window and conditions beyond price', async () => {
  const relay = await startRelay()
  const room = await startRoom({ identity: createIdentity() })
  const start = (rooms = [room.url]) => Agent.start({ identity: createIdentity(), relayUrl: relay.url, rooms })
  const [diner, luigi, sakura, napoli, bergen] = await Promise.all([start(), start(), start(), start(), start()])

  const stavanger = { lat: 58.97, lon: 5.73 }
  const evening = { from: '2026-11-23T16:00:00Z', until: '2026-11-23T22:00:00Z' }
  const month = 30 * 24 * HOUR
  const a = await luigi.light({ what: 'Italian restaurant, takes bookings', intent: 'offer', tags: ['italian', 'restaurant'], scope: { geo: stavanger, ...evening }, ttlMs: month })
  await sakura.light({ what: 'Sushi bar, takes bookings', intent: 'offer', tags: ['sushi', 'restaurant'], scope: { geo: stavanger, ...evening }, ttlMs: month })
  // Italian and nearby, but only open for lunch.
  await napoli.light({ what: 'Italian restaurant, takes bookings', intent: 'offer', tags: ['italian'], scope: { geo: stavanger, from: '2026-11-23T10:00:00Z', until: '2026-11-23T14:00:00Z' }, ttlMs: month })
  await bergen.light({ what: 'Italian restaurant, takes bookings', intent: 'offer', tags: ['italian'], scope: { geo: { lat: 60.39, lon: 5.32 }, ...evening }, ttlMs: month })

  // A momentary want that burns out at the time of the meal.
  const want = await diner.light({
    what: 'Table for two, Italian restaurant, tonight 19:00', intent: 'want', tags: ['italian'],
    scope: { geo: { ...stavanger, radiusKm: 5 }, from: '2026-11-23T17:30:00Z', until: '2026-11-23T19:00:00Z' },
    expires: new Date(Date.now() + 2 * HOUR).toISOString(),
  })
  const matches = await diner.listen({ beacon: want.id, minScore: 0.25 })
  assert.deepEqual(matches.map((m) => m.id), [a.id])

  const [mine, theirs] = await Promise.all([diner.contact(matches[0].beacon, { as: want.id }), luigi.waitForContact()])

  // The restaurant first pushes a late seating, then offers an early one at a discount.
  const restaurant: Negotiator = (v) =>
    v.history.length === 0
      ? { kind: 'offer', price: 300, terms: { time: '21:30', partySize: 2 } }
      : { kind: 'counter', price: 150, terms: { time: '18:30', partySize: 2 } }
  // The diner's negotiator accepts whatever is on the table. Only the room holds it to the mandate.
  const eager: Negotiator = (v) => (v.lastRefusal ? { kind: 'counter', price: 100, terms: { time: '19:00', partySize: 2 } } : { kind: 'accept' })

  const [dined, served] = await Promise.all([
    diner.negotiate(mine.session, { commit: true, side: 'pay', currency: 'NOK', limit: 250, target: 100, require: { time: ['18:30', '19:00'], partySize: [2] }, negotiator: eager }),
    luigi.negotiate(theirs.session, { commit: true, side: 'receive', currency: 'NOK', limit: 100, target: 300, require: { partySize: [1, 2, 3, 4] }, negotiator: restaurant }),
  ])
  assert.equal(dined.outcome, 'agreed')
  assert.deepEqual(dined.refusals, ['outside your mandate']) // the 21:30 seating
  if (dined.outcome !== 'agreed' || served.outcome !== 'agreed') return
  assert.deepEqual(dined.receipt.quote.terms, { price: 150, currency: 'NOK', conditions: { time: '18:30', partySize: 2 } })
  assert.equal(checkReceipt(served.receipt), null)

  for (const x of [diner, luigi, sakura, napoli, bergen]) x.close()
  await room.close()
  await relay.close()
})

test('many sessions at once in one room stay separate, including one seller in three of them', async () => {
  const relay = await startRelay()
  const room = await startRoom({ identity: createIdentity() })
  const start = () => Agent.start({ identity: createIdentity(), relayUrl: relay.url, rooms: [room.url] })
  const seller = await start()
  const { beacon } = await seller.light({ what: 'Concert tickets, three left', intent: 'offer' })
  const buyers = await Promise.all([start(), start(), start()])
  // Each buyer has a different ceiling; the seller's floor is 500.
  const ceilings = [900, 700, 400]

  const contacts = await Promise.all(buyers.map((b) => b.contact(beacon)))
  assert.equal(new Set(contacts.map((c) => c.session)).size, 3)
  const outcomes = await Promise.all(
    buyers.flatMap((b, i) => [
      b.negotiate(contacts[i].session, { commit: true, side: 'pay', currency: 'NOK', limit: ceilings[i], target: 300 }),
      seller.negotiate(contacts[i].session, { commit: true, side: 'receive', currency: 'NOK', limit: 500, target: 1000 }),
    ]),
  )
  for (let i = 0; i < 3; i++) {
    const [b, s] = [outcomes[2 * i], outcomes[2 * i + 1]]
    if (ceilings[i] < 500) {
      assert.equal(b.outcome, 'ended')
      assert.equal(s.outcome, 'ended')
      continue
    }
    assert.equal(b.outcome, 'agreed')
    if (b.outcome !== 'agreed' || s.outcome !== 'agreed') continue
    assert.deepEqual(b.receipt, s.receipt)
    assert.equal(checkReceipt(b.receipt), null)
    assert.equal(b.receipt.quote.session, contacts[i].session)
    assert.deepEqual(b.receipt.quote.parties.map((p) => p.did).sort(), [buyers[i].did, seller.did].sort())
    assert.ok(b.receipt.quote.terms.price >= 500 && b.receipt.quote.terms.price <= ceilings[i])
  }
  assert.equal(seller.receipts.length, 2)
  assert.equal(room.stats().sessions, 0)

  for (const x of [seller, ...buyers]) x.close()
  await room.close()
  await relay.close()
})

test('a relay that restarts mid-handshake loses nothing when it keeps a data file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'varde-relay-'))
  const dataFile = join(dir, 'relay.json')
  let relay = await startRelay({ dataFile })
  const port = relay.port

  const sellerId = createIdentity()
  const store = memoryStore()
  let seller = await Agent.start({ identity: sellerId, relayUrl: relay.url, store })
  const { id, beacon } = await seller.light({ what: 'Selling a road bike', intent: 'offer' })
  seller.close() // the seller goes offline

  const buyer = await Agent.start({ identity: createIdentity(), relayUrl: relay.url, handshakeTimeoutMs: 8000 })
  const pending = buyer.contact(beacon) // the hello is now waiting on the relay
  pending.catch(() => {})
  await sleep(100)
  assert.equal(relay.stats().mail, 1)

  await relay.close()
  relay = await startRelay({ dataFile, port })
  assert.deepEqual(relay.stats(), { beacons: 1, mail: 1, connections: 0 })

  // The seller returns and finds the hello; the buyer has reconnected by itself.
  seller = await Agent.start({ identity: sellerId, relayUrl: relay.url, store })
  const contact = await pending
  assert.equal(contact.peer, sellerId.did)
  assert.equal((await seller.waitForContact()).myBeacon, id)

  buyer.close()
  seller.close()
  await relay.close()
  rmSync(dir, { recursive: true, force: true })
})

test('a relay that comes back empty is refilled: agents reconnect and light their beacons again', async () => {
  let relay = await startRelay()
  const port = relay.port
  const seller = await Agent.start({ identity: createIdentity(), relayUrl: relay.url })
  const { id, beacon } = await seller.light({ what: 'Selling a canoe', intent: 'offer' })

  await relay.close()
  relay = await startRelay({ port })
  assert.equal(relay.stats().beacons, 0)

  // No call is made on the seller: it must notice and recover without being asked.
  for (let i = 0; i < 50 && relay.stats().beacons === 0; i++) await sleep(100)
  assert.equal(relay.stats().beacons, 1)

  // And it is reachable again: a new agent finds it and completes the handshake.
  const buyer = await Agent.start({ identity: createIdentity(), relayUrl: relay.url })
  assert.equal((await buyer.find(id))?.sig, beacon.sig)
  assert.equal((await buyer.contact(beacon)).peer, seller.did)

  buyer.close()
  seller.close()
  await relay.close()
})

test('agents on two different relays find each other and deal', async () => {
  const [north, south] = [await startRelay(), await startRelay()]
  const room = await startRoom({ identity: createIdentity() })
  const seller = await Agent.start({ identity: createIdentity(), relayUrl: north.url, rooms: [room.url] })
  const buyer = await Agent.start({ identity: createIdentity(), relayUrl: south.url, listenRelays: [north.url], rooms: [room.url] })

  const offer = await seller.light({ what: 'Selling a used iPad Air', intent: 'offer' })
  const want = await buyer.light({ what: 'Looking for a used iPad Air', intent: 'want' })
  assert.deepEqual([north.stats().beacons, south.stats().beacons], [1, 1])

  const matches = await buyer.listen({ beacon: want.id })
  assert.equal(matches[0]?.id, offer.id)
  const [mine, theirs] = await Promise.all([buyer.contact(matches[0].beacon, { as: want.id }), seller.waitForContact()])
  // The buyer's replies arrive on its own relay; nothing of the buyer's is stored on the seller's.
  assert.equal(theirs.peerBeacon && beaconId(theirs.peerBeacon), want.id)

  const [bought] = await Promise.all([
    buyer.negotiate(mine.session, { commit: true, side: 'pay', currency: 'NOK', limit: 4000, target: 2800 }),
    seller.negotiate(theirs.session, { commit: true, side: 'receive', currency: 'NOK', limit: 3200, target: 4400 }),
  ])
  assert.equal(bought.outcome, 'agreed')

  buyer.close()
  seller.close()
  await room.close()
  await north.close()
  await south.close()
})

test('clock skew: a few minutes are tolerated, more is not', async () => {
  const relay = await startRelay()
  const lighter = await Agent.start({ identity: createIdentity(), relayUrl: relay.url })
  const { beacon } = await lighter.light({ what: 'Selling a tent', intent: 'offer' })

  const stranger = createIdentity()
  const c = await RelayClient.connect(relay.url, stranger)
  let welcomes = 0
  await c.onMail((m) => void (openMail(stranger, m.sealed)?.type === 'varde.welcome' && welcomes++))
  const hello = (skewMs: number, n: string) =>
    sealMail(stranger, lighter.did, lighter.identity.encPub, 'varde.hello',
      { answering: beaconId(beacon), replyTo: { relay: relay.url, encKey: stranger.encPub }, nonce: n, supports: { protocols: [], rooms: [], trust: [] } },
      Date.now() + skewMs).sealed

  await c.sendMail(lighter.did, hello(5 * 60_000, 'ahead'))
  await c.sendMail(lighter.did, hello(-5 * 60_000, 'behind'))
  await sleep(200)
  assert.equal(welcomes, 2)
  await c.sendMail(lighter.did, hello(11 * 60_000, 'far ahead'))
  await c.sendMail(lighter.did, hello(-11 * 60_000, 'far behind'))
  await sleep(200)
  assert.equal(welcomes, 2)
  c.close()
  lighter.close()
  await relay.close()

  // A relay whose clock runs two hours fast treats a one-hour beacon as burnt out.
  const fast = await startRelay({ now: () => Date.now() + 2 * HOUR })
  const id = createIdentity()
  const b = lightBeacon(id, { what: 'Table tonight', expires: new Date(Date.now() + HOUR).toISOString(), reachMe: [{ kind: 'mailbox', relay: fast.url, encKey: id.encPub }] })
  const pub = await RelayClient.connect(fast.url)
  await assert.rejects(pub.publish(b), /expired/)
  pub.close()
  await fast.close()
})
