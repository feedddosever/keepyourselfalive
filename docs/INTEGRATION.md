# Integration: Lucid Agents × KeeperHub

**The project on the other side:** [Lucid Agents](https://github.com/daydreamsai/lucid-agents)
(`daydreamsai/lucid-agents`), the Daydreams machine-commerce runtime. Live, open
source, on npm as `@lucid-agents/*`.

## What Lucid does, and where it stops

Lucid turns typed functions into paid, discoverable entrypoints. Its README is
explicit about the boundary:

> It provides one runtime for schemas, payment admission, policy, idempotency,
> fulfillment, discovery, and accounting **while wallets, payment protocols,
> networks, and facilitators remain external.**

So Lucid admits a payment when the x402 facilitator says the credential is good,
and issues its offer receipt from the payment payload — from an HTTP response.
Its own types name the next step and leave it to someone else
(`packages/types/src/payments/index.ts`):

> `preflightIncoming` — *Evaluate amount and endpoint policies before another
> rail attempts an irreversible settlement.*

**KeeperHub is that rail.** This integration is the piece Lucid deliberately
does not ship.

## The join: one identity for the whole path

Lucid already enforces an invariant that makes this clean. In
`packages/payments/src/x402-reconciliation.ts`, `reconcilePaymentIdentifier`
refuses any request where the x402 payment identifier does not **equal** the HTTP
`Idempotency-Key`, and where either fails `isValidPaymentId`:

```
payment_identifier_required     the payload must include an identifier
idempotency_key_required        Idempotency-Key is required when one is supplied
payment_identifier_mismatch     the identifier must equal Idempotency-Key
```

That identifier is passed straight through as KeeperHub's `idempotency_key`.
The consequence is the whole point:

> The value a buyer retries with is the same value that decides whether a
> transfer is broadcast or replayed.

Nothing is generated, correlated, or stored to make the retry safe. A buyer who
resends an x402 request with the same `Idempotency-Key` — which Lucid *requires*
them to do — cannot be charged twice, because KeeperHub replays the first
execution.

And the return direction is what Lucid gains: it can finalize against a receipt
**reconciled with the chain** rather than an HTTP 200.

## Flow

```
buyer → Lucid entrypoint (x402)
        reconcilePaymentIdentifier  →  paymentIdentifier === Idempotency-Key
        preflightIncoming           →  amount and endpoint policy
                ↓  LucidKeeperHubSettler
        KeeperHub simulate          →  a revert costs nothing, Lucid refuses
        KeeperHub execute           →  idempotency_key = paymentIdentifier
        KeeperHub receipt           →  verified: true, receiptStatus: success
                ↓
        Lucid fulfils the entrypoint
```

`src/lucid/settlement.ts` is the middle. Both a natively priced offer and an
ERC-20 offer are supported; Lucid's `X402PaymentProjection` allows either.

## Why `verified`, not `confirmed`

KeeperHub distinguishes an execution it believes succeeded from one whose
receipt it has checked against the chain. Fulfilling an entrypoint is
irreversible, so the settler requires the stronger signal and raises
`UnverifiedSettlementError` otherwise. Four non-happy paths are refused rather
than fulfilled:

| Condition | Behaviour |
|---|---|
| No payment identifier | `UnidentifiedPaymentError` — nothing to bind a retry to |
| Preflight would revert | Never broadcast; Lucid refuses the invocation |
| Confirmed but `verified: false` | Refused — not reconciled with the chain |
| Still pending after the poll budget | Reported **pending**, never failed |

That last row is deliberate. Telling Lucid a settlement failed when it may still
land invites a second settlement for the same payment — which is exactly the
failure the identifier is meant to prevent.

## A running Lucid service

`examples/lucid-agent/server.ts` is a real Lucid agent built on their published
packages — `@lucid-agents/core`, `/http`, `/hono` — serving their agent card and
their entrypoint. Not a reimplementation:

```
$ npm run agent
lucid agent listening on http://localhost:3141
  agent card   GET  /.well-known/agent-card.json
  entrypoint   POST /entrypoints/summarize/invoke

$ curl localhost:3141/.well-known/agent-card.json
{"protocolVersion":"1.0","name":"summarizer","skills":[{"id":"summarize", ...
```

Two behaviours confirm the integration sits on Lucid's real seam rather than
beside it:

**Lucid rejects a malformed key before the handler runs.** Their HTTP extension
validates `Idempotency-Key` at 20–256 characters:

```
$ curl -X POST .../entrypoints/summarize/invoke -H 'Idempotency-Key: short'
{"error":{"code":"invalid_idempotency_key",
          "message":"Idempotency-Key must contain 20 to 256 characters"}}
```

That error is Lucid's, not this project's. The settlement path is never reached.

**A valid key reaches KeeperHub.** With a well-formed `Idempotency-Key`
the handler settles through `LucidKeeperHubSettler` and the call goes out to the
MCP endpoint — in a sandbox without egress it fails there, and nowhere earlier:

```
{"error":{"code":"internal_error",
          "message":"KeeperHub initialize failed (403): Host not in allowlist"}}
```

The handler also returns Lucid's own settlement record:

```ts
payment: { actualAmount: PRICE_ETH, asset: "ETH", reference: settlement.txHash }
```

`reference` is documented in Lucid's types as a *"verified payment channel or
session reference"*. Putting the transaction hash there means Lucid's accounting
ends up pointing at a receipt that was reconciled against the chain.

## Two layers of exactly-once, and Lucid's fires first

Running the agent end to end surfaced something the unit tests could not: a
retried invocation never reaches KeeperHub at all.

Lucid's HTTP extension keeps its own idempotency store — `claim` / `release` /
`complete`, enabled by default via `createInMemoryHttpIdempotencyStore`. On the
second request with the same `Idempotency-Key`, Lucid replays its recorded
response and the handler does not run. The server log shows it plainly: two HTTP
requests, one `[agent-kit:entrypoint] invoke` line.

So the two mechanisms compose rather than overlap:

| Layer | Catches | Evidence |
|---|---|---|
| Lucid HTTP idempotency | A buyer retrying the same request | One invoke line for two requests; identical response |
| KeeperHub idempotency key | A retry that *does* reach settlement — a crash between the two, a second scheduler, a replayed queue entry | `idempotentReplay: true`, same hash (`docs/EXECUTIONS.md`) |

The outer layer is the common case and the inner one is the safety net. Neither
is redundant: Lucid's store is in-memory and per-process, so it is gone after a
restart — and that is exactly when KeeperHub's key still holds.

This is why `verify:live` asserts that the transaction hash is unchanged rather
than that KeeperHub reported a replay. Requiring KeeperHub's flag would fail a
correctly behaving system, because a healthy Lucid never lets the retry through.

## Proof

A real payment, settled by the **running Lucid agent** via an HTTP invoke of its
paid entrypoint — not by a script:

| | |
|---|---|
| Payment identifier | `pay_verify1789726271604` |
| Transaction | [`0x549b61b1…27ac6a5e`](https://sepolia.basescan.org/tx/0x549b61b1cd7727aea1bf9626d69d414dcc175d87baa8b1aaa202966227ac6a5e) |
| Value moved | 0.0000001 ETH to `0x…bEEF` |
| Block | 46978993 on Base Sepolia |
| Retry under the same identifier | same hash, **no second transfer** |

An earlier settlement driven straight through the settler, keyed by
`pay_lucid0917settle01`, is
[`0x7d8d4849…36780359`](https://sepolia.basescan.org/tx/0x7d8d48492ff9994b4950762b4be91ce5d068f79f5ae531b1b516865a36780359) — that one
returned `idempotentReplay: true` on retry, which is the KeeperHub layer doing the
work rather than Lucid's. Both are in `docs/EXECUTIONS.md`.

The retry is the load-bearing evidence: it is the behaviour a Lucid buyer
actually produces, and it moved no additional value.

## KeeperHub surfaces used

MCP (`execute_contract_call`, `execute_transfer`, `get_direct_execution_status`),
its simulation preflight, its idempotency keys, and its verified receipts /
audit trail. Testnet — Base Sepolia (84532).

## What is unfinished

- **Not merged upstream.** This is a consumer of Lucid's public seam, not a PR
  to `daydreamsai/lucid-agents`. It imports nothing private, so it could become
  `@lucid-agents/keeperhub`, but that conversation has not happened.
- **Settlement is outbound only.** The settler pays a seller. The reverse leg —
  Lucid collecting *into* a treasury — is untouched.
- **The nonce firewall underneath is unproven on the sponsored path.** See
  `docs/EXECUTIONS.md`: KeeperHub sponsors and relays these sends, so the
  consecutive-nonce claim is not established for them.
- **Inbound x402 is not wired.** The running agent settles outbound on invoke;
  it does not yet verify an incoming x402 credential through Lucid's
  `createIncomingPaymentAuthorizer`. The identifier it keys on is the
  `Idempotency-Key` Lucid validates, which is the value its x402 reconciliation
  forces the payment identifier to equal — but the x402 admission leg itself is
  not exercised.
