import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deriveToken,
  hashesEqual,
  hashToken,
} from "../../../src/engine/tokens.js";

describe("tokens", () => {
  it("hashes a token with SHA-256, as hex", () => {
    const token = deriveToken(new Uint8Array(32).fill(7), "r_1:draft:1");
    expect(hashToken(token)).toBe(
      createHash("sha256").update(token).digest("hex"),
    );
  });

  it("compares hashes, including ones of different length", () => {
    const hash = hashToken("a-token");
    expect(hashesEqual(hashToken("a-token"), hash)).toBe(true);
    expect(hashesEqual(hashToken("other"), hash)).toBe(false);
    expect(hashesEqual("abc", hash)).toBe(false);
  });

  it("derives one token per idempotency key from a secret", () => {
    const secret = new Uint8Array(32).fill(7);
    const token = deriveToken(secret, "r_1:draft:1");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).toBe(
      createHmac("sha256", secret)
        .update("sekaisen-token-v1\0r_1:draft:1")
        .digest("base64url"),
    );
    expect(deriveToken(secret, "r_1:draft:1")).toBe(token);
    expect(deriveToken(secret, "r_1:draft:2")).not.toBe(token);
    expect(deriveToken(new Uint8Array(32).fill(8), "r_1:draft:1")).not.toBe(
      token,
    );
  });
});
