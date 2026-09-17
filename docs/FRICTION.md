# Friction report: zero to first transaction

Kept live while building, not reconstructed afterwards. Ordered by how much time
each cost.

## 1. The docs are the first hard dependency and they are not mirrored anywhere

`docs.keeperhub.com` was unreachable from a sandboxed build environment (egress
policy). There is no offline copy of the tool schemas — not in the npm package,
not in the repo, not in a `llms.txt`. That turned the single most load-bearing
part of the integration, the exact parameter names for `execute_contract_call`,
into guesswork isolated behind an interface.

**Cost:** the entire execution path is written against a reconstructed schema.
**Fix that would have removed it:** ship the tool schemas inside the npm package,
or publish `llms.txt` / an OpenAPI document at a stable path. An agent building
against KeeperHub cannot read a docs site; it needs machine-readable schemas.

## 2. The idempotency key contract is subtle and stated only in prose

The rule that makes it work — *the nonce is deliberately not part of the key, so
a retry of the same intent reproduces it and KeeperHub replays the first
execution* — is the single most important sentence for anyone moving real money.
It is easy to miss, and getting it wrong pays a creator twice.

**Fix:** a `deriveIdempotencyKey(plan)` helper in the SDK, so the canonical form
is not re-implemented (differently) by every integrator. Failing that, a worked
example showing which fields are in and which are out, with the reasoning.

## 3. `simulate: true` is EVM-only, and the failure is late

`assertSimulationSupported` rejects Solana chain ids. A builder who picks a chain
first and discovers the preflight is unavailable afterwards has to redesign their
safety story.

**Fix:** state the per-chain capability matrix on the quickstart page, above the
code sample, not in the error.

## 4. Onboarding assumes a chain and a funded key before it assumes a plan

The fastest path to a first transaction still requires: pick a chain, find a
faucet, deploy or locate a target contract, then write the call. A
`create-keeperhub-agent` starter that ships a working cron → simulate → execute
loop against a pre-deployed testnet contract would move first-transaction time
from hours to minutes.

**Proposed for the bounty:** that starter template plus a quickstart whose first
code block is a complete, runnable, exactly-once execution — not a bare
`execute_contract_call`.
