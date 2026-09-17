# Friction report: zero to first transaction

Kept live while building, not reconstructed afterwards. Ordered by how much time
each cost, worst first.

Environment note: the first pass was built in a sandbox where
`docs.keeperhub.com`, `keeperhub.com` and `app.keeperhub.com` were all
unreachable (egress policy) and no API key was available. The MCP server was
connected later, which turned several reconstructed guesses into verified
findings — entries 2, 2b and 2c below are what that comparison produced. That is an unusual constraint, but it turned out to be
a useful one — it surfaced exactly which parts of onboarding depend on a human
reading a website, which is precisely the part an *agent* integrating KeeperHub
cannot do.

---

## 1. The two official surfaces disagree on the safety-critical features

This is the big one, and it is checkable in thirty seconds:

```
$ grep -rniE 'idempot|simulat|dry.?run' node_modules/@keeperhub/sdk/
$ grep -rniE 'idempot|simulat|dry.?run' node_modules/@keeperhub/mcp/
```

Both return nothing. `@keeperhub/sdk@0.1.1`'s `DirectContractCallInput` has
`contractAddress`, `network`, `functionName`, `functionArgs`, `abi`, `value` and
`gasLimitMultiplier` — **no `simulate`, no `idempotency_key`.** Yet the
documented agent pattern is `execute_contract_call` with `simulate: true`, then
with `idempotency_key`, then `get_direct_execution_status`.

So the exactly-once story is reachable through MCP and not through the official
REST SDK. A builder who picks the SDK — the one named "Official REST SDK", the
obvious choice for a backend service — silently loses both the preflight and the
duplicate-broadcast guarantee, and nothing in the types tells them so. For an
agent moving money on a schedule, that is the difference between paying a creator
once and paying them twice.

**Cost:** the whole execution layer had to be built twice, once per transport
(`src/adapters/rest.ts`, `src/adapters/mcp.ts`), with the REST path degrading to a
local `eth_call` preflight and ledger-only idempotency.

**Fix:** either add `simulate` and `idempotencyKey` to `DirectContractCallInput`,
or say plainly in the SDK README that exactly-once execution requires the MCP
surface. The silent version of this is the dangerous one.

## 2. The two official surfaces name the same fields differently

Once the MCP server was connected, the reconstructed argument keys turned out to
be wrong — and wrong in a way no amount of care would have avoided, because the
two surfaces genuinely disagree:

| Field | `@keeperhub/sdk` (REST) | `execute_contract_call` (MCP) |
|---|---|---|
| target | `contractAddress` | `contract_address` |
| chain | `network` | `chain_id` |
| function | `functionName` | `function_name` |
| args | `functionArgs` | `function_args` |

camelCase with `network` on one, snake_case with `chain_id` on the other, for the
same call against the same platform. An integrator who reads the SDK types and
then moves to MCP for the features the SDK lacks — which is the documented path
for anything needing `simulate` or `idempotency_key` — has to rename every field.

**Fix:** accept both spellings on the MCP tool, or note the mapping in the SDK
README. This one is cheap to fix and costs everybody who hits it an hour.

## 2b. A failed dry run arrives as an HTTP 400, not a result

`execute_contract_call` with `simulate: true` returns its verdict *as an error*
when the call would revert. The body is excellent — `code`,
`failureKind`, `wouldRevert`, `revertReason`, `balanceWei`, `shortfallWei`, and a
"Next step" narrative — but it is delivered through the failure path.

Naive code wraps the call in try/catch, sees an exception, and treats a
successful preflight rejection as a transport error: it retries, or escalates, or
reports the integration as down. The correct handling is to parse the body and
branch on `code`. `src/adapters/mcp.ts` does, and `test/mcp-adapter.test.ts`
pins the behaviour against a verbatim captured response.

**Fix:** return `{ success: false, wouldRevert: true, ... }` with HTTP 200 for a
preflight that worked and found a problem. Reserve non-2xx for calls that did not
run. A dry run that correctly predicts a revert has succeeded at its job.

## 2c. The idempotency key is bound to the request body, and the trap is sharp

This is documented in the tool description and deserves to be louder:

> If it is the same intent you already sent, the body drifted rather than the
> intent — re-serializing `0.1` as `0.10`, or `network` for `chainId`, produces
> this — so rebuild the body to match the original and keep the key. **Rotating
> there escapes the in-flight guard and can broadcast a second transaction.**

So the natural recovery instinct — got a conflict, mint a fresh key, try again —
is the one action that can double-spend. And the trigger is cosmetic
serialization drift, which is invisible in review.

`src/adapters/body.ts` responds by making the body a pure function of the intent
and refusing any bigint or float before it can reach the wire; six tests cover
it. `IdempotencyConflictError` is deliberately fatal and says why in its message.

**Fix:** ship a body-canonicalization helper in the SDK. Every integrator is
re-deriving this, and the failure mode is silent duplicate payment.

## 3. `@keeperhub/mcp` ships no tool schemas

The package is a transport: `callTool(name, args)` with `args` typed as
`Record<string, unknown>`. The schemas live server-side behind `tools/list`,
which needs a `kh_` key and network access. An agent that cannot reach
`app.keeperhub.com` — or a developer writing code before provisioning a key —
has no way to learn the argument names for the one call that moves money.

**Cost:** `src/adapters/mcp.ts` is written against reconstructed argument keys and
is marked unverified at the top of the file.

**Fix:** generate the tool schemas into the package at build time, or publish them
as static JSON. Everything else about `@keeperhub/mcp` is well built — the lazy
session, the 401/404 re-init, the key classification — which makes the missing
schemas stand out more.

## 3. The npm types are better documentation than the docs site, and nothing says so

The single most useful onboarding artifact turned out to be
`node_modules/@keeperhub/sdk/dist/index.d.ts`: 298 lines, well commented, and it
answered every structural question — that `network` accepts `"base"` or `"8453"`,
that `functionArgs` is a JSON *string* rather than an array, that `abi` is
auto-fetched from the explorer when omitted, that read and write calls return
different shapes from the same method and need `isReadResult` to discriminate,
that `ExecutionStatus` has six states rather than three.

None of that is discoverable from a landing page, and a builder who starts at
the docs site does not know to go read the types.

**Fix:** link the `.d.ts` from the quickstart, and treat it as a first-class
onboarding surface. It is already doing the job; it just is not signposted.

## 5. Two key types, one of which silently is not the one you want

`kh_` (organization, Settings → API Keys → Organisation) works for MCP and REST.
`wfb_` (user) works only for webhook triggers. The SDK carries a dedicated
`WFB_KEY_NOT_FOR_MCP_MESSAGE` constant, which means enough people have hit this
that it earned an error string.

**Fix:** if it needs a bespoke error constant, it needs to be one sentence at the
top of the quickstart — "there are two kinds of key and you want the `kh_` one" —
rather than a message you meet after the first failure.

## 6. `simulate: true` is EVM-only, and the failure arrives late

`assertSimulationSupported` rejects Solana chain ids. A builder who chooses a
chain first and discovers the preflight is unavailable afterwards has to redesign
their safety story around it.

**Fix:** a per-chain capability matrix on the quickstart page, above the code
sample, not in the error.

---

## Proposed for the bounty

A `create-keeperhub-agent` starter whose first runnable example is a complete
exactly-once execution — simulate, broadcast with an idempotency key, poll, and a
durable record that survives a crash between broadcast and confirmation — rather
than a bare `execute_contract_call`. The loop in `src/settle.ts` plus
`src/ledger.ts` is that example, extracted from a real integration; the four
failure modes it covers are listed in the README table.
