import { createHash, randomBytes } from 'node:crypto'

export const b64u = (b: Uint8Array | ArrayBuffer): string =>
  Buffer.from(b as ArrayBuffer).toString('base64url')

export const unb64u = (s: string): Buffer => Buffer.from(s, 'base64url')

export const sha256 = (d: string | Uint8Array): Buffer =>
  createHash('sha256').update(d).digest()

/** A fresh random nonce, base64url encoded. */
export const nonce = (bytes = 16): string => b64u(randomBytes(bytes))

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function base58encode(bytes: Uint8Array): string {
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  let out = ''
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out
    n /= 58n
  }
  for (const b of bytes) {
    if (b !== 0) break
    out = '1' + out
  }
  return out
}

export function base58decode(s: string): Buffer {
  let n = 0n
  for (const c of s) {
    const i = B58.indexOf(c)
    if (i < 0) throw new Error('invalid base58 character')
    n = n * 58n + BigInt(i)
  }
  const out: number[] = []
  while (n > 0n) {
    out.unshift(Number(n & 0xffn))
    n >>= 8n
  }
  for (const c of s) {
    if (c !== '1') break
    out.unshift(0)
  }
  return Buffer.from(out)
}
