import assert from 'node:assert/strict'
import { test } from 'node:test'
import WebSocket, { WebSocketServer } from 'ws'
import { Agent } from '../src/agent.js'
import { beaconId, lightBeacon } from '../src/core/beacon.js'
import { nonce } from '../src/core/bytes.js'
import { type Identity, createIdentity, signObject } from '../src/core/identity.js'
import { openMail, sealMail } from '../src/core/mail.js'
import { type Quote, type QuoteBody, approveQuote, checkReceipt, issueReceipt, signQuote } from '../src/core/receipt.js'
import { type Negotiator, concede } from '../src/negotiator.js'
import { RelayClient } from '../src/relay/client.js'
import { startRelay } from '../src/relay/server.js'
import { enterRoom } from '../src/room/client.js'
import { ROOM_JOIN_CONTEXT, startRoom } from '../src/room/server.js'

const beaconFor = (id: Identity) =>
  lightBeacon(id, {
    what: 'iPad Air',
    expires: new Date(Date.now() + 60_000).toISOString(),
    reachMe: [{ kind: 'mailbox', relay: 'ws://relay.example', encKey: id.encPub }],
  })

/**
 * A room that lies. It plays the other party itself: lets the seller offer
 * 3500, pretends the buyer accepted, then applies `cheat` to the quote.
 */
async function dishonestRoom(cheat: (honest: QuoteBody, room: Identity, send: (m: object) => void, sellerSig: () => Promise<string>) => void | Promise<void>) {
  const identity = createIdentity()
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise((r) => wss.once('listening', r))
  wss.on('connection', (ws) => {
    const send = (m: object) => ws.send(JSON.stringify(m))
    let join: any
    let gotSig!: (s: string) => void
    const sig = new Promise<string>((r) => (gotSig = r))
    send({ t: 'challenge', nonce: 'n', room: identity.did })
    ws.on('message', async (data) => {
      const m = JSON.parse(data.toString())
      if (m.t === 'join') {
        join = m
        send({ t: 'joined', session: m.session, room: identity.did })
        send({ t: 'start', session: m.session, room: identity.did, first: m.did, maxTurns: 10, currency: 'NOK' })
      } else if (m.t === 'move') {
        send({ t: 'move', from: join.did, kind: 'offer', price: m.move.price, turn: 1, remaining: 9 })
        send({ t: 'move', from: join.peer, kind: 'accept', price: m.move.price, turn: 2, remaining: 8 })
        const honest: QuoteBody = {
          v: 1, kind: 'varde.quote', room: identity.did, session: join.session,
          parties: [
            { did: join.did, side: 'receive', approver: join.mandate.owner ?? join.did },
            { did: join.peer, side: 'pay', approver: join.peer },
          ],
          terms: { price: m.move.price, currency: 'NOK' }, turns: 2,
          at: new Date().toISOString(), validUntil: new Date(Date.now() + 60_000).toISOString(),
        }
        await cheat(honest, identity, send, () => sig)
      } else if (m.t === 'signed') gotSig(m.sig)
    })
  })
  const port = (wss.address() as { port: number }).port
  return { url: `ws://127.0.0.1:${port}`, close: () => { for (const c of wss.clients) c.terminate(); wss.close() } }
}

const sellInto = (roomUrl: string, peer = createIdentity().did, owner?: string) => {
  const seller = createIdentity()
  return enterRoom({
    roomUrl, identity: seller, session: nonce(24), peer, beacon: beaconFor(seller),
    mandate: { side: 'receive', currency: 'NOK', limit: 3200, owner }, negotiator: () => ({ kind: 'offer', price: 3500 }), timeoutMs: 2000,
  })
}
const reasonOf = (o: Awaited<ReturnType<typeof sellInto>>) => (o.outcome === 'ended' ? o.reason : o.outcome)

test('a party refuses to sign a quote whose price is not the one agreed', async () => {
  const room = await dishonestRoom((honest, _id, send) => send({ t: 'sign', quote: { ...honest, terms: { price: 3300, currency: 'NOK' } } }))
  assert.equal(reasonOf(await sellInto(room.url)), 'quote-did-not-match')
  room.close()
})

test('a party refuses a quote that names another room, session, counterpart, side or currency, or has already lapsed', async () => {
  for (const edit of [
    (h: QuoteBody) => ({ ...h, room: createIdentity().did }),
    (h: QuoteBody) => ({ ...h, session: 'some-other-session-id' }),
    (h: QuoteBody) => ({ ...h, parties: [h.parties[0], { ...h.parties[1], did: createIdentity().did }] }),
    (h: QuoteBody) => ({ ...h, parties: [{ ...h.parties[0], side: 'pay' }, h.parties[1]] }),
    (h: QuoteBody) => ({ ...h, terms: { price: h.terms.price, currency: 'EUR' } }),
    (h: QuoteBody) => ({ ...h, validUntil: new Date(Date.now() - 1000).toISOString() }),
  ]) {
    const room = await dishonestRoom((honest, _id, send) => send({ t: 'sign', quote: edit(honest) }))
    assert.equal(reasonOf(await sellInto(room.url)), 'quote-did-not-match')
    room.close()
  }
})

test('a party refuses a quote in which the room has swapped its approver', async () => {
  const owner = createIdentity()
  // The mandate names an owner. The room tries to let the agent approve by itself, then to name a stranger.
  for (const approver of ['self', createIdentity().did]) {
    const room = await dishonestRoom((honest, _id, send) =>
      send({ t: 'sign', quote: { ...honest, parties: [{ ...honest.parties[0], approver: approver === 'self' ? honest.parties[0].did : approver }, honest.parties[1]] } }),
    )
    assert.equal(reasonOf(await sellInto(room.url, undefined, owner.did)), 'quote-did-not-match')
    room.close()
  }
  // With the owner named correctly, the same party signs.
  const honestRoom = await dishonestRoom(async (honest, id, send, sellerSig) => {
    send({ t: 'sign', quote: honest })
    await sellerSig()
    send({ t: 'end', reason: 'done' })
    void id
  })
  assert.equal(reasonOf(await sellInto(honestRoom.url, undefined, owner.did)), 'done')
  honestRoom.close()
})

test('a party rejects a final quote with a forged signature or a body changed after signing', async () => {
  const buyer = createIdentity()
  // The room and the seller sign, but the buyer's signature is forged by the room.
  let room = await dishonestRoom(async (honest, id, send, sellerSig) => {
    send({ t: 'sign', quote: honest })
    const sigs = { [id.did]: signQuote(id, honest), [honest.parties[0].did]: await sellerSig(), [buyer.did]: signQuote(id, honest) }
    send({ t: 'quote', quote: { ...honest, sigs } })
  })
  assert.equal(reasonOf(await sellInto(room.url, buyer.did)), 'quote-invalid')
  room.close()

  // The body is changed after the seller signed, so its signature no longer covers it.
  room = await dishonestRoom(async (honest, id, send, sellerSig) => {
    send({ t: 'sign', quote: honest })
    const other = { ...honest, turns: 99 }
    send({ t: 'quote', quote: { ...other, sigs: { [id.did]: signQuote(id, other), [buyer.did]: signQuote(buyer, other), [honest.parties[0].did]: await sellerSig() } } })
  })
  assert.equal(reasonOf(await sellInto(room.url, buyer.did)), 'quote-invalid')
  room.close()
})

test('a room cannot forge a receipt: it would need the approvers\' signatures', () => {
  const [room, a, b, owner, mallory] = [createIdentity(), createIdentity(), createIdentity(), createIdentity(), createIdentity()]
  const body: QuoteBody = {
    v: 1, kind: 'varde.quote', room: room.did, session: nonce(24),
    parties: [{ did: a.did, side: 'pay', approver: owner.did }, { did: b.did, side: 'receive', approver: b.did }],
    terms: { price: 3500, currency: 'NOK' }, turns: 4, at: new Date().toISOString(), validUntil: new Date(Date.now() + 60_000).toISOString(),
  }
  const quote: Quote = { ...body, sigs: { [room.did]: signQuote(room, body), [a.did]: signQuote(a, body), [b.did]: signQuote(b, body) } }
  const yesB = approveQuote(b, quote, b.did)
  assert.equal(checkReceipt(issueReceipt(room, quote, [approveQuote(owner, quote, a.did), yesB])), null)

  // The agent approves where the owner is required; the room approves for the owner; a stranger does.
  for (const signer of [a, room, mallory])
    assert.match(checkReceipt(issueReceipt(room, quote, [approveQuote(signer, quote, a.did), yesB]))!, /not signed by the key this quote requires/)
  // One party's approval used twice.
  assert.match(checkReceipt(issueReceipt(room, quote, [yesB, yesB]))!, /each party/)
  // An approval of a different quote, replayed here.
  const cheaper: QuoteBody = { ...body, terms: { price: 9000, currency: 'NOK' } }
  assert.match(checkReceipt(issueReceipt(room, quote, [approveQuote(owner, cheaper, a.did), yesB]))!, /another quote/)
  // A receipt dated after the quote lapsed.
  assert.match(checkReceipt(issueReceipt(room, quote, [approveQuote(owner, quote, a.did), yesB], Date.now() + 120_000))!, /lapsed/)
  // A receipt signed by someone other than the room named in the quote.
  assert.match(checkReceipt(issueReceipt(mallory, quote, [approveQuote(owner, quote, a.did), yesB]))!, /room/)
})

async function pairIn(roomUrl: string, buyerNegotiator: Negotiator, sellerNegotiator: Negotiator) {
  const buyer = createIdentity()
  const seller = createIdentity()
  const session = nonce(24)
  return Promise.all([
    enterRoom({ roomUrl, identity: buyer, session, peer: seller.did, beacon: beaconFor(buyer), mandate: { side: 'pay', currency: 'NOK', limit: 4000 }, negotiator: buyerNegotiator, showNotes: true, commit: true }),
    enterRoom({ roomUrl, identity: seller, session, peer: buyer.did, beacon: beaconFor(seller), mandate: { side: 'receive', currency: 'NOK', limit: 3200 }, negotiator: sellerNegotiator }),
  ])
}

test('the byte limit ends a session in which one side floods the other with text', async () => {
  const room = await startRoom({ identity: createIdentity(), maxTurns: 1000, maxBytesPerParty: 1500 })
  const flood: Negotiator = () => ({ kind: 'offer', price: 3900, note: 'x'.repeat(280) })
  const [b, s] = await pairIn(room.url, () => ({ kind: 'offer', price: 3300 }), flood)
  assert.deepEqual([b.outcome, (b as any).reason, (s as any).reason], ['ended', 'byte-limit', 'byte-limit'])
  // The buyer was shown at most a handful of notes before the room cut it off.
  assert.ok(b.history.filter((h) => h.untrustedNote).length <= 5)
  await room.close()
})

test('a session waits for its parties, but not for ever', async () => {
  const room = await startRoom({ identity: createIdentity(), sessionTtlMs: 300 })
  // One party never moves. Nothing ends because someone is slow or away; the session ends when its time is up.
  const silent: Negotiator = () => new Promise(() => {})
  const [b, s] = await pairIn(room.url, silent, () => ({ kind: 'offer', price: 3900 }))
  assert.deepEqual([(b as any).reason, (s as any).reason], ['expired', 'expired'])

  // A party that waits alone is told the same when the time runs out.
  const alone = createIdentity()
  const outcome = await enterRoom({
    roomUrl: room.url, identity: alone, session: nonce(24), peer: createIdentity().did, beacon: beaconFor(alone),
    mandate: { side: 'pay', currency: 'NOK', limit: 1 }, negotiator: silent,
  })
  assert.equal((outcome as any).reason, 'expired')
  await room.close()
})

test('a captured join cannot be replayed on another connection', async () => {
  const room = await startRoom({ identity: createIdentity() })
  const me = createIdentity()
  const open = () =>
    new Promise<{ ws: WebSocket; challenge: string; next: () => Promise<any> }>((resolve) => {
      const ws = new WebSocket(room.url)
      const inbox: any[] = []
      let waiting: ((m: any) => void) | undefined
      const next = () => new Promise<any>((r) => (inbox.length ? r(inbox.shift()) : (waiting = r)))
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString())
        if (m.t === 'challenge') return resolve({ ws, challenge: m.nonce, next })
        if (waiting) { const w = waiting; waiting = undefined; w(m) } else inbox.push(m)
      })
    })
  const first = await open()
  const join = signObject(me, ROOM_JOIN_CONTEXT, {
    t: 'join', session: nonce(24), did: me.did, peer: createIdentity().did, nonce: first.challenge,
    beacon: beaconFor(me), mandate: { side: 'pay', currency: 'NOK', limit: 4000 },
  })
  first.ws.send(JSON.stringify(join))
  assert.equal((await first.next()).t, 'joined')
  first.ws.close()

  const second = await open()
  second.ws.send(JSON.stringify(join))
  assert.deepEqual(await second.next(), { t: 'refused', reason: 'stale challenge' })

  // Nor can the mandate inside a signed join be swapped for a looser one.
  const third = await open()
  const fresh = signObject(me, ROOM_JOIN_CONTEXT, { ...join, nonce: third.challenge })
  third.ws.send(JSON.stringify({ ...fresh, mandate: { side: 'pay', currency: 'NOK', limit: 9000 } }))
  assert.deepEqual(await third.next(), { t: 'refused', reason: 'bad signature' })
  second.ws.close()
  third.ws.close()
  await room.close()
})

test('a replayed hello is answered once, and a stale one not at all', async () => {
  const relay = await startRelay()
  const lighter = await Agent.start({ identity: createIdentity(), relayUrl: relay.url })
  const { beacon } = await lighter.light({ what: 'Selling a canoe', intent: 'offer' })

  const mallory = createIdentity()
  const c = await RelayClient.connect(relay.url, mallory)
  const welcomes: string[] = []
  await c.onMail((m) => welcomes.push(openMail(mallory, m.sealed)?.type ?? '?'))
  const body = { answering: beaconId(beacon), replyTo: { relay: relay.url, encKey: mallory.encPub }, nonce: 'n', supports: { protocols: [], rooms: [], trust: [] } }

  const hello = sealMail(mallory, lighter.did, lighter.identity.encPub, 'varde.hello', body)
  for (let i = 0; i < 3; i++) await c.sendMail(lighter.did, hello.sealed)
  const old = sealMail(mallory, lighter.did, lighter.identity.encPub, 'varde.hello', body, Date.now() - 60 * 60_000)
  await c.sendMail(lighter.did, old.sealed)
  await new Promise((r) => setTimeout(r, 250))
  assert.deepEqual(welcomes, ['varde.welcome'])

  // Mallory never confirms, so no contact exists on the lighter's side.
  assert.equal(lighter.contacts.size, 0)
  c.close()
  lighter.close()
  await relay.close()
})

test('a scripted negotiator never offers past its limit, whatever the other side does', () => {
  for (const side of ['pay', 'receive'] as const) {
    const limit = 3000
    const play = concede({ target: side === 'pay' ? 2000 : 4000 })
    let mine: number | undefined
    for (let remaining = 12; remaining >= 1; remaining--) {
      const theirOffer = side === 'pay' ? 9000 : 10
      const move = play({ side, currency: 'NOK', limit, history: [], theirOffer, myLastOffer: mine, remaining }) as { kind: string; price?: number }
      assert.notEqual(move.kind, 'accept')
      if (move.price !== undefined) {
        assert.ok(side === 'pay' ? move.price <= limit : move.price >= limit)
        mine = move.price
      }
    }
  }
})
