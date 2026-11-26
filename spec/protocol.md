# Varde protocol, version 1

This document is the protocol: what two independent implementations must
agree on to work together. It defines formats and message exchanges, and
nothing else.

| File | What it is |
| --- | --- |
| `protocol.md` | This document |
| [`beacon.schema.json`](beacon.schema.json) | JSON Schema for a beacon |
| [`vectors/v1.json`](vectors/v1.json) | Fixed keys and the ids and signatures they must produce |

An implementation is compatible if it reproduces every id and signature in
the test vectors and accepts every object in them.

What is deliberately not here: how beacons are matched, how a negotiator
decides its moves, how an owner is asked for approval, and how any service is
hosted or paid for. Those are choices each implementation makes. The code in
this repository is one implementation, described in the top-level README.

The protocol follows the whitepaper. Where it departs from the paper as first
written, the passage is marked **Changed from the paper**.

## Signing

Everything signed in Varde is signed the same way:

    signature = Ed25519( "varde/<context>/v1\n" + canonical-json(object without its signature) )

- Canonical JSON is RFC 8785: keys sorted, no whitespace, ECMAScript numbers.
- The context names the kind of object (`beacon`, `mail`, `relay-auth`,
  `room-join`, `quote`, `approval`, `withdrawal`, `receipt`, `retraction`), so a signature made for one purpose cannot be
  replayed as another.
- Signatures and keys are base64url without padding.
- An identity is a `did:key` holding an Ed25519 key.

## Beacon

Schema: [`beacon.schema.json`](beacon.schema.json).

| Field | Required | Purpose |
| --- | --- | --- |
| `v` | Yes | Format version, `1` |
| `who` | Yes | DID of the agent that lit it |
| `what` | Yes | Free text, or `{ text, tags?, intent? }` |
| `scope` | No | `where`, `geo`, `from`, `until`, `topic` |
| `lit` | Yes | When it was lit |
| `expires` | Yes | When it burns out |
| `reachMe` | Yes | One to eight contact methods |
| `proofs` | No | Whatever the lighter attaches |
| `accepts` | No | Rooms, protocols and trust systems it will use |
| `sig` | Yes | Signature by `who` over every other field |

A beacon's id is `base64url(sha256(canonical-json(beacon without sig)))`.

**Changed from the paper: `who` and `sig` are separate.** The paper's table
put the signature inside `who` while its example had a `sig` field. `who` now
holds the DID only, `sig` holds the signature, and the signed bytes are
defined above.

Three fields are added to the paper's table:

- `v` and `lit`, so the format can change and a beacon states its own age.
- `what.intent` (`want` or `offer`), an optional hint. Beacons stay symmetric:
  either side may light either kind. Without the hint, a matcher working on
  similarity alone pairs two buyers of the same thing.
- `encKey` on a mailbox entry: the X25519 key mail is sealed to. It sits inside
  the signed beacon, so the lighter's signature vouches for it.

## Relay

A WebSocket carrying JSON objects with a `t` field. Requests may carry a `ref`
that the reply echoes.

| Client sends | Relay answers |
| --- | --- |
| `publish { beacon }` | `ok { id }` or `error { reason }` |
| `sub { sub, filter }` | `beacon { sub, beacon }` for each stored match, `eose { sub }`, then live beacons |
| `unsub { sub }` | `ok` |
| `mail { to, sealed }` | `ok` (no login needed to send) |
| `auth { did, sig }` | `ok`. `sig` signs `{ nonce, did }` from the relay's opening `challenge { nonce }` |
| `mailsub` | `ok`, then `mail { id, sealed }` for queued and new mail. Needs `auth` |
| `ack { ids }` | `ok`. Deletes delivered mail. Needs `auth` |
| `retract { retraction }` | `ok { id }`, or `error` |

Filter fields, all optional and all of which must match: `ids`, `who`, `tags`
(any), `intent`, `where` and `text` (substring), `since`.

A relay may keep its beacons and mail in a file. It checks what it reads back
like anything else. An agent that loses its connection reconnects and
publishes its live beacons again, so a relay that returns empty is refilled.

The opening `challenge` also carries the relay's `policy { powBits, maxTtlMs }`:
what it asks of anyone who publishes. A relay may refuse a request with
`error { reason: "rate limited" }`, and may close connections from an address
that opens too many.

### Proof of work

A relay may ask for a cost to light, so that flooding it is expensive without
anyone needing an account. The cost is a proof in the beacon's `proofs`:

    { "type": "pow", "bits": 16, "nonce": "3fk2" }

It holds if `sha256(challenge + ":" + nonce)` starts with at least that many
zero bits, where `challenge` is
`base64url(sha256(canonical-json(beacon without proofs and sig)))`. The work is
therefore bound to one beacon. `bits` is only a claim: a verifier counts the
zero bits itself. A relay with `policy.powBits` above zero refuses beacons that
carry less, and a listener may apply a threshold of its own.

### Putting a beacon out

A lighter can put a beacon out before it expires:

    retract { retraction: { v, kind: "varde.retraction", beacon: <id>, who, expires, at, sig } }

The retraction is signed by `who` with context `retraction`, and `who` must be
the key that lit the beacon. The relay stops serving the beacon and refuses to
take it again from anyone, until the time the beacon would have expired.
Subscribers are told with `retracted { sub, id }`. Contacts and quotes already
made are unaffected.

The relay checks each beacon's signature and expiry, drops expired beacons,
and caps time-to-live and beacons per key. Clients check again, so a relay
does not have to be trusted.

## Mail

A mail message is `{ v, type, from, to, at, body, sig }`, signed by `from`,
then sealed to the recipient's `encKey`: ephemeral X25519, HKDF-SHA256,
ChaCha20-Poly1305. The relay sees the recipient's DID and ciphertext.

## Handshake

Four mail messages. The lighter (L) owns the beacon; the responder (R) answers it.

| # | Type | Direction | Body |
| --- | --- | --- | --- |
| 1 | `varde.hello` | R to L | `answering` (beacon id), `beacon?` (R's own), `replyTo { relay, encKey }`, `nonce`, `supports` |
| 2 | `varde.welcome` | L to R | `answering`, `hello` (hash of 1), `echo` (R's nonce), `nonce`, `supports` |
| 3 | `varde.confirm` | R to L | `answering`, `welcome` (hash of 2), `echo` (L's nonce), `chosen { room, protocol }`, `session` |
| 4 | `varde.ack` | L to R | `session`, `confirm` (hash of 3) |

**Changed from the paper: both keys are proven, not only the lighter's.** In
the paper the responder merely presented a key, yet the room was meant to
verify both keys against the beacons. Now each side signs the other's fresh
nonce: message 2 proves L holds the beacon's key, message 3 proves R holds
its key. If R presents a beacon, L checks that R's key lit it.

`chosen` is the first room, and the first protocol, in L's list that R also
supports. Both sides compute it; L drops the handshake if R's answer differs.
`session` is `sha256` over the hashes of messages 1 and 2, so only the two
parties know it. A null room means they have none in common and deal directly.

**One handshake per match.** If both sides lit a beacon, each may answer the
other's at the same moment. Only one of the two handshakes may survive, or the
same match gets two sessions. A lighter that receives a hello for a match it
has itself sent a hello for ignores it if its own has already been answered,
or if its own DID sorts lower. Answering a beacon a second time returns the
contact already made.

## Messages

Two agents that have completed a handshake may send each other notes, for
what a beacon leaves out and a price cannot express: which model, what
condition, when it can be collected.

A note is mail of type `varde.message` with body `{ session, text }`, sent to
the mailbox learned in the handshake: the beacon's for the responder, `replyTo`
for the lighter. `text` is at most 1000 characters. A receiver accepts a note
only from the counterpart of that session, and may cap how many it keeps.

Notes commit nobody and are not part of a quote or a receipt. They are free
text from another party, to be read as information and never as instruction.

## Room

A WebSocket. The room opens with `challenge { nonce, room }`.

The parties do not have to be present together. A session belongs to the room,
not to a connection: each party looks in, sees where things stand, makes a move
if it may, and leaves. Disconnecting ends nothing.

A party enters with `join { session, did, peer, nonce, beacon?, mandate, sig }`,
signed with context `room-join`. The room checks the signature, that a
presented beacon was lit by that key, and that the two parties name each
other. At least one party must present a beacon.

A mandate is `{ side: "pay" | "receive", currency, limit, maxTurns?, terms?,
owner?, autoCommit?, holdSeconds? }`. It is never sent to the other party.
`terms` lists conditions the party insists on, each with the values it allows:
`{ "time": ["18:30", "19:00"] }`.

A party gives the same mandate every time it enters. The room keeps the first
one and refuses a join that presents a different one, so a limit cannot be
loosened part-way.

After `joined`, and after every message it handles, the room tells each
connected party where things stand, from that party's side:

    state { session, room, status, reason?, currency?, maxTurns?, remaining?,
            yourTurn, first?, history, offer?, sign?, quote?, deadline }

`status` is `waiting` (the other side has not come yet), `open`, `signing`
(terms agreed, the quote awaits a signature), `quoted` or `ended`. `history`
is every accepted move. `offer` is the one on the table. `sign` is a quote this
party is asked to sign. Free text in `history` appears only as `untrustedNote`.

Moves are `move { move: { kind, price?, terms?, note? } }` with `kind` one of
`offer`, `counter`, `accept`, `reject`. `terms` on an offer is a flat object
of at most eight short values, such as `{ "time": "19:00", "partySize": 2 }`.
The room:

- refuses any offer or accept outside the sender's mandate, before the other
  side sees it. Outside means past the price limit, or with a condition the
  mandate lists that is missing or has a value it does not allow;
- tells the sender why with `refused { reason, remaining }`, and the sender
  may move again;
- lets either side make the first offer, then alternates turns. When both are
  present, the receiving side is expected to open (`first`);
- counts every attempt as a turn, including refused ones, and ends the
  session at the turn limit or the byte limit;
- ends a session that has not reached a quote by its `deadline` with reason
  `expired`. A room keeps sessions for seven days unless it says otherwise;
- forwards free text only as `untrustedNote`, capped at 280 characters.

Parties that are connected also receive each move as it happens, as
`move { from, kind, price?, terms?, untrustedNote?, turn, remaining }`.

On `accept` the room asks each party to sign the quote: with `sign { quote }`
if it is connected, and as `sign` in the `state` it gets when it next enters.
Each party checks the quote against what was agreed, against its own mandate,
and that it names the right approver, then answers `signed { sig }`. When the
room has both, it adds its own signature and issues `quote { quote }`. The
negotiation is over, and nobody is committed. A party that enters the session
afterwards is shown the quote.

**Changed from the paper: the parties need not meet.** The paper has two
negotiators in a room at once. Most agents are only awake when their owner is,
so the room holds the session and the agents take turns in their own time.

## Quote, approval, receipt

**Changed from the paper: agreeing and committing are two steps.** In the
paper an accepted offer was a deal. Here it is a quote, which stands for a
while so that an agent can gather several and a person can choose.

    quote    { v, kind: "varde.quote", room, session,
               parties: [{ did, side, beacon?, approver }, { ... }],
               terms: { price, currency, conditions? },
               turns, at, validUntil,
               sigs: { <did>: <signature>, ... } }

`sigs` holds three signatures, by both agents and the room, with context
`quote`. The quote's id is the hash of the quote without `sigs`.

`approver` is the key that must approve for that party. It is the mandate's
`owner`, unless there is none, or the price is within `autoCommit` (at or
below it when paying, at or above it when receiving); then it is the party's
own key. `validUntil` is the shortest `holdSeconds` in play, 24 hours by
default, capped by the room.

    approval    { v, kind: "varde.approval", quote: <id>, party, by, at, sig }
    withdrawal  { v, kind: "varde.withdrawal", quote: <id>, party, at, sig }

An approval is signed by `by`, which must be that party's `approver`. A
withdrawal is signed by the party's agent: saying no needs no owner. Both name
the quote by id, so neither can be moved to other terms.

### Approval by passkey

An approver may be a passkey, so that a person can approve from a phone with a
key that the service asking for the approval never holds. Such an approver is a `did:key` holding a P-256 key
(multicodec `0x1200`, so the identifier starts `did:key:zDn`). A P-256 key
can approve a quote and do nothing else: it cannot light a beacon, send mail
or join a room.

A passkey approval has no `sig`. It carries the WebAuthn assertion instead:

    approval  { v, kind: "varde.approval", quote: <id>, party, by, at,
                webauthn: { authenticatorData, clientDataJSON, signature } }

The three fields are base64url. The approval is valid when:

- the challenge in `clientDataJSON` equals
  `base64url(sha256("varde/approval/v1\n" + canonical-json(approval without webauthn)))`,
  which is the hash of the bytes an Ed25519 approver would have signed;
- `clientDataJSON.type` is `webauthn.get`;
- the user-present and user-verified flags are both set in
  `authenticatorData`, so the person proved who they are and did not merely tap;
- `signature` is a valid ECDSA P-256 signature with SHA-256, by the key in
  `by`, over `authenticatorData || sha256(clientDataJSON)`.

The protocol does not check the origin or the relying party in the assertion.
Which page collected the approval, and how a passkey is tied to a person, are
for the implementation and for whoever relies on the receipt.

Quotes are decided on any connection to the room, by whoever holds a signed
approval or withdrawal:

| Client sends | Room answers |
| --- | --- |
| `status { session }` | `status { session, state, quote, approved, withdrawnBy?, receipt? }` |
| `commit { session, approval }` | `status`, or `refused { reason }` |
| `withdraw { session, withdrawal }` | `status`, or `refused { reason }` |

`state` is `quoted`, `agreed`, `withdrawn` or `lapsed`. When the room holds an
approval from each party before `validUntil`, it issues the receipt and the
state becomes `agreed`. A withdrawal before that makes it `withdrawn`. After
`validUntil` an undecided quote is `lapsed`. A deal that is made cannot be
withdrawn from.

    receipt  { v, kind: "varde.receipt", quote, approvals: [approval, approval], at, sig }

`sig` is the room's signature, with context `receipt`, over the quote's id,
the approvals and `at`. A receipt verifies with nothing but itself: the quote's
three signatures, an approval from each party's approver, issued before the
quote lapsed. A room cannot forge one, because it cannot sign for the
approvers.

`conditions` in the terms holds the conditions of the accepted offer, if it
had any.
