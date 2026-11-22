import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

function suffix(): string {
  // 12 characters of 5 bits each; the 32-letter alphabet divides 256 evenly.
  let out = "";
  for (const byte of randomBytes(12)) out += ALPHABET[byte & 31];
  return out;
}

export const newRunId = (): string => `r_${suffix()}`;
export const newStageRunId = (): string => `s_${suffix()}`;
