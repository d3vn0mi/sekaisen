import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
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
});
