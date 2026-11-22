import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Shortest secret `deriveToken` accepts, in bytes. */
export const MIN_TOKEN_SECRET_BYTES = 32;

/**
 * The completion token of one attempt (43 characters of base64url): the
 * same secret and idempotency key always give the same token, so a turn
 * resent after a restart carries the token the first one did.
 */
export function deriveToken(
  secret: Uint8Array,
  idempotencyKey: string,
): string {
  return createHmac("sha256", secret)
    .update(`sekaisen-token-v1\0${idempotencyKey}`)
    .digest("base64url");
}

/** Constant-time comparison of two hex hashes. */
export function hashesEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
