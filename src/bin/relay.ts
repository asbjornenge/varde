import { config } from '../config.js'
import { startRelay } from '../relay/server.js'

const c = config()
const relay = await startRelay({ port: c.relayPort, host: c.host, dataFile: c.relayData, minPowBits: c.relayPowBits, publishesPerMinute: c.relayPublishesPerMinute, mailPerMinute: c.relayPublishesPerMinute, trustProxy: c.relayTrustProxy })
console.log(`varde relay listening on ${relay.url}${c.relayData ? `, keeping state in ${c.relayData}` : ', in memory only (set VARDE_RELAY_DATA to keep state)'}`)
