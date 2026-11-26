import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Agent, type AgentOptions } from '../src/agent.js'
import { beaconId, lightBeacon, retractBeacon } from '../src/core/beacon.js'
import { createIdentity } from '../src/core/identity.js'
import { checkReceipt } from '../src/core/receipt.js'
import { RelayClient } from '../src/relay/client.js'
import { type Relay, startRelay } from '../src/relay/server.js'
import { visitRoom } from '../src/room/client.js'
import { type Room, startRoom } from '../src/room/server.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let relay: Relay
let room: Room
const agents: Agent[] = []
const agent = async (o: Partial<AgentOptions> = {}) => {
  const a = await Agent.start({ identity: createIdentity(), relayUrl: relay.url, rooms: [room.url], ...o })
  agents.push(a)
  return a
}
/** A seller with a beacon and a buyer who has answered it. Nobody has entered the room. */
async function contactBetween(o: { roomUrl?: string } = {}) {
  const rooms = [o.roomUrl ?? room.url]
  const [seller, buyer] = [await agent({ rooms }), await agent({ rooms })]
  const { beacon } = await seller.light({ what: `Selling a bike ${Math.random()}`, intent: 'offer' })
  const [c] = await Promise.all([buyer.contact(beacon), seller.waitForContact()])
  return { seller, buyer, session: c.session }
}
const pay = (limit: number) => ({ mandate: { side: 'pay' as const, currency: 'NOK', limit } })
const receive = (limit: number) => ({ mandate: { side: 'receive' as const, currency: 'NOK', limit } })

before(async () => {
  relay = await startRelay()
  room = await startRoom({ identity: createIdentity(), maxTurns: 8 })
})
after(async () => {
  for (const a of agents) a.close()
  await room.close()
  await relay.close()
})

test('two agents that are never in the room together negotiate, one visit at a time', async () => {
  const { seller, buyer, session } = await contactBetween()

  // The buyer looks in first. Nobody is there; nothing can be offered yet.
  let b = await buyer.visit(session, pay(4000))
  assert.deepEqual([b.status, b.yourTurn, b.history.length], ['waiting', false, 0])
  assert.equal((await buyer.visit(session, { move: { kind: 'offer', price: 3000 } })).refused, 'the other side has not joined yet')

  // Later the seller looks in, and since nobody has made an offer, makes one and leaves.
  let s = await seller.visit(session, receive(3200))
  assert.deepEqual([s.status, s.yourTurn], ['open', true])
  s = await seller.visit(session, { move: { kind: 'offer', price: 3900, note: 'Barely used.' } })
  assert.deepEqual([s.yourTurn, s.myOffer, s.remaining], [false, 3900, 7])

  // The buyer comes back, sees the offer and the note, and counters.
  b = await buyer.visit(session)
  assert.deepEqual([b.status, b.yourTurn, b.theirOffer], ['open', true, 3900])
  assert.deepEqual(b.history.at(-1), { by: 'them', kind: 'offer', price: 3900, untrustedNote: 'Barely used.' })
  b = await buyer.visit(session, { move: { kind: 'counter', price: 3400 } })
  assert.deepEqual([b.yourTurn, b.myOffer], [false, 3400])
  // Moving out of turn is refused, and costs a turn like any other attempt.
  b = await buyer.visit(session, { move: { kind: 'counter', price: 3450 } })
  assert.deepEqual([b.refused, b.remaining], ['not your turn', 5])

  // The seller accepts. The quote needs both signatures, and the buyer is not here to give one.
  s = await seller.visit(session, { move: { kind: 'accept' } })
  assert.deepEqual([s.status, s.quote], ['signing', undefined])
  assert.equal(seller.quotes.size, 0)

  // The buyer looks in, and signs because the quote says what was agreed. Both now hold it.
  b = await buyer.visit(session)
  assert.equal(b.status, 'quoted')
  assert.equal(b.quote!.terms.price, 3400)
  s = await seller.visit(session)
  assert.equal(s.status, 'quoted')
  assert.deepEqual(s.quote, b.quote)
  assert.deepEqual([buyer.quotes.get(session)!.state, seller.receipts.length], ['quoted', 0])

  // From here it is the same as ever: a quote commits nobody until both sides approve.
  await seller.commit(session)
  const done = await buyer.commit(session)
  assert.equal(checkReceipt(done.receipt!), null)
})

test('a party that accepted and left can commit without looking in first', async () => {
  const { seller, buyer, session } = await contactBetween()
  await buyer.visit(session, pay(4000))
  await seller.visit(session, receive(3200))
  await seller.visit(session, { move: { kind: 'offer', price: 3600 } })
  // The buyer accepts and signs in the same visit, then leaves. The quote does not exist yet.
  assert.equal((await buyer.visit(session, { move: { kind: 'accept' } })).status, 'signing')
  await assert.rejects(buyer.commit(session), /no quote/)
  // The seller looks in and signs, which issues the quote, and commits.
  await seller.visit(session)
  await seller.commit(session)
  // The buyer never looked in again. Committing finds the quote by itself.
  assert.equal(buyer.quotes.size, 0)
  const done = await buyer.commit(session)
  assert.equal(done.state, 'agreed')
  assert.equal(checkReceipt(done.receipt!), null)
})

test('the limit given on the first visit holds on every later one, and cannot be changed', async () => {
  const { seller, buyer, session } = await contactBetween()
  await buyer.visit(session, pay(500))
  await seller.visit(session, receive(400))
  await seller.visit(session, { move: { kind: 'offer', price: 900 } })

  // The buyer's agent, however it was persuaded, cannot go past 500.
  for (const move of [{ kind: 'accept' as const }, { kind: 'counter' as const, price: 900 }, { kind: 'counter' as const, price: 501 }])
    assert.equal((await buyer.visit(session, { move })).refused, 'outside your mandate')
  // Nor by coming back with a higher limit: the room remembers what was authorised.
  const contact = buyer.contacts.get(session)!
  const looser = { roomUrl: room.url, identity: buyer.identity, session, peer: contact.peer, mandate: { side: 'pay' as const, currency: 'NOK', limit: 900 } }
  await assert.rejects(visitRoom(looser), /your mandate for this session is already set/)
  await assert.rejects(visitRoom({ ...looser, move: { kind: 'accept' } }), /already set/)
  // The agent itself keeps presenting the first one, whatever it is told later.
  assert.equal((await buyer.visit(session, pay(900))).status, 'open')
  assert.equal(buyer.negotiations.get(session)!.limit, 500)

  // Three refusals and two offers have used five of eight turns. The rest run out without a deal.
  assert.equal((await buyer.visit(session, { move: { kind: 'counter', price: 450 } })).remaining, 3)
  await seller.visit(session, { move: { kind: 'counter', price: 800 } })
  await buyer.visit(session, { move: { kind: 'counter', price: 460 } })
  const last = await seller.visit(session, { move: { kind: 'counter', price: 700 } })
  assert.deepEqual([last.status, last.reason], ['ended', 'turn-limit'])
  // A party that looks in afterwards is told how it ended.
  assert.deepEqual([(await buyer.visit(session)).status, (await buyer.visit(session)).reason], ['ended', 'turn-limit'])
})

test('a negotiation survives the room restarting between visits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'varde-room-'))
  const dataFile = join(dir, 'room.json')
  const identity = createIdentity()
  let durable = await startRoom({ identity, dataFile })
  const port = durable.port
  const { seller, buyer, session } = await contactBetween({ roomUrl: durable.url })
  await buyer.visit(session, pay(4000))
  await seller.visit(session, receive(3200))
  await seller.visit(session, { move: { kind: 'offer', price: 3800 } })

  await durable.close()
  durable = await startRoom({ identity, dataFile, port })
  assert.equal(durable.stats().sessions, 1)

  // The offer, whose turn it is and both limits are all still there.
  let b = await buyer.visit(session)
  assert.deepEqual([b.status, b.yourTurn, b.theirOffer, b.history.length], ['open', true, 3800, 1])
  assert.equal((await buyer.visit(session, { move: { kind: 'counter', price: 4100 } })).refused, 'outside your mandate')
  b = await buyer.visit(session, { move: { kind: 'accept' } })
  assert.equal(b.status, 'signing')
  assert.equal((await seller.visit(session)).status, 'quoted')
  assert.equal((await buyer.visit(session)).quote!.terms.price, 3800)

  await durable.close()
  rmSync(dir, { recursive: true, force: true })
})

test('a negotiation nobody finishes ends when its time is up', async () => {
  const brief = await startRoom({ identity: createIdentity(), sessionTtlMs: 300 })
  const { seller, buyer, session } = await contactBetween({ roomUrl: brief.url })
  await buyer.visit(session, pay(4000))
  await seller.visit(session, receive(3200))
  await seller.visit(session, { move: { kind: 'offer', price: 3800 } })
  await sleep(1400)
  const b = await buyer.visit(session)
  assert.deepEqual([b.status, b.reason], ['ended', 'expired'])
  assert.equal((await buyer.visit(session, { move: { kind: 'accept' } })).status, 'ended')
  await brief.close()
})

test('news tells an agent that was away what happened, each thing once', async () => {
  const { seller, buyer, session } = await contactBetween()
  // The seller's agent wakes up. Someone has answered its beacon.
  let n = await seller.news()
  assert.deepEqual([n.contacts.map((c) => c.session), n.messages.length, n.negotiations.length, n.quotes.length], [[session], 0, 0, 0])
  assert.deepEqual(await seller.news(), { contacts: [], messages: [], negotiations: [], quotes: [] })

  // While it sleeps, the buyer asks a question and opens a negotiation.
  await buyer.say(session, 'What size is the frame?')
  await buyer.visit(session, pay(4000))
  await sleep(100)
  n = await seller.news()
  assert.deepEqual(n.messages.map((m) => m.text), ['What size is the frame?'])
  assert.equal(n.negotiations.length, 0) // it has not entered the room itself yet

  await seller.visit(session, receive(3200))
  await seller.visit(session, { move: { kind: 'offer', price: 3900 } })
  await seller.news() // nothing it does not already know
  await buyer.visit(session, { move: { kind: 'counter', price: 3500 } })
  n = await seller.news()
  assert.deepEqual(n.negotiations.map((v) => [v.session, v.yourTurn, v.theirOffer]), [[session, true, 3500]])
  assert.equal((await seller.news()).negotiations.length, 0)

  // The seller accepts; the buyer learns of the quote, and later that the seller has committed.
  await seller.visit(session, { move: { kind: 'accept' } })
  n = await buyer.news()
  assert.deepEqual(n.quotes.map((q) => [q.state, q.approved.length]), [['quoted', 0]])
  await seller.news()
  await seller.commit(session)
  n = await buyer.news()
  assert.deepEqual(n.quotes.map((q) => [q.state, q.approved]), [['quoted', [seller.did]]])
  await buyer.commit(session)
  assert.deepEqual((await seller.news()).quotes.map((q) => q.state), ['agreed'])
})

test('a beacon can be put out by the key that lit it, and stays out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'varde-relay-'))
  const dataFile = join(dir, 'relay.json')
  let durable = await startRelay({ dataFile })
  const port = durable.port
  const seller = await Agent.start({ identity: createIdentity(), relayUrl: durable.url })
  const reader = await RelayClient.connect(durable.url)
  const { id, beacon } = await seller.light({ what: 'Selling my only kayak', intent: 'offer' })
  const other = await seller.light({ what: 'Selling a paddle', intent: 'offer' })

  // Someone else cannot put it out, with their own key or by claiming the seller's.
  const mallory = createIdentity()
  const forged = { ...retractBeacon(mallory, lightBeacon(mallory, { what: 'x', expires: beacon.expires, reachMe: beacon.reachMe })), beacon: id }
  await assert.rejects(reader.retract(forged), /bad signature/)
  await assert.rejects(reader.retract({ ...retractBeacon(seller.identity, beacon), beacon: other.id }), /bad signature/)
  assert.throws(() => retractBeacon(mallory, beacon), /only the key that lit/)
  assert.equal((await reader.query({ ids: [id] })).length, 1)

  await seller.douse(id)
  assert.deepEqual((await reader.query({})).map(beaconId), [other.id])
  assert.equal(seller.beacons.has(id), false)
  // It cannot be put back, by anyone holding a copy or by the seller.
  await assert.rejects(reader.publish(beacon), /retracted/)
  await assert.rejects(seller.douse(id), /no live beacon/)

  // The relay remembers across a restart.
  seller.close()
  reader.close()
  await durable.close()
  durable = await startRelay({ dataFile, port })
  const again = await RelayClient.connect(durable.url)
  await assert.rejects(again.publish(beacon), /retracted/)
  assert.deepEqual((await again.query({})).map(beaconId), [other.id])
  again.close()
  await durable.close()
  rmSync(dir, { recursive: true, force: true })
})
