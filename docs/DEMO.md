# Demo script

Four acts, about three and a half minutes. The order is the argument: each act answers the
question the previous one raises.

## Before you record

```
npm install
npm test          # 94 green, gives you a clean slate on screen
```

Have open: the [live page](https://lucid-keeperhub-test11-17fe.vercel.app),
and [the transaction](https://sepolia.basescan.org/tx/0x7d8d48492ff9994b4950762b4be91ce5d068f79f5ae531b1b516865a36780359)
on BaseScan.

---

## Act 1 — where Lucid stops (40 seconds)

Open `packages/payments/src/x402-reconciliation.ts` in the Lucid repo, or just
read the line from their types:

```
preflightIncoming — Evaluate amount and endpoint policies
  before another rail attempts an irreversible settlement.
```

**What to say:** "Lucid Agents is Daydreams' machine-commerce runtime — typed
functions become paid x402 entrypoints. It admits a payment when the facilitator
says the credential is good, and issues its receipt from the payment payload.
That's an HTTP response. Their own types name the next step and leave it to
somebody else."

**The line that lands:** "*Before another rail attempts an irreversible
settlement.* That's not a gap I found. That's a seam they documented."

---

## Act 2 — the join, and why it costs nothing (70 seconds)

Show `reconcilePaymentIdentifier` refusing mismatches:

```
payment_identifier_required     the payload must include an identifier
idempotency_key_required        Idempotency-Key is required when one is supplied
payment_identifier_mismatch     the identifier must equal Idempotency-Key
```

**What to say:** "Lucid already forces the x402 payment identifier to equal the
HTTP Idempotency-Key. So I don't need to invent anything. I pass that identifier
straight through as KeeperHub's idempotency_key."

**The line that lands:** "The value a buyer retries with is the value that
decides whether a transfer is broadcast or replayed. Nothing is generated,
correlated or stored to make the retry safe — it falls out of an invariant they
already enforce."

Now switch to the live page and **press the buttons**:

| Action | What to say |
|---|---|
| *Buyer pays* | "One transfer. Simulate, execute, verified receipt." |
| *Buyer retries* | "Same Idempotency-Key — which is what a real x402 buyer sends." |
| *Buyer retries* again | "Still one. Press it all day; it stays at one." |
| *Preflight would revert* | "Refused before broadcast. Costs nothing." |
| *Receipt unverified* | "Confirmed isn't good enough. Fulfilling is irreversible." |
| *No payment identifier* | "Refused outright — nothing to bind a retry to." |

**Worth saying explicitly:** "That page is running the real settler from the
repo. Only the transport is swapped. Those are the shipped code's decisions."

---

## Act 3 — a real Lucid agent, running (60 seconds)

This is the strongest thirty seconds in the demo. Do not skip it.

```
KH_API_KEY=kh_… npm run agent
curl localhost:3000/.well-known/agent-card.json
```

**What to say:** "That's not my server pretending to be Lucid. That's
`@lucid-agents/core`, `/http` and `/hono` off npm, serving Lucid's agent card and
Lucid's entrypoint."

Now show their validation rejecting a bad key, **before** any of my code runs:

```
curl -X POST localhost:3000/entrypoints/summarize/invoke \
  -H 'Idempotency-Key: short' -d '{"text":"hi"}'

{"error":{"code":"invalid_idempotency_key",
          "message":"Idempotency-Key must contain 20 to 256 characters"}}
```

**The line that lands:** "That error is Lucid's, not mine. Their runtime enforces
the identifier — I just make it mean something on chain."

Then the real one:

```
curl -X POST localhost:3000/entrypoints/summarize/invoke \
  -H 'Idempotency-Key: pay_lucid0917settle01' \
  -d '{"text":"KeeperHub settles what Lucid admits."}'
```

Point at the `settlement` block in the response, and at `payment.reference` —
Lucid's own settlement record, now carrying an onchain transaction hash. Their
types call that field *"a verified payment channel or session reference."*

Run the identical curl **again** with the same key. Same transaction hash,
`replayed: true`, and nothing new on chain.

---

## Act 4 — on chain (50 seconds)

Open BaseScan. Point at the transaction, then at the two facts:

| | |
|---|---|
| Payment identifier | `pay_lucid0917settle01` |
| Receipt | `verified: true`, `receiptStatus: success`, block 46952279 |
| Resent, same identifier | `idempotentReplay: true`, same hash, **no second transfer** |

**The line that lands:** "The retry is the evidence, not the payment. Anyone can
show you a transaction. The interesting part is the one that *didn't* happen."

---

## The KeeperHub-specific argument

Say this. It sounds like a criticism and isn't, and getting it right is what
separates the project from a generic queue:

> KeeperHub's idempotency key is correct and this depends on it. What this adds
> is a reason for the key to already exist — Lucid mints it, for its own
> purposes, before anyone thinks about settlement. The integration is mostly the
> observation that those two identifiers should be the same one.

---

## Questions you'll get

**"Why not just store a map of payment id to transaction hash?"**
That's a second source of truth that can disagree with the chain, and it has to
be durable and consistent before the first payment. Reusing the identifier means
there's nothing to keep in sync.

**"What if the settlement is slow?"**
It reports *pending*, never failed. Telling Lucid it failed while it may still
land invites a second settlement for the same payment — the exact failure the
identifier exists to prevent.

**"Why require `verified` rather than `confirmed`?"**
KeeperHub distinguishes an execution it believes succeeded from one whose
receipt it reconciled against the chain. Fulfilling an entrypoint can't be
undone, so it takes the stronger signal.

**"Is that really Lucid, or your own server?"**
Their packages from npm, their agent card, their entrypoint router, their
`Idempotency-Key` validation. The only thing that is mine is the handler and the
settler it calls.

**"Is this merged into Lucid?"**
No. It consumes their public seam and imports nothing private, so it could
become `@lucid-agents/keeperhub` — but that conversation hasn't happened. Say so
plainly; it reads better than implying otherwise.

**"What doesn't work?"**
Settlement is outbound only; collecting into a treasury is untouched. No live
Lucid service is wired to it — the settler is tested against a faithful fake of
their reconciliation output. And the nonce firewall underneath is unproven on
KeeperHub's sponsored path, which `docs/EXECUTIONS.md` says outright.

---

## If the live page won't load

It may be behind Vercel's Deployment Protection, which shows a login wall to
anyone who isn't the project owner. Fix it at **Project → Settings → Deployment
Protection → Vercel Authentication → Disabled**. Failing that, run
`npm run demo`, or open `public/index.html` locally — same page, same bundle.
