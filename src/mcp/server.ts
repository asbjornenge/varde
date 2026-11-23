/**
 * Varde as tools any agent can call. Start it over stdio from an MCP client:
 *
 *   npx tsx src/mcp/server.ts
 *
 * The identity and the agent's beacons, contacts and receipts live in
 * VARDE_HOME (default ~/.varde). No signup: the key is created on first use.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Agent, fileStore } from '../agent.js'
import { config } from '../config.js'
import { loadOrCreateIdentity } from '../core/identity.js'
import { type Approval, quoteId } from '../core/receipt.js'
import { embedderFromEnv } from '../matcher/embed.js'
import { registerVardeTools } from './tools.js'

const c = config()
let agent: Promise<Agent> | undefined

/** Connects on first use, so the server starts even when the relay is down. */
function getAgent(): Promise<Agent> {
  agent ??= Agent.start({
    identity: loadOrCreateIdentity(join(c.home, 'identity.json')),
    relayUrl: c.relayUrl,
    rooms: c.rooms,
    listenRelays: c.listenRelays,
    owner: c.owner,
    autoCommit: c.autoCommit,
    embedder: embedderFromEnv(),
    store: fileStore(join(c.home, 'state.json')),
  }).catch((e) => {
    agent = undefined
    throw new Error(`cannot reach relay ${c.relayUrl}: ${(e as Error).message}`)
  })
  return agent
}

const server = new McpServer({ name: 'varde', version: '0.1.0' })
registerVardeTools(server, {
  agent: getAgent,
  // The owner's command-line tool leaves a signed approval here for the agent to deliver.
  approvalFor: (quote) => {
    const file = join(c.home, 'approvals', `${quoteId(quote)}.json`)
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Approval) : undefined
  },
})

await server.connect(new StdioServerTransport())
