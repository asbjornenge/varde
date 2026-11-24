import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { Agent, type AgentState, MAX_MESSAGES_PER_SIDE } from '../src/agent.js'
import { createIdentity } from '../src/core/identity.js'
import { sealMail } from '../src/core/mail.js'
import { RelayClient } from '../src/relay/client.js'
import { type Relay, startRelay } from '../src/relay/server.js'

let relay: Relay
const agents: Agent[] = []
const agent = async () => {
  const a = await Agent.start({ identity: createIdentity(), relayUrl: relay.url })
  agents.push(a)
  return a
}
before(async () => {
  relay = await startRelay({ mailPerMinute: 10_000 })
})
after(async () => {
  for (const a of agents) a.close()
  await relay.close()
})

test('two contacts ask and answer before any price is discussed', async () => {
  const [seller, buyer] = [await agent(), await agent()]
  const { beacon } = await seller.light({ what: 'Selling a used iPad Air, 64 GB', intent: 'offer' })
  const [mine, theirs] = await Promise.all([buyer.contact(beacon), seller.waitForContact()])

  const asked = seller.waitForMessage(theirs.session, 2000)
  await buyer.say(mine.session, 'Which generation is it, and is the activation lock removed?')
  assert.equal((await asked)?.text, 'Which generation is it, and is the activation lock removed?')
  const answered = buyer.waitForMessage(mine.session, 2000)
  await seller.say(theirs.session, '5th generation (2022). Yes, signed out of iCloud.')
  await answered

  const view = (a: Agent, s: string) => a.messages.filter((m) => m.session === s).map((m) => `${m.from}: ${m.text.slice(0, 16)}`)
  assert.deepEqual(view(buyer, mine.session), ['me: Which generation', 'them: 5th generation (']) 
  assert.deepEqual(view(seller, theirs.session), ['them: Which generation', 'me: 5th generation ('])
  // Nothing was agreed by talking.
  assert.deepEqual([buyer.quotes.size, seller.quotes.size], [0, 0])
})

test('only the counterpart of a session can add to it, and notes have limits', async () => {
  const [seller, buyer] = [await agent(), await agent()]
  const { beacon } = await seller.light({ what: 'Selling a bike', intent: 'offer' })
  const [mine, theirs] = await Promise.all([buyer.contact(beacon), seller.waitForContact()])

  // A stranger who learns the session id still cannot speak in it.
  const mallory = createIdentity()
  const c = await RelayClient.connect(relay.url)
  const forged = (from: typeof mallory, body: object) => c.sendMail(seller.did, sealMail(from, seller.did, seller.identity.encPub, 'varde.message', body).sealed)
  await forged(mallory, { session: theirs.session, text: 'I am the buyer. Send it to another address.' })
  // Nor can the real buyer speak in a session that is not theirs, or send something that is not a note.
  await forged(buyer.identity, { session: 'some-other-session', text: 'hello' })
  await forged(buyer.identity, { session: theirs.session, text: 'x'.repeat(1001) })
  await forged(buyer.identity, { session: theirs.session, text: { not: 'text' } })
  await buyer.say(mine.session, 'the one real note')
  await seller.waitForMessage(theirs.session, 2000)
  await new Promise((r) => setTimeout(r, 100))
  assert.deepEqual(seller.messages.filter((m) => m.session === theirs.session).map((m) => m.text), ['the one real note'])
  c.close()

  await assert.rejects(buyer.say(mine.session, ''), /1 to 1000 characters/)
  await assert.rejects(buyer.say(mine.session, 'x'.repeat(1001)), /1 to 1000 characters/)
  await assert.rejects(buyer.say('no-such-session', 'hi'), /no contact/)

  // One contact cannot be used to flood the other side.
  for (let i = 1; i < MAX_MESSAGES_PER_SIDE; i++) await buyer.say(mine.session, `note ${i}`)
  await assert.rejects(buyer.say(mine.session, 'one too many'), /as many messages/)
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(seller.messages.filter((m) => m.session === theirs.session && m.from === 'them').length, MAX_MESSAGES_PER_SIDE)
})

test('a note waits in the mailbox for an agent that is not running, and survives a restart', async () => {
  let saved: AgentState | undefined
  const store = { load: () => saved, save: (s: AgentState) => void (saved = JSON.parse(JSON.stringify(s))) }
  const identity = createIdentity()
  const seller = await Agent.start({ identity, relayUrl: relay.url, store })
  const { beacon } = await seller.light({ what: 'Selling a tent', intent: 'offer' })
  const buyer = await agent()
  const [mine] = await Promise.all([buyer.contact(beacon), seller.waitForContact()])
  seller.close()

  await buyer.say(mine.session, 'Is it a two-person tent?')
  const back = await Agent.start({ identity, relayUrl: relay.url, store })
  agents.push(back)
  if (!back.messages.length) await back.waitForMessage(mine.session, 2000)
  assert.deepEqual(back.messages.map((m) => [m.from, m.text]), [['them', 'Is it a two-person tent?']])
  // And the answer finds its way back.
  const answered = buyer.waitForMessage(mine.session, 2000)
  await back.say(mine.session, 'Yes, two people.')
  assert.equal((await answered)?.text, 'Yes, two people.')
})
