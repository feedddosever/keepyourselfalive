const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Lowercases an EVM address after validating it. Every map key, sort key and
 * idempotency input uses this form, so `0xAbC…` and `0xabc…` can never produce
 * two different settlement plans for the same set of tips.
 */
export function normalizeAddress(value: string): string {
  if (!ADDRESS_RE.test(value)) {
    throw new Error(`not an EVM address: ${JSON.stringify(value)}`);
  }
  return value.toLowerCase();
}
