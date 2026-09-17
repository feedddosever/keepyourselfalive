import type { SettlementCall } from "../keeperhub.js";

/**
 * The exact request body for `execute_contract_call`.
 *
 * Byte stability is a correctness requirement, not tidiness. KeeperHub binds an
 * idempotency key to the body it first saw: a retry whose body differs — even
 * cosmetically, `0.1` re-serialized as `0.10`, or a key renamed — returns
 * `idempotency_conflict` rather than replaying. The documented trap is that
 * rotating the key at that point escapes the in-flight guard and can broadcast a
 * second transaction. So the body must be rebuildable byte-for-byte from the
 * same intent, forever.
 *
 * That is why arguments must already be strings: a bigint or a float would be
 * serialized by whatever code path happened to run, and two paths can disagree.
 */
export function buildContractCallBody(call: SettlementCall): Record<string, string> {
  assertStable(call.args, "function_args");
  return {
    contract_address: call.contractAddress,
    chain_id: call.chainId.toString(10),
    function_name: call.functionName,
    function_args: JSON.stringify(call.args),
    abi: JSON.stringify(call.abi),
    // Sent verbatim: the API takes ether units as a string, and re-formatting it
    // here (0.1 as 0.10) is the documented way to break the idempotency binding.
    ...(call.value === undefined ? {} : { value: call.value }),
  };
}

function assertStable(value: unknown, where: string, path = ""): void {
  if (typeof value === "bigint") {
    throw new Error(
      `${where}${path}: bigint reached the request body. Serialize it to a decimal ` +
        "string before building the call, so a retry reproduces the same bytes.",
    );
  }
  if (typeof value === "number" && !Number.isInteger(value)) {
    throw new Error(
      `${where}${path}: non-integer number ${value} reached the request body. ` +
        "Floats re-serialize inconsistently; pass a decimal string instead.",
    );
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertStable(item, where, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertStable(item, where, `${path}.${key}`);
  }
}
