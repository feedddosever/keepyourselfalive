# Executions through KeeperHub

Base Sepolia (chain 84532), organization wallet
`0xE4a475d134bB72ff8045eA4E4c762174408311a8`, 2026-09-17.

Two intents were submitted against one sender key and admitted one at a time by
the firewall. The idempotency keys are the firewall's own intent hashes,
derived by `src/firewall/intent.ts` — not hand-made for the demo.

## The two admissions

Admission order is priority, then intent hash — never arrival. The firewall
admitted **approve-2 first**, although approve-1 was submitted first:

```
lane: 84532:0xe4a475d134bb72ff8045ea4e4c762174408311a8
admission order: approve-2 then approve-1
```

| # | Intent | Idempotency key (= intent hash) | Transaction |
|---|---|---|---|
| 1 | `approve-2` | `59294592…e29e54f3` | [`0x5a4ab02a…9411d984`](https://sepolia.basescan.org/tx/0x5a4ab02add78c18598bef2334a1664000d5c040ac22f86d21931e7979411d984) |
| 2 | `approve-1` | `751f0246…3246b622` | [`0x38b82baf…63fe0b3d`](https://sepolia.basescan.org/tx/0x38b82baf7af0729427b701e1def3d074c75635fc4f0ee4fc775a240563fe0b3d) |

Both `receiptStatus: success`, both `verified: true`, blocks 46951995 and
46952003. Gas used 84,652 and 57,576.

## Exactly-once, demonstrated live

The first intent was then resubmitted with the same idempotency key and a
byte-identical body. KeeperHub replayed it rather than broadcasting again:

```json
{
  "status": "completed",
  "executionId": "8j21onj6dmwgbhjwg8nrz",
  "transactionHash": "0x5a4ab02add78c18598bef2334a1664000d5c040ac22f86d21931e7979411d984",
  "idempotentReplay": true
}
```

Same execution id, same transaction hash, no third transaction. This is the
half of exactly-once that KeeperHub provides, and it works exactly as
documented.

## What these transactions do NOT show

Honesty matters more than a clean story, and the execution status contradicts a
claim this project has been making.

Both executions came back `sponsored: true`, with
`topLevelTo: 0x5af5194b4b0909eb978e3cf1e25333852277f07d` — an address that is
neither the token nor the organization wallet. The calls were **relayed through
a sponsor**, not sent directly from the EOA.

That means **the consecutive-EOA-nonce claim is unverified here.** Under a
sponsored path the nonce that sequences these transactions may belong to the
relayer or a smart account, not to `0xE4a4…11a8`, and the platform may already
be serializing them. The firewall's lane lease still did its job at the
admission layer — one intent in flight at a time — but these two transactions
are not evidence that it prevented a nonce collision, because it is not
established that the two would have contended for the same nonce.

What remains fully demonstrated:

- `test/nonce-collision.test.ts` proves the collision in a real EVM for the
  direct-EOA path, which is what an agent does when it signs and broadcasts
  itself.
- `idempotentReplay: true` proves the retry half of exactly-once on the live API.
- The firewall's deterministic admission order held: it picked approve-2 first,
  which is what the intent hashes dictate and not what arrival order would have.

Establishing whether the sponsored path is exposed to nonce contention needs
either the raw transaction nonces from an explorer or a word from KeeperHub
about how sponsored sends are sequenced. Until then this project should not
claim it.

---

## The Lucid Agents settlement

A natively priced x402 offer settled through `src/lucid/settlement.ts`, keyed by
a Lucid-format payment identifier.

| | |
|---|---|
| Payment identifier / idempotency key | `pay_lucid0917settle01` |
| Transaction | [`0x7d8d4849…36780359`](https://sepolia.basescan.org/tx/0x7d8d48492ff9994b4950762b4be91ce5d068f79f5ae531b1b516865a36780359) |
| Value | 0.0000001 ETH → `0x000000000000000000000000000000000000bEEF` |
| Receipt | `verified: true`, `receiptStatus: success`, block 46952279, gas 49,803 |

Resent with the same identifier and an identical body:

```json
{ "executionId": "vvo8w7rcv76yxgb7slrsd", "idempotentReplay": true,
  "transactionHash": "0x7d8d4849…36780359" }
```

Same execution, same hash, no second transfer — which is what a retrying x402
buyer produces, and the reason the payment identifier is used as the key.

---

## The end-to-end run: settled by the Lucid agent itself

The settlements above were driven through the settler directly. This one was
executed by the **running Lucid agent** — an HTTP invoke of its paid entrypoint,
on an operator's machine, with `npm run verify:live`.

| | |
|---|---|
| Payment identifier / idempotency key | `pay_verify1789726271604` |
| Transaction | [`0x549b61b1…27ac6a5e`](https://sepolia.basescan.org/tx/0x549b61b1cd7727aea1bf9626d69d414dcc175d87baa8b1aaa202966227ac6a5e) |
| Value | 0.0000001 ETH → `0x000000000000000000000000000000000000bEEF` |
| Block | 46978993 |

All four checks, on an operator machine with a real key and real network:

```
  ok   Lucid serves its agent card  name=summarizer
  ok   Lucid rejects a malformed Idempotency-Key  invalid_idempotency_key
  ok   a valid key settles through KeeperHub  0x549b61b1…
  ok   the same key does not pay twice  same transaction, absorbed by Lucid's HTTP idempotency store

all four checks passed. The integration works end to end.
```

An earlier run of the same command settled
[`0x5305f18b…f7bc4ada`](https://sepolia.basescan.org/tx/0x5305f18b39f9be182f8316f93adf135f31a064ce2908fb56c946fb02f7bc4ada)
in block 46978818. Both are real; the run above is the one whose four checks
all passed.

The fourth line is the interesting one. The retry returned the same transaction
hash, but KeeperHub never saw it: Lucid's own HTTP idempotency store replayed its
recorded response first. The server log proves it — two requests, one
`[agent-kit:entrypoint] invoke`. See "Two layers of exactly-once" in
`docs/INTEGRATION.md`.

**This is the transaction to submit.** It is the one a judge can trace back to a
Lucid entrypoint invocation rather than to a script.
