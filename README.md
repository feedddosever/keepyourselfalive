# netted-tips

Farcaster tipping generates hundreds of micro-obligations. Settling each one
onchain costs more than the tip. This agent nets an interval's tips down to one
balance per account and settles them in a single batched transaction through
KeeperHub.

Three tip events in, one transfer out.

## Why it needs an execution layer

The netting is arithmetic; the hard part is that the payout must happen **exactly
once**. A tipping agent that retries after an ambiguous outcome and pays a
creator twice is worse than one that never paid at all — the money is gone and
the ledger is wrong. Two mechanisms cover that, and they cover different failures:

| Failure | Caught by |
|---|---|
| Retry after a timeout re-derives the same plan | Idempotency key — KeeperHub replays the first execution |
| Crash between broadcast and confirmation | Epoch ledger — the next run resumes the execution, it does not re-plan |
| Netting bug produces an unpayable batch | Simulation — reverts abort the epoch before any gas is spent |
| Tips re-ingested with new ids | Tip-id dedupe inside the epoch |
| Same epoch re-planned with different contents | Ledger refuses to overwrite a different onchain effect |

The idempotency key is a SHA-256 over the epoch id plus exactly the fields that
decide the onchain effect — chain id in decimal, token, disperser, and the sorted
payout set. Nonce, gas price and wall-clock time are **excluded on purpose**: a
retry gets a fresh nonce, and hashing it would mint a new key and broadcast a
second payout. `test/idempotency.test.ts` asserts this over 200 randomized
epochs, each replayed in shuffled ingestion order.

## Status

| Piece | State |
|---|---|
| Netting engine, carry-forward, conservation | Done, 9 tests |
| Idempotency key + order-invariance property | Done, 9 tests |
| Epoch ledger, crash recovery, exactly-once | Done, 5 tests |
| KeeperHub adapter (`src/keeperhub.ts`) | **Interface only — schema reconstructed, see below** |
| Tip ingestion | Not started — depends on the app's tip source |
| CLI / scheduler | Not started |

`src/keeperhub.ts` was written against the documented call sequence
(`execute_contract_call` with `simulate: true`, then with `idempotency_key`, then
`get_direct_execution_status`) but **not** against the real parameter schema —
`docs.keeperhub.com` was unreachable from the build environment. Everything else
is written against that interface, so reconciling it is a one-file change.

## Test

```
npm install
npm test
```

## Layout

```
src/netting.ts       tips → net positions → settlement plan (pure)
src/idempotency.ts   canonical form of a plan's onchain effect → SHA-256 key
src/calldata.ts      plan → disperseToken calldata
src/ledger.ts        durable epoch log; crash recovery; overwrite refusal
src/settle.ts        simulate → broadcast → poll, with resume
src/keeperhub.ts     the three-call KeeperHub surface (adapter boundary)
```
