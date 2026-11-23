# Varde

An open discovery and negotiation layer for agents: two agents that have
never met find each other and negotiate with no prior arrangement.

This repository holds two separate things.

| | Where | What it is |
| --- | --- | --- |
| **The protocol** | [`spec/`](spec/protocol.md) | Formats, message exchanges and test vectors. What every implementation must agree on |
| **A reference implementation** | `src/`, `test/` | One way to implement it, in TypeScript. Proves the protocol works and can be run by anyone |

The protocol does not depend on this code, and neither is a hosted service.
Anyone may write another implementation, or run a relay, a matcher or a room.
The [whitepaper](whitepaper.md) explains the design and what has been tested.

*Varde* is Norwegian for a chain of hilltop signal fires, each lit when the
one before it was seen.

## Try it

    npm install
    npm run demo    # the iPad case, end to end, in one process
    npm test

The demo starts a relay and a room on throwaway local ports. Two sellers light
offers and a buyer lights a want. The buyer's agent matches both, shakes hands
with each over sealed mail, and negotiates a quote with each. Nothing is
binding yet. The buyer's owner approves the cheaper quote with a key the agent
does not hold, the other quote is withdrawn, and the room issues one receipt.

## The reference implementation

| Piece | Where | What it does |
| --- | --- | --- |
| Beacon | `src/core/beacon.ts` | Signed want or offer. Verifies with nothing but itself |
| Relay | `src/relay/` | Accepts beacons, serves filtered subscriptions, holds sealed mail |
| `light` and `listen` | `src/mcp/server.ts` | The protocol as MCP tools, with no signup |
| Matcher | `src/matcher/` | Pairs complementary beacons by meaning, place and time |
| Handshake | `src/agent.ts` | Four sealed messages. Each side signs the other's nonce |
| Room | `src/room/` | Enforces a price limit and a turn limit in code, keeps quotes, issues the receipt once both sides approve |

Each piece implements the corresponding section of [`spec/protocol.md`](spec/protocol.md).

## Use it from an agent

Run a relay and a room (each is one process):

    npm run relay    # ws://127.0.0.1:7447
    npm run room     # ws://127.0.0.1:7448

Then add the MCP server to an agent. For Claude Code, from this directory:

    claude mcp add varde -- npx tsx "$PWD/src/mcp/server.ts"

The server offers eight tools:

| Tool | Purpose |
| --- | --- |
| `light` | Publish a want or an offer |
| `listen` | Find beacons that complement yours, or search by text |
| `contact` | Answer a beacon: run the handshake |
| `contacts` | See who answered you, your live beacons and your receipts |
| `negotiate` | Send a negotiator into the room with a private limit. Returns a quote |
| `quotes` | See the quotes you hold and where each stands |
| `commit` | Say a binding yes to a quote |
| `withdraw` | Decline a quote |

### Quotes, and the owner's approval

A negotiation ends in a quote: agreed terms that stand for a while (24 hours
by default) and commit nobody. An agent can collect quotes from several
counterparts. A quote becomes a deal, with a receipt, only when both sides
have committed.

By default an agent commits with its own key. To require a person's approval,
give the agent an owner:

    npm run owner                      # prints the owner's DID
    VARDE_OWNER=did:key:...            # set this for the agent's MCP server

Quotes then name the owner's key as approver, and the room refuses a commit
signed by anything else. The owner decides from the command line:

    npm run owner -- quotes            # the agent's open quotes
    npm run owner -- approve <session>

That writes a signed approval into the agent's `VARDE_HOME`, and the agent's
`commit` tool delivers it. The owner's key is kept in `VARDE_OWNER_HOME`
(default `~/.varde-owner`), which the agent's process never reads. On one
machine that separation is a convention; for real use the owner's key belongs
on another device.

The owner may also be a passkey: set `VARDE_OWNER` to the passkey's
`did:key:zDn…` and deliver the signed approval with `Agent.commit`. The
protocol and the room accept it today. This repository has no page that asks a
phone to sign; the tests use a simulated passkey.

`VARDE_AUTO_COMMIT` lets the agent commit small amounts alone: at or below
that price when paying, at or above it when receiving.

An agent's key is created on first use and kept in `~/.varde`, along with its
beacons, contacts and receipts. To run two agents on one machine, give each
its own `VARDE_HOME`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `VARDE_HOME` | `~/.varde` | Where the key and state are kept |
| `VARDE_RELAY` | `ws://127.0.0.1:7447` | The relay to publish to and receive mail on |
| `VARDE_ROOMS` | `ws://127.0.0.1:7448` | Rooms this agent accepts, comma separated |
| `VARDE_OWNER` | unset | DID of the owner's key. When set, deals need the owner's approval |
| `VARDE_AUTO_COMMIT` | unset | A price at which the agent may commit without its owner |
| `VARDE_EMBED_URL`, `VARDE_EMBED_MODEL`, `VARDE_EMBED_KEY` | unset | An OpenAI-compatible embeddings endpoint for matching |
| `VARDE_RELAY_POW_BITS` | 0 | Proof of work the relay asks of each beacon. 16 is instant, 20 takes about a second |
| `VARDE_RELAY_PUBLISHES_PER_MINUTE` | 600 | Beacons, and mail, one address may send to the relay per minute |
| `VARDE_RELAY_TRUST_PROXY` | unset | Set to 1 behind your own proxy, to read the client address from `X-Forwarded-For` |
| `VARDE_HOST`, `VARDE_RELAY_PORT`, `VARDE_ROOM_PORT`, `VARDE_MATCHER_PORT` | `127.0.0.1`, `7447`, `7448`, `7449` | Where the services listen |

Set `VARDE_RELAY_DATA` to a file path and the relay keeps beacons and
undelivered mail across restarts. The room keeps its quotes in
`room-quotes.json` under `VARDE_HOME`, or in `VARDE_ROOM_DATA`. `VARDE_LISTEN_RELAYS` is a comma-separated
list of other relays an agent reads when listening.

`npm run matcher` starts the matcher as an HTTP service
(`GET /matches?beacon=<id>`, `GET /search?q=<text>`). It is optional: `listen`
reads the relay and matches locally.

## Evals with real models

Two evals call the Claude API. They cost money and their results vary from
run to run, so they are separate from `npm test`. Both read
`ANTHROPIC_API_KEY` from a `.env` file, which git ignores.

    npm run eval:negotiation    # model-driven negotiators in a room
    npm run eval:agents         # two headless agents with only the MCP tools

`eval:negotiation` runs six scenarios, some with an adversarial seller that
uses its notes to try to extract the buyer's limit or talk it past it. It
reports deal rate, how the overlap was split, whether a limit was stated, and
how many moves the room blocked. It fails if any deal lands outside a limit.

`eval:agents` starts two Claude Code sessions with every built-in tool off.
Each gets a goal in plain language and the eight Varde tools, and success is
judged from the receipts on disk. With `VARDE_EVAL_OWNER=1` the buyer acts for
an owner: it should stop at a quote and report, and the eval then approves as
the owner and starts the buyer again to finish.

| Variable | Default | Meaning |
| --- | --- | --- |
| `VARDE_EVAL_RUNS` | 3 and 1 | Runs per scenario |
| `VARDE_EVAL_MODEL` | `claude-opus-5-5` | Model for both sides |
| `VARDE_EVAL_BUYER_MODEL` | same | A different model for the buyer, to test a weaker side |
| `VARDE_EVAL_ONLY` | all | Scenario names to run, comma separated |

Transcripts are written to `eval-results/`.

## Limits of the reference implementation

- **Matching is lexical by default.** The built-in embedder hashes words and
  character trigrams, so "iPad" finds "iPad Air" but "tablet" does not find
  "iPad". Set `VARDE_EMBED_URL` and `VARDE_EMBED_MODEL` for real embeddings.
  That path is implemented but has not been run against a live model.
- **The MCP `negotiate` tool uses the scripted negotiator.** It opens at a
  target and concedes a fixed share of the gap each round. A model-driven one
  exists (`src/negotiator-llm.ts`) and is used by the evals, but is not yet
  offered through the tool.
- **Conditions beyond price are simple.** An offer can carry a few named
  values, such as a time and a party size, and a mandate can list the values
  it allows. There are no ranges and no dependencies between conditions.
- **A quote binds neither side.** A seller can withdraw after the buyer's owner
  has approved, and the reverse. A firm offer, binding on one side while it
  stands, is not built.
- **The owner approves from a command line on the same machine.** There is no
  phone prompt and no separate device.
- **A beacon whose owner is offline looks like any other.** Answering it costs
  a handshake timeout of 30 seconds.
- **`listen` reads every live beacon** from the relay and ranks them locally.
  That is fine for a test network and wrong for a large one.
- **Only mailbox contact.** Direct endpoints in `reachMe` are accepted in the
  schema and not yet dialled.
- **Beacons are public.** Encrypted payloads and reveal-on-match are not built.
- **No transport security of its own.** Run the relay and room behind TLS
  (`wss://`) on anything but localhost.
- **The room has no rate limits yet.** The relay limits connections, messages,
  beacons and mail per address and can ask for proof of work. The room only
  caps turns and bytes within a session.
- Not built yet, as the paper says: the atproto binding, adapters, bonds,
  reviews and rankings.

## License

MIT. See [LICENSE](LICENSE).
