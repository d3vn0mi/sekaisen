import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deriveToken,
  hashesEqual,
  hashToken,
  mintToken,
} from "../../../src/engine/tokens.js";

describe("tokens", () => {
  it("mints a 43 character base64url token and its SHA-256 hash", () => {
    const { token, hash } = mintToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(hashToken(token)).toBe(hash);
  });

  it("mints a different token each time", () => {
    expect(mintToken().token).not.toBe(mintToken().token);
  });

  it("compares hashes, including ones of different length", () => {
    const { token, hash } = mintToken();
    expect(hashesEqual(hashToken(token), hash)).toBe(true);
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
