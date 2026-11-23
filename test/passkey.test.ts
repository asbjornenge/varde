import assert from 'node:assert/strict'
import { type KeyObject, generateKeyPairSync, sign } from 'node:crypto'
import { test } from 'node:test'
import { Agent } from '../src/agent.js'
import { b64u, sha256 } from '../src/core/bytes.js'
import { createIdentity, didFromP256, isDid, isP256Did, p256FromDid } from '../src/core/identity.js'
import { type Approval, type ApprovalRequest, approvalRequest, approveQuote, checkApproval, checkReceipt, passkeyChallenge } from '../src/core/receipt.js'
import { commitQuote } from '../src/room/client.js'
import { startRelay } from '../src/relay/server.js'
import { startRoom } from '../src/room/server.js'

/**
 * Stands in for a phone's passkey: a P-256 key that signs what a browser's
 * `navigator.credentials.get()` would hand it, in the same byte layout.
 */
function passkey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return { did: didFromP256(publicKey), privateKey }
}

function assertion(key: KeyObject, request: ApprovalRequest, o: { flags?: number; type?: string; challenge?: string } = {}): Approval {
  const authenticatorData = Buffer.concat([sha256('approve.example'), Buffer.from([o.flags ?? 0x05]), Buffer.from([0, 0, 0, 7])])
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: o.type ?? 'webauthn.get', challenge: o.challenge ?? passkeyChallenge(request), origin: 'https://approve.example', crossOrigin: false }),
  )
  const signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), key)
  return { ...request, webauthn: { authenticatorData: b64u(authenticatorData), clientDataJSON: b64u(clientDataJSON), signature: b64u(signature) } }
}

test('a passkey has its own kind of did:key, which cannot be mistaken for an agent key', () => {
  const p = passkey()
  assert.match(p.did, /^did:key:zDn/)
  assert.equal(didFromP256(p256FromDid(p.did)), p.did)
  assert.equal(isP256Did(p.did), true)
  assert.equal(isDid(p.did), false) // so it can never light a beacon or join a room
  assert.equal(isP256Did(createIdentity().did), false)
})

test('an owner approves from a passkey, and the receipt verifies with nothing else', async () => {
  const relay = await startRelay()
  const room = await startRoom({ identity: createIdentity() })
  const owner = passkey()
  const buyer = await Agent.start({ identity: createIdentity(), relayUrl: relay.url, rooms: [room.url], owner: owner.did })
  const seller = await Agent.start({ identity: createIdentity(), relayUrl: relay.url, rooms: [room.url] })
  const { beacon } = await seller.light({ what: 'Selling a used iPad Air', intent: 'offer' })
  const [mine] = await Promise.all([buyer.contact(beacon), seller.waitForContact()])
  await Promise.all([
    buyer.negotiate(mine.session, { side: 'pay', currency: 'NOK', limit: 4000, target: 2800 }),
    seller.negotiate(mine.session, { side: 'receive', currency: 'NOK', limit: 3200, target: 4400 }),
  ])
  const { quote } = buyer.quotes.get(mine.session)!
  assert.equal(quote.parties.find((p) => p.did === buyer.did)!.approver, owner.did)
  await seller.commit(mine.session)

  // The agent cannot stand in for the passkey, with its own key or by any other means it has.
  await assert.rejects(buyer.commit(mine.session), /owner's approval/)
  await assert.rejects(commitQuote(room.url, quote, approveQuote(buyer.identity, quote, buyer.did)), /not signed by the key/)

  // What the approval page does: build the request, have the phone sign its challenge, hand the result to the agent.
  const request = approvalRequest(quote, buyer.did, owner.did)
  const approval = assertion(owner.privateKey, request)
  const done = await buyer.commit(mine.session, approval)
  assert.equal(done.state, 'agreed')
  assert.equal(checkReceipt(done.receipt!), null)
  assert.ok(done.receipt!.approvals.some((a) => a.by === owner.did && a.webauthn && !a.sig))

  // The room refuses every bent version of a passkey approval, and so does anyone checking later.
  const other = passkey()
  const bent: [string, Approval, RegExp][] = [
    ['signed by another passkey', { ...assertion(other.privateKey, request) }, /bad signature/],
    ['the time changed after signing', { ...approval, at: new Date(Date.now() + 1000).toISOString() }, /signed something else/],
    ['a challenge for another quote', assertion(owner.privateKey, request, { challenge: passkeyChallenge({ ...request, quote: 'another-quote-id' }) }), /signed something else/],
    ['a registration, not an assertion', assertion(owner.privateKey, request, { type: 'webauthn.create' }), /not a passkey assertion/],
    ['tapped but not verified (no biometric or PIN)', assertion(owner.privateKey, request, { flags: 0x01 }), /did not verify its user/],
    ['authenticator data altered', { ...approval, webauthn: { ...approval.webauthn!, authenticatorData: b64u(Buffer.concat([sha256('evil.example'), Buffer.from([0x05, 0, 0, 0, 7])])) } }, /bad signature/],
    ['an Ed25519 signature in a passkey\'s name', { ...request, sig: approveQuote(buyer.identity, quote, buyer.did).sig }, /webauthn assertion/],
    ['both kinds of signature', { ...approval, sig: 'AAAA' }, /webauthn assertion/],
  ]
  for (const [what, a, why] of bent) assert.match(checkApproval(a, quote) ?? 'accepted', why, what)
  assert.match(checkReceipt({ ...done.receipt!, approvals: [bent[4][1], done.receipt!.approvals.find((a) => a.by !== owner.did)!] })!, /did not verify its user/)

  buyer.close()
  seller.close()
  await room.close()
  await relay.close()
})
