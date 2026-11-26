import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type Mandate, type Move, Negotiation } from '../src/room/negotiation.js'

// A small seeded generator, so a failure can be replayed from its seed.
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const junk: unknown[] = [undefined, null, NaN, Infinity, -1, 0, '3500', 1e13, 12.345, {}, [], true]

test('whatever two parties send, no deal is ever struck outside either mandate or past the turn limit', () => {
  let agreed = 0
  let refused = 0
  for (let seed = 1; seed <= 3000; seed++) {
    const r = rng(seed)
    const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1))
    const pay: Mandate = { side: 'pay', currency: 'NOK', limit: int(1, 60) * 100 }
    const recv: Mandate = { side: 'receive', currency: 'nok', limit: int(1, 60) * 100 }
    if (r() < 0.3) pay.maxTurns = int(1, 8)
    const roomMax = int(1, 20)
    const n = new Negotiation({ did: 'P', mandate: pay }, { did: 'R', mandate: recv }, roomMax)
    const cap = Math.min(roomMax, pay.maxTurns ?? Infinity)
    assert.equal(n.maxTurns, cap)

    let attempts = 0
    while (n.status === 'open' && attempts < 200) {
      attempts++
      // Mostly the right party moves; sometimes the wrong one, or a stranger.
      // Before the first offer either party may move.
      const turn: string = (n as any).toMove ?? (r() < 0.5 ? 'P' : 'R')
      const who = r() < 0.8 ? turn : r() < 0.9 ? (turn === 'P' ? 'R' : 'P') : 'X'
      const k = r()
      const kind = k < 0.4 ? 'offer' : k < 0.65 ? 'counter' : k < 0.9 ? 'accept' : k < 0.95 ? 'reject' : 'steal'
      const price = r() < 0.9 ? int(1, 70) * 100 : junk[int(0, junk.length - 1)]
      const move = (r() < 0.03 ? junk[int(0, junk.length - 1)] : { kind, price, note: r() < 0.1 ? 'x'.repeat(int(0, 400)) : undefined }) as Move
      const before = n.turns
      const result = n.move(who, move)
      if (!result.ok) refused++
      // A stranger costs the parties nothing; everyone else pays one turn per attempt.
      assert.equal(n.turns, before + (who === 'X' ? 0 : 1), `seed ${seed}`)
      assert.ok(n.turns <= cap, `seed ${seed}: ${n.turns} turns with a cap of ${cap}`)
      if (result.ok && result.event.price !== undefined) {
        const m = who === 'P' ? pay : recv
        assert.ok(who === 'P' ? result.event.price <= m.limit : result.event.price >= m.limit, `seed ${seed}: move outside own mandate got through`)
      }
    }
    assert.notEqual(n.status, 'open', `seed ${seed}: session never ended`)
    if (n.status === 'agreed') {
      agreed++
      const p = n.agreedPrice!
      assert.ok(p <= pay.limit && p >= recv.limit, `seed ${seed}: agreed ${p} outside ${recv.limit}..${pay.limit}`)
      assert.ok(pay.limit >= recv.limit, `seed ${seed}: a deal although the limits do not overlap`)
    }
    assert.equal(n.move('P', { kind: 'offer', price: 100 }).ok, false)
  }
  // The generator must actually reach both outcomes, or the test proves nothing.
  assert.ok(agreed > 100, `only ${agreed} deals`)
  assert.ok(refused > 1000, `only ${refused} refusals`)
})
