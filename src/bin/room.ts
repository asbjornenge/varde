import { join } from 'node:path'
import { config } from '../config.js'
import { loadOrCreateIdentity } from '../core/identity.js'
import { startRoom } from '../room/server.js'

const c = config()
// The room keeps one key, because its signature on receipts is its reputation.
const identity = loadOrCreateIdentity(join(c.home, 'room-identity.json'))
const room = await startRoom({ identity, port: c.roomPort, host: c.host, dataFile: c.roomData ?? join(c.home, 'room-quotes.json') })
console.log(`varde room listening on ${room.url}\nroom key ${room.did}`)
