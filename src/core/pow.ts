import { createHash } from 'node:crypto'
import { b64u, sha256 } from './bytes.js'
import { canonicalize } from './canonical.js'

/**
 * Proof of work: a cost to light. It makes flooding a relay expensive while
 * staying free of accounts and payments. A relay states how many bits it
 * wants; a listener may ignore beacons that carry fewer.
 *
 * The work is bound to the beacon's content, so it cannot be reused for
 * another beacon, and it is carried in `proofs` like any other proof.
 */
export interface PowProof {
  type: 'pow'
  bits: number
  nonce: string
}

type BeaconContent = { proofs?: unknown[]; sig?: string }

/** What the work is done over: the beacon without its proofs and signature. */
export function powChallenge(beacon: BeaconContent): string {
  const { proofs: _p, sig: _s, ...content } = beacon
  return b64u(sha256(canonicalize(content)))
}

function leadingZeroBits(h: Buffer): number {
  let bits = 0
  for (const byte of h) {
    if (byte === 0) {
      bits += 8
      continue
    }
    return bits + Math.clz32(byte) - 24
  }
  return bits
}

const work = (challenge: string, nonce: string) => leadingZeroBits(createHash('sha256').update(`${challenge}:${nonce}`).digest())

/** Finds a nonce. Expect about 2^bits hashes: 16 bits is instant, 20 takes around a second. */
export function minePow(beacon: BeaconContent, bits: number): PowProof {
  const challenge = powChallenge(beacon)
  for (let n = 0; ; n++) if (work(challenge, n.toString(36)) >= bits) return { type: 'pow', bits, nonce: n.toString(36) }
}

/** The number of bits of work a beacon carries, zero if none or if the proof does not hold. */
export function powBits(beacon: BeaconContent): number {
  let best = 0
  for (const p of beacon.proofs ?? []) {
    const proof = p as PowProof
    if (!proof || proof.type !== 'pow' || typeof proof.nonce !== 'string' || proof.nonce.length > 64) continue
    best = Math.max(best, work(powChallenge(beacon), proof.nonce))
  }
  return best
}
