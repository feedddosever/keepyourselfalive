# lucid-agents × keeperhub

**Lucid Agents settles on an HTTP response. This makes it settle on a verified
onchain receipt — without generating a single new identifier.**

[**Live demo →**](https://lucid-keeperhub-test11-17fe.vercel.app) ·
[**Transaction →**](https://sepolia.basescan.org/tx/0x549b61b1cd7727aea1bf9626d69d414dcc175d87baa8b1aaa202966227ac6a5e)

---

[Lucid Agents](https://github.com/daydreamsai/lucid-agents) is Daydreams' machine
commerce runtime: typed functions become paid x402 entrypoints. It admits a
payment when the facilitator says the credential is good. Its own types hand the
next step to somebody else:

```
preflightIncoming — Evaluate amount and endpoint policies
  before another rail attempts an irreversible settlement.
```

This is that rail.

## The join

Lucid already enforces the invariant this needs. `reconcilePaymentIdentifier`
refuses any request where the x402 payment identifier does not **equal** the HTTP
`Idempotency-Key`. Pass that identifier through as KeeperHub's `idempotency_key`
and one identity spans the whole path:

> The value a buyer retries with is the value that decides whether a transfer is
> broadcast or replayed.

Nothing is generated, correlated or stored to make the retry safe. It falls out
of a rule Lucid was already applying for its own reasons.

In return, Lucid gains the other direction: it can finalize against a receipt
KeeperHub reconciled with the chain, rather than against an HTTP 200.

## Verify it yourself

Steps 1 and 2 need no credentials. Step 3 needs your own KeeperHub organization
key and settles 0.0000001 test ETH from your own org wallet on Base Sepolia — a
fraction of a cent, but it is your wallet, so it is worth saying.

```
# 1. Get it. Needs Node 22+ and git.
git clone https://github.com/feedddosever/keepyourselfalive
cd keepyourselfalive
git checkout claude/wizardly-darwin-ndhujg
npm install

# 2. No credentials needed.
npm test          # 94 tests
npm run demo      # the admission-control walkthrough, printed

# 3. Real settlement, with your own kh_ key.
cp .env.example .env      # paste your key into it, then:
npm run verify:live
```

Step 3 prints:

```
  ok   Lucid serves its agent card  name=summarizer
  ok   Lucid rejects a malformed Idempotency-Key  invalid_idempotency_key
  ok   a valid key settles through KeeperHub  0x…
  ok   the same key does not pay twice  same transaction, absorbed by
                                        Lucid's HTTP idempotency store

  transaction  https://sepolia.basescan.org/tx/0x…

all four checks passed. The integration works end to end.
```

Windows, step-by-step setup, and what each failure means:
**[docs/RUNNING.md](docs/RUNNING.md)**.

## A running Lucid service, not a description of one

`examples/lucid-agent/server.ts` is a real Lucid agent on their published
packages — `@lucid-agents/core`, `/http`, `/hono` — serving their agent card and
their entrypoint.

Two behaviours show the integration sits on Lucid's seam rather than beside it.
Their HTTP extension rejects a malformed key **before the handler runs**:

```
$ curl -X POST …/entrypoints/summarize/invoke -H 'Idempotency-Key: short'
{"error":{"code":"invalid_idempotency_key",
          "message":"Idempotency-Key must contain 20 to 256 characters"}}
```

That error is Lucid's. And the handler returns Lucid's own settlement record,
putting the transaction hash where their types ask for a *"verified payment
channel or session reference"*:

```ts
payment: { actualAmount: PRICE_ETH, asset: "ETH", reference: settlement.txHash }
```

## Two layers of exactly-once, and Lucid's fires first

Running it end to end surfaced something the unit tests could not: a retried
invocation never reaches KeeperHub. Lucid keeps its own HTTP idempotency store,
enabled by default, and replays its recorded response — two requests, one
`invoke` line in the server log.

| Layer | Catches | Evidence |
|---|---|---|
| Lucid HTTP idempotency | A buyer retrying the same request | One invoke line for two requests |
| KeeperHub idempotency key | A retry that *does* reach settlement — a crash between the two, a second scheduler, a replayed queue entry | `idempotentReplay: true`, same hash |

Neither is redundant. Lucid's store is in-memory and per-process, so it is gone
after a restart — which is exactly when KeeperHub's key still holds.

## Why `verified`, not `confirmed`

KeeperHub distinguishes an execution it believes succeeded from one whose receipt
it reconciled against the chain. Fulfilling an entrypoint is irreversible, so the
settler takes the stronger signal and refuses four non-happy paths rather than
fulfilling:

| Condition | Behaviour |
|---|---|
| No payment identifier | Refused — nothing to bind a retry to |
| Preflight would revert | Never broadcast; Lucid refuses the invocation |
| Confirmed but `verified: false` | Refused — not reconciled with the chain |
| Still pending after the poll budget | Reported **pending**, never failed |

The last row is deliberate. Telling Lucid a settlement failed while it may still
land invites a second settlement for the same payment — the exact failure the
identifier exists to prevent.

## Proof

| | |
|---|---|
| Payment identifier | `pay_verify1789726271604` |
| Transaction | [`0x549b61b1…27ac6a5e`](https://sepolia.basescan.org/tx/0x549b61b1cd7727aea1bf9626d69d414dcc175d87baa8b1aaa202966227ac6a5e) |
| Value | 0.0000001 ETH → `0x…bEEF`, block 46978993, Base Sepolia |
| Resent, same identifier | same hash, no second transfer |

Settled by the running Lucid agent via an HTTP invoke of its paid entrypoint —
not by a script. Every execution, including the ones driven directly through the
settler, is in **[docs/EXECUTIONS.md](docs/EXECUTIONS.md)**.

## What is unfinished

- **Not merged upstream.** This consumes Lucid's public seam and imports nothing
  private, so it could become `@lucid-agents/keeperhub` — but that conversation
  has not happened.
- **Settlement is outbound only.** Collecting *into* a treasury is untouched.
- **Inbound x402 admission is not wired.** The agent settles on invoke; it does
  not yet verify an incoming x402 credential through Lucid's authorizer.
- **The nonce firewall is unproven on KeeperHub's sponsored path.** Sponsored
  sends are relayed, so the consecutive-nonce claim is not established for them.
  `docs/EXECUTIONS.md` says so rather than implying otherwise.

## Layout

```
src/lucid/settlement.ts     the bridge: Lucid's identifier → KeeperHub's key
src/lucid/types.ts          what Lucid hands over, and what it may finalize on
src/adapters/mcp.ts         KeeperHub over MCP — simulate, idempotency, receipts
src/adapters/rest.ts        @keeperhub/sdk, which exposes neither (see FRICTION)
src/adapters/body.ts        byte-stable request body; a float breaks the binding
examples/lucid-agent/       a real Lucid service wired to the settler
src/firewall/               admission control for a shared sender key
scripts/verify-live.mjs     the four checks above, in one command
```

## Documentation

| | |
|---|---|
| [docs/INTEGRATION.md](docs/INTEGRATION.md) | The full account: the seam, the flow, what is unfinished |
| [docs/EXECUTIONS.md](docs/EXECUTIONS.md) | Every transaction, and what each does *not* prove |
| [docs/FRICTION.md](docs/FRICTION.md) | Where KeeperHub was hard to integrate against, with fixes |
| [docs/RUNNING.md](docs/RUNNING.md) | Setup, Windows notes, failure-to-cause table |
| [docs/DEMO.md](docs/DEMO.md) | The demo script |

---

## The nonce firewall underneath

Two agents share a treasury key. Both build a transaction. Both are assigned the
same nonce, because neither had landed when the other was built. One is dropped —
or replaced, if the second paid more gas. Both agents saw a successful
submission. One payment is gone, and nothing reports it.

`test/nonce-collision.test.ts` executes that in an in-process EVM rather than
asserting it. Alice is paid 1000; Bob's 2000 never happens.

This is **not** a gap in KeeperHub's idempotency key. That key deliberately
excludes the nonce so a *retry of the same intent* replays instead of paying
twice, and this project depends on it. The uncovered case is *distinct* intents
submitted concurrently: two payments derive two keys, so nothing links them, and
they still contend for one nonce. Idempotency is about identity; this is about
concurrency.

A **lane** is one sender key on one chain:

| Rule | Failure it removes |
|---|---|
| One intent in flight per lane | Two transactions assigned the same nonce |
| The lease is durable, not in-memory | A crash frees the lock; the restart broadcasts again |
| Order is priority, then intent hash — never arrival | Two schedulers admit different intents and both broadcast |
| Gas ceiling checked against the simulation | A runaway call drains the treasury's gas |
| Reverting simulation rejected pre-broadcast | Paying gas to learn what a dry run already knew |
| A submitter's stale intent yields to its own fresher one | A stale rebalance executing after its replacement |
| Supersession never crosses submitters | One agent cancelling another's queued work |
| A wedged execution quarantines its lane | Nonce gaps stacking behind a transaction that never lands |

Quarantine refuses new admissions but does **not** release the lease: the wedged
transaction may still land on its nonce, and freeing the lane would put a second
one there. Clearing it is an operator decision, recorded with a note.

```
npm run demo      # six agents on one key, every rule above, no credentials
```

It ends by printing the audit trail — every queue, admission, supersession,
rejection and quarantine, with its reason.
