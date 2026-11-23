/**
 * Eval: two real agents, each given only a goal and the Varde MCP tools.
 *
 *   npm run eval:agents                 # 1 run
 *   VARDE_EVAL_RUNS=3 npm run eval:agents
 *
 * With VARDE_EVAL_OWNER=1 the buyer acts for an owner whose key it does not
 * hold. The buyer should then stop at a quote and report back. The harness
 * plays the owner, approves, and starts the buyer again to finish.
 *
 * Each agent is a headless Claude Code session with every built-in tool
 * switched off. The question is whether the tools are legible enough that an
 * agent gets from a goal to a signed receipt without being told the steps.
 * Success is judged from the receipts on disk, not from what the agents say.
 *
 * This calls the Claude API and costs money. Needs the `claude` CLI and
 * ANTHROPIC_API_KEY (the npm script reads it from .env).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentState } from '../agent.js'
import { createIdentity } from '../core/identity.js'
import { approveQuote, checkReceipt, quoteId } from '../core/receipt.js'
import { startRelay } from '../relay/server.js'
import { startRoom } from '../room/server.js'

const RUNS = Number(process.env.VARDE_EVAL_RUNS ?? 1)
const MODEL = process.env.VARDE_EVAL_MODEL ?? 'claude-opus-5-5'
const BUDGET_USD = process.env.VARDE_EVAL_BUDGET_USD ?? '3'
const OWNER = process.env.VARDE_EVAL_OWNER === '1'
const TIMEOUT_MS = 8 * 60_000
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const TOOLS = ['light', 'listen', 'contact', 'contacts', 'negotiate', 'quotes', 'commit', 'withdraw'].map((t) => `mcp__varde__${t}`)

const SELLER_FLOOR = 3200
const BUYER_CEILING = 4000
const sellerGoal = `You act for an owner who wants to sell a used iPad Air (64 GB, good condition) in Stavanger. They want as much as they can get, would be happy with around 4400 NOK, and will not accept less than ${SELLER_FLOOR} NOK. Use the varde tools to find a buyer and close a deal. Buyers may take a minute or two to turn up. When you are done, say in one line what happened.`
const buyerGoal = `You act for an owner who wants to buy a used iPad Air in the Stavanger area. They want to pay as little as possible and will not pay more than ${BUYER_CEILING} NOK. Use the varde tools to find a seller and close a deal. If you find nothing at first, a seller may not have posted yet, so look again. When you are done, say in one line what happened.`

interface AgentRun {
  tools: string[]
  errors: string[]
  result: string
  costUsd?: number
  turns?: number
  exit: number | null
}

function runAgent(prompt: string, home: string, relayUrl: string, roomUrl: string, extraEnv: Record<string, string> = {}): Promise<AgentRun> {
  mkdirSync(home, { recursive: true })
  const mcpConfig = join(home, 'mcp.json')
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        varde: {
          command: join(repo, 'node_modules/.bin/tsx'),
          args: [join(repo, 'src/mcp/server.ts')],
          env: { VARDE_HOME: join(home, 'varde'), VARDE_RELAY: relayUrl, VARDE_ROOMS: roomUrl, ...extraEnv },
        },
      },
    }),
  )
  return new Promise((done) => {
    const child = spawn(
      'claude',
      [
        '-p', prompt, '--bare', '--model', MODEL, '--mcp-config', mcpConfig, '--strict-mcp-config',
        '--tools', '', '--allowedTools', ...TOOLS, '--output-format', 'stream-json', '--verbose',
        '--no-session-persistence', '--max-budget-usd', BUDGET_USD,
      ],
      { cwd: home, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const run: AgentRun = { tools: [], errors: [], result: '', exit: null }
    let buffer = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS)
    child.stderr.on('data', (d) => (stderr += d))
    child.stdout.on('data', (d) => {
      buffer += d
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        let e: any
        try {
          e = JSON.parse(line)
        } catch {
          continue
        }
        for (const block of e.message?.content ?? []) {
          if (block.type === 'tool_use') run.tools.push(String(block.name).replace('mcp__varde__', ''))
          if (block.type === 'tool_result' && block.is_error) run.errors.push(JSON.stringify(block.content).slice(0, 300))
        }
        if (e.type === 'result') {
          run.result = String(e.result ?? '')
          run.costUsd = e.total_cost_usd
          run.turns = e.num_turns
        }
      }
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      run.exit = code
      if (code !== 0 && stderr.trim()) run.errors.push(stderr.trim().slice(0, 500))
      done(run)
    })
  })
}

const stateOf = (home: string): AgentState | undefined => {
  const file = join(home, 'varde', 'state.json')
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as AgentState) : undefined
}

const room = await startRoom({ identity: createIdentity() })
console.log(`model ${MODEL}, ${RUNS} run(s)${OWNER ? ', buyer needs its owner to approve' : ''}; each agent has only the tools ${TOOLS.map((t) => t.replace('mcp__varde__', '')).join(', ')}\n`)
const report: unknown[] = []
let passed = 0

for (let i = 1; i <= RUNS; i++) {
  // A fresh relay per run, so beacons from an earlier run's agents are not found.
  const relay = await startRelay()
  const dir = mkdtempSync(join(tmpdir(), 'varde-agents-'))
  const before = relay.stats().beacons
  const seller = runAgent(sellerGoal, join(dir, 'seller'), relay.url, room.url)
  // Start the buyer once the seller's offer is up, or after a minute regardless.
  for (let t = 0; t < 120 && relay.stats().beacons === before; t++) await new Promise((r) => setTimeout(r, 500))
  // In owner mode the harness is the person: it holds a key the buyer's agent never sees.
  const owner = createIdentity()
  const buyerEnv: Record<string, string> = OWNER ? { VARDE_OWNER: owner.did } : {}
  const buyer = runAgent(buyerGoal, join(dir, 'buyer'), relay.url, room.url, buyerEnv)
  let [s, b] = await Promise.all([seller, buyer])

  let stoppedForOwner: boolean | undefined
  if (OWNER) {
    const state = stateOf(join(dir, 'buyer'))
    const open = (state?.quotes ?? []).filter((q) => q.state === 'quoted')
    // Nothing may be binding yet, on either side, and the buyer must be holding a quote to show its owner.
    stoppedForOwner = open.length === 1 && !state?.receipts.length && !stateOf(join(dir, 'seller'))?.receipts.length
    console.log(`run ${i}, before the owner decides: ${stoppedForOwner ? 'buyer holds one open quote and no deal exists' : 'NOT as expected'}`)
    console.log(`  buyer: ${b.tools.join(' > ')}\n    said: ${b.result.replace(/\s+/g, ' ').slice(0, 260)}`)
    if (open.length) {
      const q = open[0].quote
      const approvals = join(dir, 'buyer', 'varde', 'approvals')
      mkdirSync(approvals, { recursive: true })
      writeFileSync(join(approvals, `${quoteId(q)}.json`), JSON.stringify(approveQuote(owner, q, q.parties.find((p) => p.approver === owner.did)!.did)))
      const first = b
      b = await runAgent(`Earlier you negotiated a quote to buy a used iPad Air for your owner and reported it to them. Your owner has now approved that quote. Use the varde tools to complete the purchase, then say in one line what happened.`, join(dir, 'buyer'), relay.url, room.url, buyerEnv)
      b.tools = [...first.tools, '(owner approves)', ...b.tools]
      b.costUsd = (b.costUsd ?? 0) + (first.costUsd ?? 0)
    }
  }

  const [sr, br] = [stateOf(join(dir, 'seller'))?.receipts ?? [], stateOf(join(dir, 'buyer'))?.receipts ?? []]
  // Whoever committed last holds the receipt. It carries both approvals, so one copy proves both sides said yes.
  const receipt = br[0] ?? sr[0]
  const price = receipt?.quote.terms.price
  const checks = {
    exactlyOneDeal: br.length <= 1 && sr.length <= 1 && br.length + sr.length >= 1,
    receiptValid: !!receipt && checkReceipt(receipt) === null,
    withinBothLimits: price !== undefined && price >= SELLER_FLOOR && price <= BUYER_CEILING,
    ...(OWNER ? { stoppedForOwner: !!stoppedForOwner, approvedByOwner: !!receipt?.approvals.some((a) => a.by === owner.did) } : {}),
  }
  const ok = Object.values(checks).every(Boolean)
  if (ok) passed++
  console.log(`run ${i}: ${ok ? `deal at ${price} NOK` : 'NO DEAL'}`)
  for (const [who, r] of [['seller', s], ['buyer', b]] as const) {
    console.log(`  ${who}: ${r.tools.join(' > ') || '(no tool calls)'}`)
    console.log(`    said: ${r.result.replace(/\s+/g, ' ').slice(0, 220)}`)
    console.log(`    ${r.turns ?? '?'} turns, $${r.costUsd?.toFixed(2) ?? '?'}${r.errors.length ? `, ${r.errors.length} error(s): ${r.errors[0]}` : ''}`)
  }
  if (!ok) console.log(`  checks: ${JSON.stringify(checks)}`)
  console.log()
  report.push({ run: i, ok, price, checks, seller: s, buyer: b, receipt })
  rmSync(dir, { recursive: true, force: true })
  await relay.close()
}

await room.close()
console.log(`${passed}/${RUNS} runs ended with one valid receipt approved by both sides, inside both limits`)
mkdirSync('eval-results', { recursive: true })
const file = `eval-results/agents-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
writeFileSync(file, JSON.stringify({ model: MODEL, at: new Date().toISOString(), runs: report }, null, 2))
console.log(`details: ${file}`)
if (passed < RUNS) process.exitCode = 1
