# nonce-firewall

Two agents share a treasury key. Both build a transaction. Both are assigned the
same nonce, because neither had landed when the other was built. One transaction
is dropped — or replaced, if the second paid more gas. Both agents saw a
successful submission. One payment is simply gone, and nothing reports it.

This is an admission gate in front of KeeperHub that makes that unrepresentable.

## The failure, executed rather than asserted

`test/nonce-collision.test.ts` runs it in an in-process EVM:

```
✓ drops one of two distinct transactions that share a nonce
✓ lands both when the same two transactions are serialized
✓ lets a higher-gas replacement evict an already-submitted transaction
```

Alice is paid 1000. Bob's 2000 never happens. Neither transaction was malformed;
the second was merely built a moment too late.

## Why KeeperHub's idempotency key does not cover this

It is not supposed to. KeeperHub assigns a fresh nonce on every attempt and
deliberately excludes it from the idempotency key, so that *a retry of the same
intent* reproduces the key and replays the first execution instead of paying
twice. That is correct, and this project relies on it.

The uncovered case is *distinct* intents submitted concurrently on one key. Two
different payments are two different intents, so they derive two different keys,
so nothing links them — and they still contend for one nonce. Idempotency is
about identity; this is about concurrency.

## Mechanism

A **lane** is one sender key on one chain. All nonce contention lives inside a lane.

| Rule | Failure it removes |
|---|---|
| At most one intent in flight per lane | Two transactions assigned the same nonce |
| The lease is durable, not in-memory | A crash frees the lock, a restart broadcasts a second time |
| Admission order is priority, then intent hash — never arrival | Two schedulers racing admit different intents and both broadcast |
| Gas ceiling checked against the simulation | A runaway call burns the treasury's gas before anyone reads a receipt |
| Reverting simulation rejected pre-broadcast | Paying gas to learn what a dry run already knew |
| A submitter's stale intent is superseded by its own fresher one | A stale rebalance executing after the fresh one that replaced it |
| Supersession never crosses submitters | One agent cancelling another's queued work by naming its resource |
| A wedged execution quarantines its lane | Nonce gaps stacking behind a transaction that never lands |

The last one is the subtle one: quarantine refuses new admissions but does **not**
release the lease. A pending transaction may still land on its nonce, so freeing
the lane would admit a second intent onto that same nonce — precisely the failure
being prevented. Clearing it is an operator decision, recorded with a note.

The intent hash doubles as the idempotency key passed to KeeperHub, so the two
mechanisms compose: the firewall stops concurrent intents colliding, and the key
stops a retried admission rebroadcasting.

## Watch it

```
npm install
npm test          # 59 tests
npm run demo      # no API key needed
```

The demo puts six agents on one key and walks through every rule above:

```
1. Six agents submit at once against one treasury key
   drain admitted 1, broadcast count 1
   without the lease, all six would be assigned the same nonce

5. A gas ceiling is enforced before broadcast, not after
   runaway → rejected-gas-ceiling (1200000 > ceiling 150000)
   broadcast count 2 — the rejected intent never reached the chain

6. A wedged transaction quarantines its lane instead of stacking nonces
   new submission → rejected-quarantined
   broadcast count 3 (was 3) — nothing queued behind the wedge
```

It ends by printing the audit trail: every queue, admission, supersession,
rejection and quarantine with its reason.

## Layout

```
src/firewall/intent.ts    intent identity, lane key, deterministic ordering
src/firewall/store.ts     durable lane state — the lease outlives the process
src/firewall/firewall.ts  submit / drain / poll state machine
src/firewall/demo.ts      the six-agent walkthrough
src/keeperhub.ts          the KeeperHub port
src/adapters/             one implementation per official surface
```

## First client

The repository also contains a netted settlement agent — it collapses many tip
obligations into one batched payout, and is what the firewall was built for. It
contributes the pieces the firewall reuses: the canonical-effect hash, the
durable ledger with crash recovery, both KeeperHub adapters, and the EVM test
harness. `src/netting.ts`, `src/settle.ts` and `contracts/TipDisperser.sol`.

## Status

| Piece | State |
|---|---|
| Collision demonstration in a real EVM | Done, 3 tests |
| Lane exclusivity, ordering, durability | Done, 18 tests |
| Netting, idempotency, ledger, disperser | Done, 38 tests |
| REST adapter (`@keeperhub/sdk`) | Done — degraded preflight, see `docs/FRICTION.md` |
| MCP adapter (`@keeperhub/mcp`) | Done — **argument keys unverified** |
| First Base Sepolia transaction | **Not done — needs a `kh_` key and a funded sender** |

Two standing caveats, both in `docs/FRICTION.md`: `@keeperhub/sdk@0.1.1` exposes
neither `simulate` nor an idempotency key, so the REST adapter substitutes a
local `eth_call` preflight and reports `idempotencyEnforcedRemotely: false`
rather than implying a guarantee it lacks; and the MCP adapter's argument keys
are reconstructed, because `@keeperhub/mcp` ships no schemas and `tools/list`
needs a key. Confirm them with one `tools/list` before trusting it with money.
