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

## Proof

A real settlement, on Base Sepolia, keyed by a Lucid-format payment identifier
(`pay_lucid0917settle01`):

| | |
|---|---|
| Transaction | [`0x7d8d4849…36780359`](https://sepolia.basescan.org/tx/0x7d8d48492ff9994b4950762b4be91ce5d068f79f5ae531b1b516865a36780359) |
| Value moved | 0.0000001 ETH to `0x…bEEF` |
| Receipt | `verified: true`, `receiptStatus: success`, block 46952279 |
| Retry under the same identifier | `idempotentReplay: true`, same hash, **no second transfer** |

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
- **No live Lucid service is wired to it.** The settler is tested against a
  faithful fake of Lucid's reconciliation output, not against a running
  entrypoint.
