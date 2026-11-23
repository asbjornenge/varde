import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type Beacon, beaconId, checkBeacon, lightBeacon } from '../src/core/beacon.js'
import { canonicalize } from '../src/core/canonical.js'
import { createIdentity, didFromPublicKey, publicKeyFromDid, sign, verify } from '../src/core/identity.js'
import { openMail, sealMail } from '../src/core/mail.js'
import { seal, unseal } from '../src/core/seal.js'

const HOUR = 60 * 60_000
const light = (id = createIdentity(), over: Partial<Parameters<typeof lightBeacon>[1]> = {}, now = Date.now()) =>
  lightBeacon(
    id,
    {
      what: 'Looking for a used iPad Air, under 4000 kr',
      scope: { where: 'Stavanger area' },
      expires: new Date(now + HOUR).toISOString(),
      reachMe: [{ kind: 'mailbox', relay: 'ws://relay.example', encKey: id.encPub }],
      ...over,
    },
    now,
  )

test('canonical JSON sorts keys and drops undefined', () => {
  assert.equal(canonicalize({ b: 1, a: [true, null, 'x'], c: undefined }), '{"a":[true,null,"x"],"b":1}')
  assert.throws(() => canonicalize({ n: NaN }))
})

test('did:key round-trips an Ed25519 key', () => {
  const id = createIdentity()
  assert.match(id.did, /^did:key:z6Mk/)
  assert.equal(didFromPublicKey(publicKeyFromDid(id.did)), id.did)
  assert.throws(() => publicKeyFromDid('did:plc:abc123'))
})

test('a signature is bound to its context', () => {
  const id = createIdentity()
  const sig = sign(id, 'beacon', { a: 1 })
  assert.equal(verify(id.did, 'beacon', { a: 1 }, sig), true)
  assert.equal(verify(id.did, 'receipt', { a: 1 }, sig), false)
  assert.equal(verify(createIdentity().did, 'beacon', { a: 1 }, sig), false)
})

test('a lit beacon verifies and has a stable id', () => {
  const b = light()
  assert.equal(checkBeacon(b), null)
  assert.equal(beaconId(b), beaconId(JSON.parse(JSON.stringify(b))))
  assert.equal(typeof b.who, 'string')
  assert.equal(typeof b.sig, 'string')
})

test('any change to a beacon breaks its signature', () => {
  const b = light()
  assert.equal(checkBeacon({ ...b, what: 'Looking for a used iPad Air, under 9000 kr' }), 'bad signature')
  assert.equal(checkBeacon({ ...b, expires: new Date(Date.now() + 99 * HOUR).toISOString() }), 'bad signature')
  assert.equal(checkBeacon({ ...b, reachMe: [{ kind: 'mailbox', relay: 'ws://evil.example', encKey: 'x' }] }), 'bad signature')
  // Claiming someone else's key does not work either.
  assert.equal(checkBeacon({ ...b, who: createIdentity().did }), 'bad signature')
})

test('a beacon burns out at its expiry', () => {
  const now = Date.now()
  const b = light(undefined, {}, now)
  assert.equal(checkBeacon(b, now + HOUR - 1), null)
  assert.equal(checkBeacon(b, now + HOUR), 'expired')
})

test('malformed beacons are refused with a reason', () => {
  const id = createIdentity()
  assert.throws(() => light(id, { what: '' }), /what/)
  assert.throws(() => light(id, { reachMe: [] }), /reachMe/)
  assert.throws(() => light(id, { expires: new Date(Date.now() - HOUR).toISOString() }), /expire/)
  assert.throws(() => light(id, { what: 'x'.repeat(2001) }), /what/)
  assert.equal(checkBeacon({ ...light(id), v: 2 } as unknown as Beacon), 'unsupported version')
})

test('a sealed box opens only for its recipient', () => {
  const alice = createIdentity()
  const bob = createIdentity()
  const box = seal(alice.encPub, Buffer.from('hei'))
  assert.equal(unseal(alice.encPub, alice.encPriv, box)?.toString(), 'hei')
  assert.equal(unseal(bob.encPub, bob.encPriv, box), null)
  // Flip one bit in each byte of the ciphertext in turn: every change is caught.
  const raw = Buffer.from(box.ct, 'base64url')
  for (let i = 0; i < raw.length; i++) {
    const bent = Buffer.from(raw)
    bent[i] ^= 1
    assert.equal(unseal(alice.encPub, alice.encPriv, { ...box, ct: bent.toString('base64url') }), null)
  }
})

test('mail is signed by the sender and sealed to the recipient', () => {
  const alice = createIdentity()
  const bob = createIdentity()
  const { sealed } = sealMail(alice, bob.did, bob.encPub, 'varde.hello', { n: 1 })
  const mail = openMail(bob, sealed)
  assert.equal(mail?.from, alice.did)
  assert.deepEqual(mail?.body, { n: 1 })
  assert.equal(openMail(alice, sealed), null)
  // Mail sealed to Bob's key but addressed to someone else is dropped.
  const wrong = sealMail(alice, alice.did, bob.encPub, 'varde.hello', {})
  assert.equal(openMail(bob, wrong.sealed), null)
})
