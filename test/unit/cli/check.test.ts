import path from "node:path";
import { describe, expect, test } from "vitest";
import { main } from "../../../src/cli/main.js";
import { FIXTURE } from "../checks/helpers.js";

const GOOD = path.join(FIXTURE, "pipeline.yaml");
const BAD = path.resolve("test/fixtures/defs/unbounded/pipeline.yaml");

async function cli(...argv: string[]) {
  let out = "";
  let err = "";
  const code = await main(argv, {
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
  });
  return { code, out, err, lines: out.trimEnd().split("\n") };
}

describe("sekaisen check", () => {
  test("a clean file exits 0 and ends with the summary", async () => {
    const r = await cli("check", GOOD);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toBe(`${GOOD}: info policy providers: fleet`);
    expect(r.lines.at(-1)).toBe("check: 0 errors, 0 warnings");
  });

  test("a broken file exits 1 and names the finding", async () => {
    const r = await cli("check", BAD);
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      `${BAD}: error termination [a] cycle a → b → a is unbounded`,
    );
    expect(r.lines.at(-1)).toBe("check: 1 errors, 0 warnings");
  });

  test("unregistered host names are warnings without a host", async () => {
    const r = await cli(
      "check",
      path.resolve("test/fixtures/defs/hosted/pipeline.yaml"),
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "warning references [c] check demo.ready is not registered by the host",
    );
    expect(r.lines.at(-1)).toBe("check: 0 errors, 1 warnings");
  });

  test("--json prints an array of findings with their file", async () => {
    const r = await cli("check", "--json", BAD);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toContainEqual({
      file: BAD,
      check: "termination",
      severity: "error",
      stage: "a",
      message: "cycle a → b → a is unbounded",
    });
  });

  test("usage errors exit 2", async () => {
    expect((await cli("check")).code).toBe(2);
    expect((await cli("check", "--nope", GOOD)).code).toBe(2);
    const r = await cli("frobnicate");
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown command: frobnicate");
    expect((await cli()).code).toBe(2);
  });

  test("--help prints usage and exits 0", async () => {
    const r = await cli("--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("usage: sekaisen");
  });
});
