import { homedir } from 'node:os'
import { join } from 'node:path'

/** Defaults shared by the command-line entry points. All can be set by environment. */
export const config = (env: NodeJS.ProcessEnv = process.env) => ({
  home: env.VARDE_HOME ?? join(homedir(), '.varde'),
  relayUrl: env.VARDE_RELAY ?? 'ws://127.0.0.1:7447',
  /** DID of the owner's key. The private half lives in `ownerHome`, which agents never read. */
  owner: env.VARDE_OWNER,
  autoCommit: env.VARDE_AUTO_COMMIT ? Number(env.VARDE_AUTO_COMMIT) : undefined,
  ownerHome: env.VARDE_OWNER_HOME ?? join(homedir(), '.varde-owner'),
  roomData: env.VARDE_ROOM_DATA,
  listenRelays: (env.VARDE_LISTEN_RELAYS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  rooms: (env.VARDE_ROOMS ?? 'ws://127.0.0.1:7448').split(',').map((s) => s.trim()).filter(Boolean),
  relayData: env.VARDE_RELAY_DATA,
  relayPowBits: Number(env.VARDE_RELAY_POW_BITS ?? 0),
  relayPublishesPerMinute: env.VARDE_RELAY_PUBLISHES_PER_MINUTE ? Number(env.VARDE_RELAY_PUBLISHES_PER_MINUTE) : undefined,
  relayTrustedPass: env.VARDE_RELAY_TRUSTED_PASS || undefined,
  relayTrustProxy: env.VARDE_RELAY_TRUST_PROXY === '1',
  host: env.VARDE_HOST ?? '127.0.0.1',
  relayPort: Number(env.VARDE_RELAY_PORT ?? 7447),
  roomPort: Number(env.VARDE_ROOM_PORT ?? 7448),
  matcherPort: Number(env.VARDE_MATCHER_PORT ?? 7449),
})
