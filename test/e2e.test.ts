import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { Agent } from '../src/agent.js'
import { beaconId, lightBeacon } from '../src/core/beacon.js'
import { createIdentity } from '../src/core/identity.js'
import { sealMail } from '../src/core/mail.js'
import { checkReceipt } from '../src/core/receipt.js'
import { Matcher } from '../src/matcher/matcher.js'
import { startMatcher } from '../src/matcher/server.js'
import { RelayClient } from '../src/relay/client.js'
import { type Relay, startRelay } from '../src/relay/server.js'
import { type Room, startRoom } from '../src/room/server.js'

const DAY = 24 * 60 * 60_000
let relay: Relay
let room: Room
const agents: Agent[] = []
const agent = async (rooms = [room.url]) => {
  const a = await Agent.start({ identity: createIdentity(), relayUrl: relay.url, rooms, handshakeTimeoutMs: 600 })
  agents.push(a)
  return a
}

before(async () => {
  relay = await startRelay()
  room = await startRoom({ identity: createIdentity() })
})
after(async () => {
  for (const a of agents) a.close()
  await room.close()
  await relay.close()
})

test('the iPad case: two agents that never met find each other and agree within both limits', async () => {
  const buyer = await agent()
  const seller = await agent()
  await (await agent()).light({ what: 'Italian restaurant, takes bookings', intent: 'offer', scope: { where: 'Stavanger' } })
  await (await agent()).light({ what: 'Selling a used iPad Air', intent: 'offer', scope: { where: 'Tromsø' } })
  await (await agent()).light({ what: 'Also looking for a used iPad Air', intent: 'want', scope: { where: 'Stavanger' } })
  const offer = await seller.light({ what: 'Selling a used iPad Air, 64 GB', intent: 'offer', scope: { where: 'Stavanger' }, ttlMs: 30 * DAY })
  const want = await buyer.light({ what: 'Looking for a used iPad Air, under 4000 kr', intent: 'want', scope: { where: 'Stavanger area' } })

  // Only the complementary beacon in the same place comes back: not the
  // restaurant, not the iPad in Tromsø, not the other buyer.
  const matches = await buyer.listen({ beacon: want.id, minScore: 0.3 })
  assert.deepEqual(matches.map((m) => m.id), [offer.id])

  const [mine, theirs] = await Promise.all([
    buyer.contact(matches[0].beacon, { as: want.id }),
    seller.waitForContact((c) => c.peer === buyer.did, 2000),
  ])
  assert.equal(mine.session, theirs.session)
  assert.equal(mine.room, room.url)
  assert.equal(theirs.role, 'lighter')
  assert.equal(theirs.myBeacon, offer.id)

  const [bought, sold] = await Promise.all([
    buyer.negotiate(mine.session, { commit: true, side: 'pay', currency: 'NOK', limit: 4000, target: 2800 }),
    seller.negotiate(theirs.session, { commit: true, side: 'receive', currency: 'NOK', limit: 3200, target: 4400 }),
  ])
  assert.equal(bought.outcome, 'agreed')
  assert.equal(sold.outcome, 'agreed')
  if (bought.outcome !== 'agreed') return
  const r = bought.receipt
  assert.equal(checkReceipt(r), null)
  assert.ok(r.quote.terms.price >= 3200 && r.quote.terms.price <= 4000)
  assert.deepEqual(r.quote.parties.map((p) => p.beacon).sort(), [offer.id, want.id].sort())
  assert.equal(buyer.receipts.length, 1)
})

test('handshake: an impostor who copies a beacon cannot complete it', async () => {
  const seller = await agent()
  const buyer = await agent()
  const { beacon } = await seller.light({ what: 'Selling a bike', intent: 'offer' })

  // Mallory republishes nothing (she cannot re-sign), but intercepts by
  // pointing a forged copy at her own mailbox. The forged copy fails its check.
  const mallory = createIdentity()
  const forged = { ...beacon, reachMe: [{ kind: 'mailbox' as const, relay: relay.url, encKey: mallory.encPub }] }
  await assert.rejects(buyer.contact(forged), /bad signature/)

  // Mallory lights her own beacon but answers a hello meant for it with the
  // wrong key: a welcome signed by anyone but the beacon's key is ignored.
  const hers = lightBeacon(mallory, {
    what: 'Selling a bike',
    expires: new Date(Date.now() + DAY).toISOString(),
    reachMe: [{ kind: 'mailbox', relay: relay.url, encKey: mallory.encPub }],
  })
  const helper = createIdentity()
  const inbox = await RelayClient.connect(relay.url, mallory)
  await inbox.onMail(() => {
    // Replies with a welcome from a different key, guessing at the fields.
    const fake = sealMail(helper, buyer.did, buyer.identity.encPub, 'varde.welcome', { hello: 'x', echo: 'x', nonce: 'x', supports: {} })
    void inbox.sendMail(buyer.did, fake.sealed)
  })
  await assert.rejects(buyer.contact(hers), /timed out/)
  inbox.close()
})

test('handshake: a responder cannot present a beacon it did not light', async () => {
  const seller = await agent()
  const victim = await agent()
  const { beacon: offer } = await seller.light({ what: 'Selling a kayak', intent: 'offer' })
  const { beacon: victims } = await victim.light({ what: 'Want a kayak', intent: 'want' })

  const mallory = createIdentity()
  const hello = sealMail(mallory, seller.did, seller.identity.encPub, 'varde.hello', {
    answering: beaconId(offer),
    beacon: victims,
    replyTo: { relay: relay.url, encKey: mallory.encPub },
    nonce: 'n',
    supports: { protocols: [], rooms: [], trust: [] },
  })
  const c = await RelayClient.connect(relay.url, mallory)
  let replies = 0
  await c.onMail(() => replies++)
  await c.sendMail(seller.did, hello.sealed)
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(replies, 0)
  assert.equal(seller.contacts.size, 0)
  c.close()
})

test('agents with no room in common still complete the handshake and can deal directly', async () => {
  const a = await agent(['ws://room-a.example'])
  const b = await agent(['ws://room-b.example'])
  const { beacon } = await a.light({ what: 'Rust meetup, Thursday', intent: 'offer' })
  const contact = await b.contact(beacon)
  assert.equal(contact.room, null)
  await assert.rejects(b.negotiate(contact.session, { commit: true, side: 'pay', currency: 'NOK', limit: 1, target: 1 }), /no room in common/)
})

test('a beacon lit while its owner is offline is answered when the owner returns', async () => {
  const identity = createIdentity()
  const first = await Agent.start({ identity, relayUrl: relay.url, rooms: [room.url] })
  const { beacon } = await first.light({ what: 'Selling a tent', intent: 'offer' })
  const saved = [...first.beacons.values()]
  first.close()

  const buyer = await agent()
  const pending = buyer.contact(beacon)
  pending.catch(() => {})
  await new Promise((r) => setTimeout(r, 100))
  const back = await Agent.start({ identity, relayUrl: relay.url, rooms: [room.url], store: { load: () => ({ beacons: saved, contacts: [], receipts: [] }), save: () => {} } })
  agents.push(back)
  assert.equal((await pending).peer, identity.did)
})

test('matcher: place and time windows filter, similarity ranks', async () => {
  const m = new Matcher()
  const id = createIdentity()
  const mk = (what: string, intent: 'want' | 'offer', scope: object) =>
    lightBeacon(createIdentity(), {
      what: { text: what, intent },
      scope,
      expires: new Date(Date.now() + DAY).toISOString(),
      reachMe: [{ kind: 'mailbox', relay: 'ws://r', encKey: id.encPub }],
    })
  const oslo = { lat: 59.91, lon: 10.75 }
  const tonight = mk('Italian restaurant table', 'offer', { geo: oslo, from: '2026-11-22T17:00:00Z', until: '2026-11-22T22:00:00Z' })
  const tomorrow = mk('Italian restaurant table', 'offer', { geo: oslo, from: '2026-11-23T17:00:00Z', until: '2026-11-23T22:00:00Z' })
  const bergen = mk('Italian restaurant table', 'offer', { geo: { lat: 60.39, lon: 5.32 }, from: '2026-11-22T17:00:00Z', until: '2026-11-22T22:00:00Z' })
  const sushi = mk('Sushi bar, takes bookings', 'offer', { geo: oslo })
  await m.add([tonight, tomorrow, bergen, sushi])
  const want = mk('Table for two, Italian, tonight', 'want', { geo: { ...oslo, radiusKm: 5 }, from: '2026-11-22T18:00:00Z', until: '2026-11-22T19:00:00Z' })
  const found = await m.match({ beacon: want, minScore: 0.2 })
  assert.deepEqual(found.map((f) => f.beacon), [tonight])
})

test('matcher service answers over HTTP from what it read on the relay', async () => {
  const svc = await startMatcher({ relayUrl: relay.url })
  const a = await agent()
  const b = await agent()
  const offer = await a.light({ what: 'Piano lessons for beginners', intent: 'offer' })
  const want = await b.light({ what: 'Want piano lessons', intent: 'want' })
  await new Promise((r) => setTimeout(r, 100))
  const res = (await (await fetch(`${svc.url}/matches?beacon=${want.id}`)).json()) as { matches: { id: string }[] }
  assert.equal(res.matches[0]?.id, offer.id)
  await svc.close()
})
