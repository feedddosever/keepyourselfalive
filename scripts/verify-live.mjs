/**
 * One command that proves the whole integration end to end.
 *
 * Boots the real Lucid agent, then drives four checks against it:
 *   1. Lucid serves its agent card
 *   2. Lucid rejects a malformed Idempotency-Key before the handler runs
 *   3. A valid key settles through KeeperHub and returns a verified receipt
 *   4. The same key replays — same transaction, nothing new on chain
 *
 * Needs KH_API_KEY and network access to app.keeperhub.com. Run it once before
 * recording; paste the output if anything fails.
 */
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT ?? 3210);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = process.env.VERIFY_KEY ?? `pay_verify${Date.now()}`;

if (!process.env.KH_API_KEY && !process.env.KEEPERHUB_API_KEY) {
  console.error("KH_API_KEY is not set. Export your kh_ organization key and re-run.");
  process.exit(2);
}
if (KEY.length < 20 || KEY.length > 256) {
  console.error(`VERIFY_KEY must be 20-256 characters (Lucid's rule); got ${KEY.length}`);
  process.exit(2);
}

const results = [];
let failed = false;

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed = true;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? `  ${detail}` : ""}`);
}

const server = spawn("npx", ["tsx", "examples/lucid-agent/server.ts"], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForListen(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/.well-known/agent-card.json`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}

async function invoke(idempotencyKey, text) {
  const res = await fetch(`${BASE}/entrypoints/summarize/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ text }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

try {
  console.log(`\nverifying the Lucid × KeeperHub integration on ${BASE}\n`);

  if (!(await waitForListen())) {
    console.error("the agent never started listening. server output:\n" + serverLog);
    process.exit(1);
  }

  const card = await (await fetch(`${BASE}/.well-known/agent-card.json`)).json();
  check(
    "Lucid serves its agent card",
    card?.skills?.some((s) => s.id === "summarize"),
    `name=${card?.name}`,
  );

  const short = await invoke("tooshort", "hi");
  check(
    "Lucid rejects a malformed Idempotency-Key",
    short.body?.error?.code === "invalid_idempotency_key",
    short.body?.error?.code ?? `http ${short.status}`,
  );

  const first = await invoke(KEY, "KeeperHub settles what Lucid admits.");
  const settlement = first.body?.settlement ?? first.body?.output?.settlement;
  check(
    "a valid key settles through KeeperHub",
    Boolean(settlement?.txHash),
    settlement?.txHash ?? JSON.stringify(first.body).slice(0, 200),
  );

  if (settlement?.txHash) {
    const second = await invoke(KEY, "KeeperHub settles what Lucid admits.");
    const replay = second.body?.settlement ?? second.body?.output?.settlement;
    check(
      "the same key replays instead of paying twice",
      replay?.txHash === settlement.txHash && replay?.replayed === true,
      `replayed=${replay?.replayed} sameHash=${replay?.txHash === settlement.txHash}`,
    );

    console.log(`\n  transaction  ${settlement.txLink ?? settlement.txHash}`);
    console.log(`  identifier   ${KEY}`);
    if (settlement.blockNumber) console.log(`  block        ${settlement.blockNumber}`);
  }

  console.log(
    failed
      ? "\nsomething failed above. Paste this whole output, including the server log below.\n"
      : "\nall four checks passed. The integration works end to end.\n",
  );
  if (failed) console.log("--- server log ---\n" + serverLog);
} finally {
  server.kill();
}

process.exit(failed ? 1 : 0);
