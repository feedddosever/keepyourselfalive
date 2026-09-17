# Friction report: zero to first transaction

Kept live while building, not reconstructed afterwards. Ordered by how much time
each cost, worst first.

Environment note: this was built in a sandbox where `docs.keeperhub.com`,
`keeperhub.com` and `app.keeperhub.com` were all unreachable (egress policy) and
no API key was available. That is an unusual constraint, but it turned out to be
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

## 2. `@keeperhub/mcp` ships no tool schemas

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

## 4. Two key types, one of which silently is not the one you want

`kh_` (organization, Settings → API Keys → Organisation) works for MCP and REST.
`wfb_` (user) works only for webhook triggers. The SDK carries a dedicated
`WFB_KEY_NOT_FOR_MCP_MESSAGE` constant, which means enough people have hit this
that it earned an error string.

**Fix:** if it needs a bespoke error constant, it needs to be one sentence at the
top of the quickstart — "there are two kinds of key and you want the `kh_` one" —
rather than a message you meet after the first failure.

## 5. `simulate: true` is EVM-only, and the failure arrives late

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
