import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Agent, type AgentOptions, type AgentState } from '../src/agent.js'
import { createIdentity } from '../src/core/identity.js'
import { approveQuote, checkReceipt, withdrawQuote } from '../src/core/receipt.js'
import { commitQuote, quoteStatus, withdrawFromQuote } from '../src/room/client.js'
import { type Relay, startRelay } from '../src/relay/server.js'
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
before(async () => {
  relay = await startRelay()
  room = await startRoom({ identity: createIdentity() })
})
after(async () => {
  for (const a of agents) a.close()
  await room.close()
  await relay.close()
})

/** Lights an offer, has the buyer answer it, and negotiates to a quote. Returns the session. */
async function quoteBetween(buyer: Agent, seller: Agent, o: { ceiling?: number; floor?: number; hold?: number; what?: string } = {}) {
  const { beacon } = await seller.light({ what: o.what ?? `Selling item ${Math.random()}`, intent: 'offer' })
  const [mine] = await Promise.all([buyer.contact(beacon), seller.waitForContact((c) => c.peer === buyer.did)])
  const [b, s] = await Promise.all([
    buyer.negotiate(mine.session, { side: 'pay', currency: 'NOK', limit: o.ceiling ?? 4000, target: 2800, holdSeconds: o.hold }),
    seller.negotiate(mine.session, { side: 'receive', currency: 'NOK', limit: o.floor ?? 3200, target: 4400 }),
  ])
  assert.equal(b.outcome, 'quoted')
  assert.equal(s.outcome, 'quoted')
  return mine.session
}

test('a quote commits nobody: the deal is made only when both sides have approved, in either order', async () => {
  for (const sellerFirst of [true, false]) {
    const [buyer, seller] = [await agent(), await agent()]
    const session = await quoteBetween(buyer, seller)
    assert.deepEqual([buyer.receipts.length, seller.receipts.length, buyer.quotes.get(session)!.state], [0, 0, 'quoted'])

    const [first, second] = sellerFirst ? [seller, buyer] : [buyer, seller]
    const half = await first.commit(session)
    assert.deepEqual([half.state, half.approved, half.receipt], ['quoted', [first.did], undefined])
    const done = await second.commit(session)
    assert.equal(done.state, 'agreed')
    assert.equal(checkReceipt(done.receipt!), null)
    // The first to commit learns of the deal when it next asks.
    assert.deepEqual((await first.refresh(session)).receipt, done.receipt)
    assert.deepEqual([buyer.receipts.length, seller.receipts.length], [1, 1])
    // Committing again changes nothing.
    assert.deepEqual((await second.commit(session)).receipt, done.receipt)
  }
})

test('with an owner, only the owner\'s key can commit: the agent\'s own approval is refused by the room too', async () => {
  const owner = createIdentity()
  const [buyer, seller] = [await agent({ owner: owner.did }), await agent()]
  const session = await quoteBetween(buyer, seller)
  const { quote } = buyer.quotes.get(session)!
  assert.equal(quote.parties.find((p) => p.did === buyer.did)!.approver, owner.did)

  await assert.rejects(buyer.commit(session), /owner's approval/)
  // Even an agent that skips its own check gets nowhere: the room checks the signer.
  await assert.rejects(commitQuote(room.url, quote, approveQuote(buyer.identity, quote, buyer.did)), /not signed by the key this quote requires/)
  // Nor can the seller approve on the buyer's behalf, or a stranger.
  for (const signer of [seller.identity, createIdentity()])
    await assert.rejects(commitQuote(room.url, quote, approveQuote(signer, quote, buyer.did)), /not signed by the key/)
  await seller.commit(session)
  assert.equal((await buyer.refresh(session)).state, 'quoted')

  const done = await buyer.commit(session, approveQuote(owner, quote, buyer.did))
  assert.equal(done.state, 'agreed')
  assert.deepEqual(done.receipt!.approvals.map((a) => a.by).sort(), [owner.did, seller.did].sort())
})

test('the owner can let the agent commit small amounts by itself', async () => {
  const owner = createIdentity()
  const seller = await agent()
  // Up to 3000 without asking. The quote will land above that, so the owner is needed.
  const careful = await agent({ owner: owner.did, autoCommit: 3000 })
  let session = await quoteBetween(careful, seller)
  assert.equal(careful.quotes.get(session)!.quote.parties.find((p) => p.did === careful.did)!.approver, owner.did)
  // Up to 5000: the same quote may be committed by the agent.
  const trusted = await agent({ owner: owner.did, autoCommit: 5000 })
  session = await quoteBetween(trusted, seller)
  assert.equal(trusted.quotes.get(session)!.quote.parties.find((p) => p.did === trusted.did)!.approver, trusted.did)
  await seller.commit(session)
  assert.equal((await trusted.commit(session)).state, 'agreed')
})

test('quotes from three sellers: the owner approves one, the rest are withdrawn, and there is one receipt', async () => {
  const owner = createIdentity()
  const buyer = await agent({ owner: owner.did })
  const sellers = [await agent(), await agent(), await agent()]
  const floors = [3300, 3000, 3600]
  const sessions: string[] = []
  for (const [i, s] of sellers.entries()) sessions.push(await quoteBetween(buyer, s, { floor: floors[i] }))
  for (const [i, s] of sellers.entries()) await s.commit(sessions[i]) // every seller is ready to sell
  assert.deepEqual([room.stats().quotes >= 3, buyer.receipts.length], [true, 0])

  const held = [...buyer.quotes.values()].filter((q) => sessions.includes(q.quote.session))
  const best = held.reduce((a, b) => (a.quote.terms.price <= b.quote.terms.price ? a : b))
  assert.equal(best.quote.session, sessions[1]) // the seller with the lowest floor gave the lowest price
  await buyer.commit(best.quote.session, approveQuote(owner, best.quote, buyer.did))
  for (const q of held) if (q !== best) await buyer.withdraw(q.quote.session)

  assert.equal(buyer.receipts.length, 1)
  assert.deepEqual(await Promise.all(sellers.map(async (s, i) => (await s.refresh(sessions[i])).state)), ['withdrawn', 'agreed', 'withdrawn'])
  assert.deepEqual(sellers.map((s) => s.receipts.length), [0, 1, 0])
  // A withdrawn quote cannot be revived, even with the owner's approval.
  const dead = held.find((q) => q !== best)!
  await assert.rejects(commitQuote(room.url, dead.quote, approveQuote(owner, dead.quote, buyer.did)), /withdrawn/)
})

test('one item, two buyers who both say yes: the seller commits to one and the other is told no', async () => {
  const seller = await agent()
  const [first, second] = [await agent(), await agent()]
  const s1 = await quoteBetween(first, seller, { what: 'Selling my only kayak' })
  const s2 = await quoteBetween(second, seller, { what: 'Selling my only kayak, still' })
  await first.commit(s1)
  await second.commit(s2)
  assert.equal(seller.receipts.length, 0)

  assert.equal((await seller.commit(s2)).state, 'agreed')
  assert.equal((await seller.withdraw(s1)).state, 'withdrawn')
  const lost = await first.refresh(s1)
  assert.deepEqual([lost.state, lost.receipt, first.receipts.length], ['withdrawn', undefined, 0])
  assert.equal((await second.refresh(s2)).state, 'agreed')
  // Once made, a deal cannot be withdrawn from.
  await assert.rejects(seller.withdraw(s2), /already made/)
  await assert.rejects(second.withdraw(s2), /already made/)
})

test('a quote lapses at its deadline and can no longer be approved', async () => {
  const [buyer, seller] = [await agent(), await agent()]
  const session = await quoteBetween(buyer, seller, { hold: 1 })
  const { quote } = buyer.quotes.get(session)!
  assert.ok(Date.parse(quote.validUntil) - Date.parse(quote.at) <= 1000)
  await seller.commit(session)
  await sleep(1100)
  await assert.rejects(buyer.commit(session), /lapsed/)
  assert.equal((await seller.refresh(session)).state, 'lapsed')
  assert.equal(seller.receipts.length, 0)
})

test('only a party can withdraw, and an approval cannot be moved to another quote', async () => {
  const seller = await agent()
  const [a, b] = [await agent(), await agent()]
  const sa = await quoteBetween(a, seller)
  const sb = await quoteBetween(b, seller)
  const [qa, qb] = [a.quotes.get(sa)!.quote, b.quotes.get(sb)!.quote]

  await assert.rejects(withdrawFromQuote(room.url, qa, withdrawQuote(createIdentity(), qa)), /not a party/)
  await assert.rejects(withdrawFromQuote(room.url, qa, { ...withdrawQuote(b.identity, qa), party: a.did }), /bad signature/)
  // The seller's yes to one buyer is not a yes to the other.
  const yes = approveQuote(seller.identity, qa, seller.did)
  await assert.rejects(commitQuote(room.url, qb, yes), /another quote/)
  await assert.rejects(quoteStatus(room.url, 'no-such-session-anywhere'), /no quote/)
  assert.equal((await quoteStatus(room.url, sa, qa)).state, 'quoted')
})

test('a quote survives the room restarting and the agent going away and coming back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'varde-room-'))
  const dataFile = join(dir, 'quotes.json')
  const identity = createIdentity()
  let durable = await startRoom({ identity, dataFile })
  const port = durable.port
  let saved: AgentState | undefined
  const store = { load: () => saved, save: (s: AgentState) => void (saved = JSON.parse(JSON.stringify(s))) }
  const buyerId = createIdentity()
  const buyer = await Agent.start({ identity: buyerId, relayUrl: relay.url, rooms: [durable.url], store })
  const seller = await agent({ rooms: [durable.url] })
  const session = await quoteBetween(buyer, seller)
  await seller.commit(session)
  buyer.close()

  await durable.close()
  durable = await startRoom({ identity, dataFile, port })
  assert.equal(durable.stats().quotes, 1)

  // A day later, as it were: a new process with the same key and its saved state.
  const back = await Agent.start({ identity: buyerId, relayUrl: relay.url, rooms: [durable.url], store })
  agents.push(back)
  assert.deepEqual((await back.refresh(session)).approved, [seller.did])
  const done = await back.commit(session)
  assert.equal(done.state, 'agreed')
  assert.equal(checkReceipt(done.receipt!), null)

  await durable.close()
  rmSync(dir, { recursive: true, force: true })
})

test('crossing contact: two agents that answer each other\'s beacons at the same moment get one session', async () => {
  for (let round = 0; round < 5; round++) {
    const [buyer, seller] = [await agent(), await agent()]
    const offer = await seller.light({ what: 'Selling a used iPad Air', intent: 'offer' })
    const want = await buyer.light({ what: 'Looking for a used iPad Air', intent: 'want' })
    const [b, s] = await Promise.all([buyer.contact(offer.beacon, { as: want.id }), seller.contact(want.beacon, { as: offer.id })])
    assert.equal(b.session, s.session)
    await sleep(150) // let any stray handshake finish
    assert.deepEqual([buyer.contacts.size, seller.contacts.size], [1, 1])
    // Asking again returns the same contact instead of opening another session.
    assert.equal((await buyer.contact(offer.beacon, { as: want.id })).session, b.session)

    const [qb, qs] = await Promise.all([
      buyer.negotiate(b.session, { side: 'pay', currency: 'NOK', limit: 4000, target: 2800 }),
      seller.negotiate(s.session, { side: 'receive', currency: 'NOK', limit: 3200, target: 4400 }),
    ])
    assert.deepEqual([qb.outcome, qs.outcome], ['quoted', 'quoted'])
    // And the room will not open a second negotiation on a session that already has a quote.
    const again = await buyer.negotiate(b.session, { side: 'pay', currency: 'NOK', limit: 4000, target: 2800, timeoutMs: 500 })
    assert.deepEqual([again.outcome, (again as { reason?: string }).reason], ['ended', 'refused: this session already has a quote'])
  }
})
