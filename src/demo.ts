/**
 * The iPad case, with a person in the loop. A buyer's agent finds two
 * sellers, negotiates a quote with each, and takes both to its owner. The
 * owner approves one with a key the agent does not hold. Only then is a deal
 * made; the other quote is withdrawn.
 *
 * Everything runs in this one process on throwaway local ports.
 */
import { Agent } from './agent.js'
import { whatText } from './core/beacon.js'
import { createIdentity } from './core/identity.js'
import { approveQuote, checkReceipt } from './core/receipt.js'
import { startRelay } from './relay/server.js'
import { startRoom } from './room/server.js'

const short = (did: string) => did.slice(0, 16) + '…'
const step = (n: number, text: string) => console.log(`\n${n}. ${text}`)
const DAY = 24 * 60 * 60_000

const relay = await startRelay()
const room = await startRoom({ identity: createIdentity(), maxTurns: 12 })
console.log(`relay ${relay.url}\nroom  ${room.url} (${short(room.did)})`)

// The owner is a person. Their key is created here and never handed to the agent.
const owner = createIdentity()
const start = (o: object = {}) => Agent.start({ identity: createIdentity(), relayUrl: relay.url, rooms: [room.url], ...o })
const buyer = await start({ owner: owner.did })
const [anna, bjorn] = [await start(), await start()]
console.log(`buyer  ${short(buyer.did)}, acting for owner ${short(owner.did)}\nanna   ${short(anna.did)}\nbjørn  ${short(bjorn.did)}`)

step(1, 'Two sellers light standing offers.')
const offers = [
  await anna.light({ what: 'Selling a used iPad Air, 64 GB, good condition', intent: 'offer', scope: { where: 'Stavanger' }, ttlMs: 30 * DAY }),
  await bjorn.light({ what: 'Used iPad Air 64 GB for sale, small scratch on the back', intent: 'offer', scope: { where: 'Stavanger' }, ttlMs: 30 * DAY }),
]
for (const o of offers) console.log(`   "${whatText(o.beacon)}"`)

step(2, 'The buyer lights a want and listens for beacons that complement it.')
const want = await buyer.light({ what: 'Looking for a used iPad Air, under 4000 kr', intent: 'want', scope: { where: 'Stavanger area' }, ttlMs: 7 * DAY })
const matches = await buyer.listen({ beacon: want.id })
for (const m of matches) console.log(`   ${m.score.toFixed(3)}  "${whatText(m.beacon)}"`)
if (matches.length < 2) throw new Error('expected two matches')

step(3, 'Handshake with each seller over sealed mail: each side signs the other\'s nonce.')
const contacts = await Promise.all(matches.map((m) => buyer.contact(m.beacon, { as: want.id })))
const sellerOf = (did: string) => (did === anna.did ? anna : bjorn)
const nameOf = (did: string) => (did === anna.did ? 'anna ' : 'bjørn')
for (const c of contacts) console.log(`   ${nameOf(c.peer)} session ${c.session.slice(0, 12)}…`)

step(4, 'A negotiation with each, in the room. The buyer may pay at most 4000 NOK.')
// Each seller has its own floor and is willing to commit without asking anyone.
const floors = new Map([[anna.did, 3200], [bjorn.did, 2900]])
const sellers = contacts.map(async (c) => {
  const s = sellerOf(c.peer)
  const mine = await s.waitForContact((x) => x.session === c.session)
  return s.negotiate(mine.session, { side: 'receive', currency: 'NOK', limit: floors.get(c.peer)!, target: floors.get(c.peer)! + 1200, commit: true })
})
const quotes = await Promise.all(contacts.map((c) => buyer.negotiate(c.session, { side: 'pay', currency: 'NOK', limit: 4000, target: 2600 })))
for (const [i, q] of quotes.entries()) {
  if (q.outcome !== 'quoted') throw new Error(`no quote from ${nameOf(contacts[i].peer)}`)
  console.log(`   ${nameOf(contacts[i].peer)} quote: ${q.quote.terms.price} NOK in ${q.quote.turns} turns, stands until ${q.quote.validUntil}`)
}
console.log(`   nothing is binding yet: ${room.stats().quotes} quotes open, ${buyer.receipts.length} receipts`)

step(5, 'The agent cannot commit by itself: the quote names the owner\'s key as approver.')
const held = [...buyer.quotes.values()].sort((a, b) => a.quote.terms.price - b.quote.terms.price)
const [best, other] = held
console.log(`   agent tries: ${await buyer.commit(best.quote.session).then(() => 'committed', (e: Error) => e.message)}`)

step(6, 'The owner picks the cheaper quote and signs an approval. The agent delivers it.')
const approval = approveQuote(owner, best.quote, buyer.did)
const done = await buyer.commit(best.quote.session, approval)
const declined = await buyer.withdraw(other.quote.session)
console.log(`   ${nameOf(best.quote.parties.find((p) => p.did !== buyer.did)!.did)} ${best.quote.terms.price} NOK: ${done.state}`)
console.log(`   ${nameOf(other.quote.parties.find((p) => p.did !== buyer.did)!.did)} ${other.quote.terms.price} NOK: ${declined.state}`)

step(7, 'The room issues one receipt: the quote, both approvals, and its own signature.')
const outcomes = await Promise.all(sellers)
const r = done.receipt
if (!r) {
  console.log('   no receipt:', done.state)
  process.exitCode = 1
} else {
  console.log(`   agreed ${r.quote.terms.price} ${r.quote.terms.currency}`)
  console.log(`   approved by: ${r.approvals.map((a) => (a.by === owner.did ? 'the buyer\'s owner' : `${nameOf(a.by).trim()} (agent)`)).join(', ')}`)
  console.log(`   receipt check: ${checkReceipt(r) ?? 'valid'}`)
  console.log(`   sellers ended: ${outcomes.map((o, i) => `${nameOf(contacts[i].peer).trim()} ${o.outcome === 'ended' ? o.reason : o.outcome}`).join(', ')}`)
  console.log(`   buyer holds ${buyer.receipts.length} receipt, not two`)
}

for (const a of [buyer, anna, bjorn]) a.close()
await room.close()
await relay.close()
