import { createHash } from "node:crypto";

/**
 * SHA-256 over a canonical line list.
 *
 * Shared by the settlement idempotency key and intent identity so both derive
 * stable ids the same way: explicit lines, no JSON key-order ambiguity, and
 * nothing hashed that a retry would change.
 */
export function canonicalHash(lines: readonly string[]): string {
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}
