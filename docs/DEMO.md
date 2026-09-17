# Demo script

Three acts, about three minutes. Each one answers a question the previous one
raises. Run them in order — the order is the argument.

## Before you record

```
npm install
npm test          # 82 green, gives you a clean slate on screen
```

For Act 3 only:

```
export KH_API_KEY=kh_…          # organization key, Settings → API Keys → Organisation
export SENDER_ADDRESS=0xE4a475d134bB72ff8045eA4E4c762174408311a8
```

---

## Act 1 — the bug is real (40 seconds)

```
npx vitest run test/nonce-collision.test.ts
```

**What to say:** "Two agents share a treasury key. Both build a transaction.
Both are assigned nonce zero, because neither had landed when the other was
built. This isn't a thought experiment — it's running in a real EVM right now."

**What to point at:** the second test name, and the assertion that Bob's balance
is zero.

> Alice is paid 1000. Bob's 2000 never happens. Neither transaction was
> malformed. The second was built a moment too late, and it is gone — and both
> submitters saw a successful submission.

**The line that lands:** "Nobody is told. There's no error, no receipt, no
retry. The money just isn't there."

Then point at the third test — a higher-gas transaction on the same nonce
*replaces* the first. "That's not a race any more, that's an accidental cancel."

---

## Act 2 — the mechanism (60 seconds)

```
npm run demo
```

No API key needed, so this always works on stage.

Six agents submit at once against one key. Walk the output:

| Step | What to say |
|---|---|
| 1 | "Six submissions. One broadcast. The other five are queued, not lost." |
| 2 | "Drain again, and again — still one. The lease is held." |
| 3 | "The lease releases only when the transaction resolves. Then the next one goes." |
| 4 | "A stale rebalance is dropped by its own submitter's fresher one. But no agent can drop *another* agent's work." |
| 5 | "The gas ceiling is checked against the simulation, so the rejection costs nothing." |
| 6 | "A wedged transaction quarantines the lane. It does *not* free it." |

**The line that lands**, on step 6: "That's the subtle one. The wedged
transaction might still land on its nonce. If we freed the lane, we'd put a
second transaction on that same nonce — which is the exact bug we started with.
So quarantine refuses new work and waits for a human."

Finish on the audit trail: "Every decision, with its reason. That's what you'd
hand an auditor."

---

## Act 3 — on chain (60 seconds)

```
npm run execute
```

Two agents, one key, two `approve` calls — zero value, so it costs only gas.

**What to say:** "Same six-agent logic, now against the real chain through
KeeperHub. Watch the nonces."

**What to point at:** the two BaseScan links at the end. Open both.

**The line that lands:** "Two transactions. Consecutive nonces. Both landed.
Without the firewall these two would have been assigned the same nonce and one
of them would be gone — and you'd only find out by reconciling balances later."

---

## The KeeperHub-specific argument

This is the part that separates the project from a generic queue, and it is
worth saying explicitly, because it sounds like a criticism and isn't:

> KeeperHub already has an idempotency key, and it's correct. It deliberately
> excludes the nonce, so that a **retry of the same intent** replays the first
> execution instead of paying twice. This project depends on that.
>
> What it doesn't cover is **distinct intents submitted concurrently**. Two
> different payments are two different intents, so they derive two different
> keys, so nothing links them — and they still contend for one nonce.
> Idempotency is about identity. This is about concurrency. They're orthogonal,
> and you need both.

---

## Questions you'll get, and the answers

**"Why not just use a mutex?"**
A crash releases a mutex — and a crash is exactly when a restarted scheduler
re-derives the same plan and broadcasts it again. The lease is written to disk
before the broadcast, so the restart finds it still held. There's a test that
kills one process mid-flight and asserts the restart doesn't re-broadcast.

**"Why not process in arrival order?"**
Two schedulers racing the same queue see arrivals in different orders. If
arrival broke ties they'd admit different intents and both would broadcast.
Order is priority, then a hash of the intent's onchain effect — a pure function
of the queue's contents, so every scheduler picks the same winner.

**"What if the stuck transaction never lands?"**
A human clears the quarantine, and that's deliberate. The agent can't know
whether a pending transaction is dead or slow, and guessing wrong in either
direction is expensive. It records why it stopped and waits.

**"Does this need a database?"**
No. Lane state is a JSON file with an atomic rename. Production would want
something stronger for multiple schedulers on different machines, and the store
is one interface — that's the honest answer, not a pretend one.

**"What can't it do?"**
It serializes one sender key. It does not make two *different* keys safe against
each other, it doesn't do fee bumping for a genuinely stuck transaction, and the
supersession rule needs submitters to name their resources honestly. All three
are stated in the README rather than hidden.

---

## If Act 3 fails on stage

Fall back to Act 2 and say so plainly: "the chain call needs a funded key and a
live credential; here's the same logic against a scripted executor, and here are
the transaction links from the recorded run." Judges respond far better to that
than to a demo that pretends.
