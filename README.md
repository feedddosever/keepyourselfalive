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
| Epoch windowing | Done, 6 tests |
| Tip intake contract + validation | Done, 5 tests |
| `TipDisperser` contract | Done, 4 tests executed in a real EVM |
| REST adapter (`@keeperhub/sdk`) | Done — degraded preflight, see below |
| MCP adapter (`@keeperhub/mcp`) | Done — **argument keys unverified** |
| First Base Sepolia transaction | **Not done — needs a `kh_` key and a funded deployer** |

Two honest caveats. The MCP adapter's argument keys are reconstructed, because
`@keeperhub/mcp` ships no schemas and `tools/list` needs a key and network access
that the build environment did not have; confirm them with one `tools/list`
before trusting it with money. And the REST adapter cannot simulate or carry an
idempotency key at all, because `@keeperhub/sdk@0.1.1` exposes neither — it
substitutes a local `eth_call` preflight and says so in `via`, and reports
`idempotencyEnforcedRemotely: false` rather than implying a guarantee it lacks.
`docs/FRICTION.md` covers both.

## Run it

```
npm install
npm test                 # 38 tests, including the contract in a real EVM
npm run plan             # offline: netting and idempotency key, nothing broadcast
```

`plan` needs no API key, so the arithmetic is checkable before any money moves:

```
epoch          epoch-2026-09-17T13:00:00.000Z
tips           4
payouts        2 totalling 750000
  → 0x…000a  600000
  → 0x…000b  150000
carried        2 balances into the next epoch
idempotency    af9671ebf53d255b143ee78b621bf672013a9489f185655e56296b74c3335705
```

To settle for real: copy `.env.example` to `.env`, deploy the disperser
(`npm run deploy`), fund and approve the payer, then `npm run settle`.

## Layout

```
src/netting.ts       tips → net positions → settlement plan (pure)
src/idempotency.ts   canonical form of a plan's onchain effect → SHA-256 key
src/calldata.ts      plan → disperseToken calldata
src/ledger.ts        durable epoch log; crash recovery; overwrite refusal
src/settle.ts        simulate → broadcast → poll, with resume
src/keeperhub.ts     the three-call KeeperHub surface (port)
src/adapters/        one implementation per official surface
src/epoch.ts         clock-derived epoch ids; any instant in a window yields one id
src/ingest/source.ts the intake contract the app writes tips to
contracts/           TipDisperser: one atomic batched payout
```

## Tip intake

The app appends one JSON object per line to `state/tips.jsonl`:

```json
{"id":"cast-1-tip","from":"0x…","to":"0x…","amount":"500000","castHash":"0xaaa1","timestampMs":1758116906384}
```

`id` must be stable across observations — it is the dedupe key, so a source that
mints a fresh uuid per poll will pay a tip twice. `amount` is base units as a
string, never a decimal; `timestampMs` is when the tip happened, not when it was
seen, because that is what decides which epoch it belongs to. All three are
validated on read, with the file and line named on failure.
