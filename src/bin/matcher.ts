import { config } from '../config.js'
import { embedderFromEnv } from '../matcher/embed.js'
import { startMatcher } from '../matcher/server.js'

const c = config()
const embedder = embedderFromEnv()
const svc = await startMatcher({ relayUrl: c.relayUrl, port: c.matcherPort, host: c.host, embedder })
console.log(`varde matcher listening on ${svc.url}\nreading ${c.relayUrl}, embedder ${embedder.name}`)
