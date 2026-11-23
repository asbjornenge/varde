import assert from 'node:assert/strict'
import { test } from 'node:test'
import WebSocket from 'ws'
import { Agent } from '../src/agent.js'
import { type Beacon, checkBeacon, lightBeacon } from '../src/core/beacon.js'
import { createIdentity } from '../src/core/identity.js'
import { sealMail } from '../src/core/mail.js'
import { minePow, powBits } from '../src/core/pow.js'
import { RelayClient } from '../src/relay/client.js'
import { startRelay } from '../src/relay/server.js'

const beacon = (what: string, pow?: number, id = createIdentity()): Beacon =>
  lightBeacon(id, { what, pow, expires: new Date(Date.now() + 60_000).toISOString(), reachMe: [{ kind: 'mailbox', relay: 'ws://r', encKey: id.encPub }] })

test('proof of work is bound to the beacon it was done for', () => {
  const b = beacon('Selling a canoe', 16)
  assert.equal(checkBeacon(b), null)
  assert.ok(powBits(b) >= 16)
  assert.equal(powBits(beacon('No work done')), 0)
  // The same proof on another beacon is worth nothing (give or take luck).
  const other = beacon('Selling a kayak')
  assert.ok(powBits({ ...other, proofs: b.proofs }) < 16)
  // A proof that merely claims many bits is measured, not believed.
  assert.ok(powBits({ ...other, proofs: [{ type: 'pow', bits: 40, nonce: 'x' }] }) < 16)
  assert.ok(powBits({ ...other, proofs: [minePow(other, 10)] }) >= 10)
})

test('a relay that asks for work refuses beacons without it, and agents do the work unasked', async () => {
  const relay = await startRelay({ minPowBits: 12 })
  const c = await RelayClient.connect(relay.url)
  assert.equal(c.policy.powBits, 12)
  await assert.rejects(c.publish(beacon('free ride')), /needs 12 bits of proof of work/)
  await assert.rejects(c.publish(beacon('too little', 4)), /proof of work/)
  await c.publish(beacon('paid', 12))

  const agent = await Agent.start({ identity: createIdentity(), relayUrl: relay.url })
  const lit = await agent.light({ what: 'Selling a tent', intent: 'offer' })
  assert.ok(powBits(lit.beacon) >= 12)
  assert.equal(relay.stats().beacons, 2)
  agent.close()
  c.close()
  await relay.close()

  // An agent will not mine without end for a relay that asks too much.
  const greedy = await startRelay({ minPowBits: 40 })
  const wary = await Agent.start({ identity: createIdentity(), relayUrl: greedy.url })
  await assert.rejects(wary.light({ what: 'x', intent: 'offer' }), /more than this agent will do/)
  wary.close()
  await greedy.close()
})

test('the relay limits how fast one address can publish, send mail and talk', async () => {
  const relay = await startRelay({ publishesPerMinute: 5, mailPerMinute: 3, messageBurst: 40, messagesPerSecond: 1 })
  const c = await RelayClient.connect(relay.url)
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => c.publish(beacon(`beacon ${i}`))))
  assert.deepEqual(results.map((r) => r.status === 'fulfilled'), [true, true, true, true, true, false, false, false])
  assert.match((results[5] as PromiseRejectedResult).reason.message, /rate limited/)
  // A second connection from the same address shares the limit.
  const d = await RelayClient.connect(relay.url)
  await assert.rejects(d.publish(beacon('from another connection')), /rate limited/)
  // Publishing the same beacon again costs nothing: it is already there.
  await d.publish((await d.query({}))[0])

  const [a, b] = [createIdentity(), createIdentity()]
  const mail = () => d.sendMail(b.did, sealMail(a, b.did, b.encPub, 'varde.hello', {}).sealed)
  const sent = await Promise.allSettled([mail(), mail(), mail(), mail()])
  assert.deepEqual(sent.map((r) => r.status === 'fulfilled'), [true, true, true, false])
  assert.equal(relay.stats().beacons, 5)

  // A connection that just talks too much is told so, whatever it says.
  const raw = new WebSocket(relay.url)
  const replies: string[] = []
  await new Promise((r) => raw.once('open', r))
  raw.on('message', (m) => replies.push(JSON.parse(m.toString()).reason ?? ''))
  for (let i = 0; i < 60; i++) raw.send(JSON.stringify({ t: 'nonsense' }))
  await new Promise((r) => setTimeout(r, 200))
  assert.ok(replies.filter((r) => r === 'unknown message type').length <= 41)
  assert.ok(replies.filter((r) => r === 'rate limited').length >= 19)
  raw.close()
  c.close()
  d.close()
  await relay.close()
})

test('the relay caps connections from one address', async () => {
  const relay = await startRelay({ maxConnectionsPerAddress: 3 })
  const open = await Promise.all([1, 2, 3].map(() => RelayClient.connect(relay.url)))
  await assert.rejects(RelayClient.connect(relay.url, undefined, 1000))
  open[0].close()
  await new Promise((r) => setTimeout(r, 50))
  const again = await RelayClient.connect(relay.url)
  for (const c of [...open, again]) c.close()
  await relay.close()
})
