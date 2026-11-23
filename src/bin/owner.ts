/**
 * The owner's side: the person an agent acts for.
 *
 *   npm run owner                      show the owner's DID (creates the key on first use)
 *   npm run owner -- quotes            list the agent's open quotes
 *   npm run owner -- approve <id>      approve one, by session id or quote id
 *
 * The owner's key lives in VARDE_OWNER_HOME (default ~/.varde-owner), which
 * the agent never reads. Approving writes a signed approval into the agent's
 * VARDE_HOME; the agent delivers it to the room with its `commit` tool.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentState } from '../agent.js'
import { config } from '../config.js'
import { loadOrCreateIdentity } from '../core/identity.js'
import { approveQuote, checkQuote, quoteId } from '../core/receipt.js'

const c = config()
const owner = loadOrCreateIdentity(join(c.ownerHome, 'identity.json'))
const [command, target] = process.argv.slice(2)

const stateFile = join(c.home, 'state.json')
const state = existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, 'utf8')) as AgentState) : undefined
const agentFile = join(c.home, 'identity.json')
const agentDid = existsSync(agentFile) ? (JSON.parse(readFileSync(agentFile, 'utf8')) as { did: string }).did : undefined
const open = (state?.quotes ?? []).filter((q) => q.state === 'quoted' && Date.parse(q.quote.validUntil) > Date.now())

if (!command) {
  console.log(`owner key: ${owner.did}`)
  console.log(`give it to your agent as VARDE_OWNER=${owner.did}`)
} else if (command === 'quotes') {
  if (!open.length) console.log('no open quotes')
  for (const q of open) {
    const mine = q.quote.parties.find((p) => p.did === agentDid)
    const t = q.quote.terms
    console.log(`${q.quote.session}`)
    console.log(`  ${mine?.side === 'pay' ? 'pay' : 'receive'} ${t.price} ${t.currency}${t.conditions ? ' ' + JSON.stringify(t.conditions) : ''}`)
    console.log(`  stands until ${q.quote.validUntil}; ${mine?.approver === owner.did ? 'needs your approval' : 'does not need your approval'}`)
  }
} else if (command === 'approve' && target) {
  const q = open.find((x) => x.quote.session === target || quoteId(x.quote) === target)
  if (!q) throw new Error(`no open quote with id ${target}`)
  // Check the quote before signing anything: it must carry all three signatures.
  const problem = checkQuote(q.quote)
  if (problem) throw new Error(`refusing to approve: the quote is not valid (${problem})`)
  const mine = q.quote.parties.find((p) => p.did === agentDid)
  if (!mine) throw new Error('refusing to approve: your agent is not a party to that quote')
  if (mine.approver !== owner.did) throw new Error('that quote does not name this owner key as approver')
  const approval = approveQuote(owner, q.quote, mine.did)
  const dir = join(c.home, 'approvals')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${quoteId(q.quote)}.json`), JSON.stringify(approval, null, 2))
  console.log(`approved: ${mine.side === 'pay' ? 'pay' : 'receive'} ${q.quote.terms.price} ${q.quote.terms.currency}`)
  console.log('your agent can now commit to it')
} else {
  console.error('usage: owner [quotes | approve <session or quote id>]')
  process.exitCode = 1
}
