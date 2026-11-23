import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { type Beacon, beaconId, checkBeacon } from '../src/core/beacon.js'
import { canonicalize } from '../src/core/canonical.js'
import { createPublicKey } from 'node:crypto'
import { type Identity, didFromP256, sign, signObject } from '../src/core/identity.js'
import { type Approval, type ApprovalRequest, type Quote, type Receipt, type Withdrawal, approveQuote, checkApproval, checkQuote, checkReceipt, checkWithdrawal, issueReceipt, passkeyChallenge, quoteBody, quoteId, signQuote, withdrawQuote } from '../src/core/receipt.js'

// Fixed keys and expected outputs. Another implementation can use the same
// file to prove it signs the same bytes.
const v = JSON.parse(readFileSync(new URL('../spec/vectors/v1.json', import.meta.url), 'utf8')) as {
  identities: Record<string, Identity>
  canonical: { value: unknown; json: string }[]
  signingInput: { context: string; object: object; bytesUtf8: string; signer: string; sig: string }
  beacons: { id: string; beacon: Beacon }[]
  quote: { id: string; quote: Quote }
  approvals: [Approval, Approval]
  withdrawal: Withdrawal
  receipt: Receipt
  passkey: { publicKeyJwk: object; did: string; quote: { id: string; quote: Quote }; request: ApprovalRequest; challenge: string; approval: Approval }
}

test('vectors: canonical JSON', () => {
  for (const c of v.canonical) assert.equal(canonicalize(c.value), c.json)
})

test('vectors: the signed bytes and the signature are reproduced exactly', () => {
  const s = v.signingInput
  assert.equal(`varde/${s.context}/v1\n${canonicalize(s.object)}`, s.bytesUtf8)
  assert.equal(sign(v.identities[s.signer], s.context, s.object), s.sig)
})

test('vectors: beacons verify, and re-signing gives the same id and signature', () => {
  const owners = Object.values(v.identities)
  for (const { id, beacon } of v.beacons) {
    assert.equal(checkBeacon(beacon), null)
    assert.equal(beaconId(beacon), id)
    const owner = owners.find((o) => o.did === beacon.who)!
    assert.equal(signObject(owner, 'beacon', beacon).sig, beacon.sig)
  }
})

test('vectors: the quote, its approvals, the withdrawal and the receipt verify and are reproduced exactly', () => {
  const { alice, bob, room, owner } = v.identities
  const { id, quote } = v.quote
  assert.equal(checkQuote(quote), null)
  assert.equal(quoteId(quote), id)
  for (const signer of [alice, bob, room]) assert.equal(signQuote(signer, quoteBody(quote)), quote.sigs[signer.did])

  // The paying side's approval is signed by its owner, not by the agent.
  assert.deepEqual(v.approvals.map((a) => a.by), [owner.did, bob.did])
  for (const [i, signer] of [owner, bob].entries()) {
    const a = v.approvals[i]
    assert.equal(checkApproval(a, quote), null)
    assert.deepEqual(approveQuote(signer, quote, a.party, Date.parse(a.at)), a)
  }
  assert.equal(checkWithdrawal(v.withdrawal, quote), null)
  assert.deepEqual(withdrawQuote(alice, quote, Date.parse(v.withdrawal.at)), v.withdrawal)

  assert.equal(checkReceipt(v.receipt), null)
  assert.deepEqual(issueReceipt(room, quote, v.approvals, Date.parse(v.receipt.at)), v.receipt)
})

test('vectors: a passkey approval is accepted, and its DID and challenge are reproduced exactly', () => {
  const p = v.passkey
  assert.equal(didFromP256(createPublicKey({ key: p.publicKeyJwk as never, format: 'jwk' })), p.did)
  assert.equal(checkQuote(p.quote.quote), null)
  assert.equal(quoteId(p.quote.quote), p.quote.id)
  assert.equal(passkeyChallenge(p.request), p.challenge)
  assert.equal(checkApproval(p.approval, p.quote.quote), null)
  // The same assertion does not approve the other quote in this file.
  assert.match(checkApproval(p.approval, v.quote.quote)!, /another quote/)
})
