import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { type Beacon, beaconId, lightBeacon } from '../src/core/beacon.js'
import { type Identity, createIdentity } from '../src/core/identity.js'
import { openMail, sealMail } from '../src/core/mail.js'
import { RelayClient } from '../src/relay/client.js'
import { type Relay, startRelay } from '../src/relay/server.js'

const HOUR = 60 * 60_000
let clock = Date.now()
let relay: Relay
const clients: RelayClient[] = []
const connect = async (id?: Identity) => {
  const c = await RelayClient.connect(relay.url, id)
  clients.push(c)
  return c
}
const beacon = (id: Identity, what: string, ttl = HOUR, extra: object = {}): Beacon =>
  lightBeacon(id, {
    what: { text: what, ...extra },
    expires: new Date(clock + ttl).toISOString(),
    reachMe: [{ kind: 'mailbox', relay: relay.url, encKey: id.encPub }],
  })

before(async () => {
  relay = await startRelay({ now: () => clock, maxTtlMs: 48 * HOUR, maxPerWho: 3 })
})
after(async () => {
  for (const c of clients) c.close()
  await relay.close()
})

test('anyone can publish without an account, and anyone can listen', async () => {
  const id = createIdentity()
  const pub = await connect()
  const b = beacon(id, 'Italian restaurant, takes bookings', HOUR, { tags: ['italian'], intent: 'offer' })
  assert.equal(await pub.publish(b), beaconId(b))
  const listener = await connect()
  assert.deepEqual(await listener.query({ tags: ['italian'] }), [b])
  assert.deepEqual(await listener.query({ tags: ['sushi'] }), [])
  assert.deepEqual(await listener.query({ text: 'BOOKINGS', intent: 'offer' }), [b])
})

test('a live subscription receives beacons as they are lit', async () => {
  const listener = await connect()
  const got: Beacon[] = []
  const sub = listener.subscribe({ text: 'meetup' }, (b) => got.push(b))
  await sub.eose
  const pub = await connect()
  await pub.publish(beacon(createIdentity(), 'Rust meetup on Thursday'))
  await pub.publish(beacon(createIdentity(), 'Unrelated'))
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(got.length, 1)
  sub.close()
})

test('the relay refuses forged, expired and overlong beacons', async () => {
  const c = await connect()
  const good = beacon(createIdentity(), 'A table for two')
  await assert.rejects(c.publish({ ...good, what: 'A table for ten' }), /bad signature/)
  await assert.rejects(c.publish(beacon(createIdentity(), 'Too long', 72 * HOUR)), /too far ahead/)
  const id = createIdentity()
  for (let i = 0; i < 3; i++) await c.publish(beacon(id, `beacon ${i}`))
  await assert.rejects(c.publish(beacon(id, 'one too many')), /too many/)
})

test('expired beacons are no longer served', async () => {
  const c = await connect()
  const b = beacon(createIdentity(), 'Table tonight at 19:00', HOUR)
  await c.publish(b)
  assert.equal((await c.query({ ids: [beaconId(b)] })).length, 1)
  clock += 2 * HOUR
  assert.equal((await c.query({ ids: [beaconId(b)] })).length, 0)
  relay.sweep()
  clock -= 2 * HOUR
})

test('mail waits for its recipient, who must prove the key to read it', async () => {
  const alice = createIdentity()
  const bob = createIdentity()
  const sender = await connect()
  await sender.sendMail(bob.did, sealMail(alice, bob.did, bob.encPub, 'varde.hello', { hi: 1 }).sealed)

  await assert.rejects((await connect()).onMail(() => {}), /auth required/)

  const eve = await connect(createIdentity())
  let eveGot = 0
  await eve.onMail(() => eveGot++)

  const inbox = await connect(bob)
  const got = await new Promise<{ id: string; sealed: any }>((resolve) => void inbox.onMail(resolve))
  assert.equal(openMail(bob, got.sealed)?.from, alice.did)
  assert.equal(eveGot, 0)

  await inbox.ack([got.id])
  assert.equal(relay.stats().mail, 0)
})
