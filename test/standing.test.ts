import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { Agent, type AgentOptions, type AgentState } from '../src/agent.js'
import { createIdentity } from '../src/core/identity.js'
import { approveQuote, checkReceipt } from '../src/core/receipt.js'
import { type Relay, startRelay } from '../src/relay/server.js'
import { type Room, startRoom } from '../src/room/server.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let relay: Relay
let room: Room
const agents: Agent[] = []
const agent = async (o: Partial<AgentOptions> = {}) => {
  const a = await Agent.start({ identity: createIdentity(), relayUrl: relay.url, rooms: [room.url], autoJoinMs: 400, ...o })
  agents.push(a)
  return a
}
const nextQuote = (a: Agent) => new Promise<void>((r) => a.once('quote', () => r()))
before(async () => {
  relay = await startRelay()
  room = await startRoom({ identity: createIdentity() })
})
after(async () => {
  for (const a of agents) a.close()
  await room.close()
  await relay.close()
})

test('a beacon with a standing mandate is negotiated without its owner being there', async () => {
  const owner = createIdentity()
  const studio = await agent({ owner: owner.did })
  const { id, beacon } = await studio.light({
    what: 'Seeking beta testers for a game. Paying per tester.', intent: 'want',
    standing: { side: 'pay', currency: 'NOK', limit: 200, target: 120 },
  })
  // The limit is the agent's private business: nothing of the mandate is in what was published.
  assert.ok(!JSON.stringify(beacon).includes('200') && !('standing' in beacon))

  // A tester answers and negotiates. Nobody tells the studio's agent to do anything.
  const tester = await agent()
  const contact = await tester.contact(beacon)
  const quoted = nextQuote(studio)
  const mine = await tester.negotiate(contact.session, { side: 'receive', currency: 'NOK', limit: 150, target: 260 })
  assert.equal(mine.outcome, 'quoted')
  await quoted
  const held = studio.quotes.get(contact.session)!
  assert.equal(held.state, 'quoted')
  assert.ok(held.quote.terms.price >= 150 && held.quote.terms.price <= 200)
  assert.equal(studio.contacts.get(contact.session)!.myBeacon, id)

  // Unattended stops at the quote. The deal still needs the owner.
  assert.equal(held.quote.parties.find((p) => p.did === studio.did)!.approver, owner.did)
  await tester.commit(contact.session)
  assert.equal(studio.receipts.length, 0)
  const done = await studio.commit(contact.session, approveQuote(owner, held.quote, studio.did))
  assert.equal(checkReceipt(done.receipt!), null)
})

test('the counterpart may come late: the agent keeps returning to the room', async () => {
  const seller = await agent()
  const { beacon } = await seller.light({ what: 'Selling a canoe', intent: 'offer', standing: { side: 'receive', currency: 'NOK', limit: 3200, target: 4400 } })
  const buyer = await agent()
  const contact = await buyer.contact(beacon)
  // Several of the seller's short waits in the room pass before the buyer turns up.
  await sleep(1500)
  const got = await buyer.negotiate(contact.session, { side: 'pay', currency: 'NOK', limit: 4000, target: 2800 })
  assert.equal(got.outcome, 'quoted')
})

test('a cap on deals is respected, and a mandate with no overlap just ends', async () => {
  const seller = await agent()
  const { beacon } = await seller.light({ what: 'Selling my only kayak', intent: 'offer', standing: { side: 'receive', currency: 'NOK', limit: 3000, target: 4000, maxDeals: 1 } })
  const [first, second, cheap] = [await agent(), await agent(), await agent()]

  // An offer far below the floor gets no quote and does not use up the one deal.
  const c0 = await cheap.contact(beacon)
  const low = await cheap.negotiate(c0.session, { side: 'pay', currency: 'NOK', limit: 1000, target: 500 })
  assert.equal(low.outcome, 'ended')

  const c1 = await first.contact(beacon)
  assert.equal((await first.negotiate(c1.session, { side: 'pay', currency: 'NOK', limit: 3800, target: 2800 })).outcome, 'quoted')
  // The second buyer finds nobody in the room: the seller's agent has its one quote.
  const c2 = await second.contact(beacon)
  const late = await second.negotiate(c2.session, { side: 'pay', currency: 'NOK', limit: 3900, target: 2800, timeoutMs: 1200 })
  assert.deepEqual([late.outcome, (late as { reason?: string }).reason], ['ended', 'timeout'])
  assert.equal([...seller.quotes.values()].filter((q) => q.state === 'quoted').length, 1)

  // If the first buyer withdraws, the deal is free again, and a new buyer is served.
  await first.withdraw(c1.session)
  await seller.refresh(c1.session)
  const third = await agent()
  const c3 = await third.contact(beacon)
  assert.equal((await third.negotiate(c3.session, { side: 'pay', currency: 'NOK', limit: 3900, target: 2800 })).outcome, 'quoted')
})

test('a standing mandate survives a restart, and a contact that arrived while away is still served', async () => {
  let saved: AgentState | undefined
  const store = { load: () => saved, save: (s: AgentState) => void (saved = JSON.parse(JSON.stringify(s))) }
  const identity = createIdentity()
  const first = await Agent.start({ identity, relayUrl: relay.url, rooms: [room.url], store, autoJoinMs: 400 })
  const { id, beacon } = await first.light({ what: 'Selling a tent', intent: 'offer', standing: { side: 'receive', currency: 'NOK', limit: 500, target: 900 } })
  first.close()
  assert.deepEqual(Object.keys(saved!.standing ?? {}), [id])

  // The hello waits in the mailbox while the seller's agent is not running.
  const buyer = await agent({ handshakeTimeoutMs: 5000 })
  const pending = buyer.contact(beacon)
  await sleep(200)
  const back = await Agent.start({ identity, relayUrl: relay.url, rooms: [room.url], store, autoJoinMs: 400 })
  agents.push(back)
  const contact = await pending
  const quoted = nextQuote(back)
  assert.equal((await buyer.negotiate(contact.session, { side: 'pay', currency: 'NOK', limit: 800, target: 400 })).outcome, 'quoted')
  await quoted
  assert.equal(back.quotes.size, 1)
})

test('a bad standing mandate is refused before anything is published', async () => {
  const a = await agent()
  await assert.rejects(a.light({ what: 'x', intent: 'offer', standing: { side: 'receive', currency: 'NOK', limit: -5, target: 10 } }), /standing mandate/)
  assert.equal(a.beacons.size, 0)
})
