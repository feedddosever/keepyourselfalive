import { describe, expect, it } from "vitest";
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  McpKeeperHubClient,
  parseError,
  type CallToolCapable,
} from "../src/adapters/mcp.js";
import { normalizeState, type SettlementCall } from "../src/keeperhub.js";

/** Captured verbatim from a live execute_contract_call dry run. */
const INSUFFICIENT_BALANCE = `API call failed: 400 Bad Request - {"success":false,"status":"simulated","from":"0xe4a475d134bb72ff8045ea4e4c762174408311a8","to":"0x4200000000000000000000000000000000000006","value":"100000000000","failureKind":"validation","wouldRevert":true,"revertReason":"Insufficient BASE balance. Have: 0.0, Need: 0.0000001.","error":"Insufficient BASE balance.","code":"insufficient_balance","balanceWei":"0"}

Simulation preflight failed. Nothing was signed or broadcast.`;

const CALL: SettlementCall = {
  network: "84532",
  chainId: 84532,
  contractAddress: "0x4200000000000000000000000000000000000006",
  functionName: "deposit",
  args: [],
  abi: [{ type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] }],
};

function client(callTool: CallToolCapable["callTool"]): McpKeeperHubClient {
  return new McpKeeperHubClient({ apiKey: "kh_test", transport: { callTool } });
}

function thrower(message: string): CallToolCapable["callTool"] {
  return async () => {
    throw new Error(message);
  };
}

describe("parseError", () => {
  it("pulls the machine-readable code out of the error text", () => {
    expect(parseError(new Error(INSUFFICIENT_BALANCE)).code).toBe("insufficient_balance");
  });

  it("degrades to the raw message when there is no JSON body", () => {
    expect(parseError(new Error("socket hang up")).message).toBe("socket hang up");
  });
});

describe("simulate", () => {
  it("reports a failed dry run instead of surfacing the HTTP 400 as a crash", async () => {
    const result = await client(thrower(INSUFFICIENT_BALANCE)).simulate(CALL);
    expect(result.ok).toBe(false);
    expect(result.revertReason).toMatch(/Insufficient BASE balance/);
    expect(result.via).toBe("keeperhub");
  });

  it("still rethrows a genuine transport failure", async () => {
    await expect(client(thrower("ECONNRESET")).simulate(CALL)).rejects.toThrow(/ECONNRESET/);
  });

  it("treats wouldRevert in a successful response as a rejection", async () => {
    const result = await client(async () => ({ wouldRevert: true, revertReason: "ERC20: balance" })).simulate(CALL);
    expect(result.ok).toBe(false);
  });

  it("passes simulate: true and the snake_case body", async () => {
    let seen: Record<string, unknown> = {};
    await client(async (_name, args) => {
      seen = args;
      return {};
    }).simulate(CALL);
    expect(seen.simulate).toBe(true);
    expect(seen.contract_address).toBe(CALL.contractAddress);
    expect(seen.chain_id).toBe("84532");
  });
});

describe("idempotency failures", () => {
  it("surfaces in-progress as retryable under the same key", async () => {
    const failing = thrower('400 - {"code":"idempotency_in_progress","retryable":true}');
    await expect(client(failing).execute(CALL, "key-1")).rejects.toBeInstanceOf(IdempotencyInProgressError);
  });

  it("refuses to treat a body conflict as a reason to rotate the key", async () => {
    const failing = thrower('409 - {"code":"idempotency_conflict","retryable":false,"error":"body mismatch"}');
    await expect(client(failing).execute(CALL, "key-1")).rejects.toThrow(
      /Rotating the key here can broadcast a second transaction/,
    );
    await expect(client(failing).execute(CALL, "key-1")).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("carries the idempotency key through to the tool", async () => {
    let seen: Record<string, unknown> = {};
    await client(async (_name, args) => {
      seen = args;
      return { executionId: "exec-1" };
    }).execute(CALL, "key-abc");
    expect(seen.idempotency_key).toBe("key-abc");
    expect(seen.simulate).toBeUndefined();
  });
});

describe("execution status", () => {
  it("keeps polling an unconfirmed transaction rather than re-sending it", () => {
    // unconfirmed means already on chain; re-sending would reuse the nonce.
    expect(normalizeState("unconfirmed")).toBe("pending");
    expect(normalizeState("running")).toBe("pending");
    expect(normalizeState("completed")).toBe("confirmed");
    expect(normalizeState("failed")).toBe("failed");
  });

  it("reads the transaction hash and link off a completed execution", async () => {
    const status = await client(async () => ({
      status: "completed",
      transactionHash: "0xabc",
      transactionLink: "https://sepolia.basescan.org/tx/0xabc",
    })).status("exec-1");
    expect(status).toMatchObject({ state: "confirmed", txHash: "0xabc" });
  });
});
