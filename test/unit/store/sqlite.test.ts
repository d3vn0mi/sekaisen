import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Definition } from "../../../src/format/types.js";
import { MIGRATIONS, SCHEMA_VERSION } from "../../../src/store/migrations.js";
import { openSqliteStore } from "../../../src/store/sqlite.js";
import type {
  NewStageRun,
  RunRow,
  StageRunRow,
  Store,
  StoreTx,
} from "../../../src/store/types.js";
import { turnKey } from "../../../src/store/types.js";

const def = { format: 1, id: "demo", version: 1 } as unknown as Definition;

const run = (over: Partial<RunRow> = {}): RunRow => ({
  runId: "r1",
  pipelineId: "demo",
  defHash: "h1",
  inputs: { topic: "x" },
  status: "working",
  currentStage: "draft",
  priority: 0,
  createdAt: 1000,
  updatedAt: 1000,
  endedAt: null,
  ...over,
});

const stageRun = (over: Partial<NewStageRun> = {}): NewStageRun => ({
  stageRunId: "s1",
  runId: "r1",
  stage: "draft",
  attempt: 1,
  visit: 1,
  retryIndex: 0,
  state: "submitted",
  tokenHash: null,
  adapterRunId: null,
  sessionKey: null,
  turnsUsed: 0,
  dispatchSeq: 0,
  deadlineAt: null,
  createdAt: 1000,
  startedAt: null,
  endedAt: null,
  outcome: null,
  fields: null,
  progressNote: null,
  progressAt: null,
  progressSeq: null,
  dispatchedAt: null,
  heldSince: null,
  runtime: null,
  waitReason: null,
  wakeAt: null,
  ...over,
});

const seed = (t: StoreTx, over: Partial<RunRow> = {}) => {
  t.putDefinition({
    pipelineId: "demo",
    hash: "h1",
    version: 1,
    parsed: def,
    briefs: { "briefs/a.md": "A" },
    loadedAt: 1,
  });
  t.insertRun(run(over));
};

const dirs: string[] = [];
const tmpFile = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sekaisen-store-"));
  dirs.push(dir);
  return path.join(dir, "engine.sqlite");
};
const stores: Store[] = [];
const open = (p: string | ":memory:" = ":memory:", o = {}) => {
  const s = openSqliteStore(p, o);
  stores.push(s);
  return s;
};

afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {
      // already closed by the test
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("compare-and-set", () => {
  it("CAS update loses the race", () => {
    const store = open();
    store.tx((t) => {
      seed(t);
      t.insertStageRun(stageRun());
    });
    const expect1 = { status: "working", currentStage: "draft" } as const;
    store.tx((t) => {
      expect(t.updateRunIf("r1", expect1, { currentStage: "review" })).toBe(
        true,
      );
      expect(t.updateRunIf("r1", expect1, { currentStage: "other" })).toBe(
        false,
      );
      expect(t.getRun("r1")?.currentStage).toBe("review");
      const e = { state: "submitted", attempt: 1 } as const;
      expect(t.updateStageRunIf("s1", e, { state: "working" })).toBe(true);
      expect(t.updateStageRunIf("s1", e, { state: "failed" })).toBe(false);
      expect(
        t.updateStageRunIf(
          "s1",
          { state: "working", attempt: 2 },
          { state: "failed" },
        ),
      ).toBe(false);
      expect(t.getStageRun("s1")?.state).toBe("working");
    });
  });

  it("refuses an empty or unknown patch", () => {
    const store = open();
    store.tx((t) => {
      seed(t);
      const e = { status: "working", currentStage: "draft" } as const;
      expect(() => t.updateRunIf("r1", e, {})).toThrow(/no columns/);
      expect(() => t.updateRunIf("r1", e, { runId: "x" } as never)).toThrow(
        /cannot update/,
      );
    });
  });
});

describe("transactions", () => {
  it("tx rolls back on throw", () => {
    const store = open();
    expect(() =>
      store.tx((t) => {
        seed(t);
        t.appendTransition({
          runId: "r1",
          stageRunId: null,
          fromState: null,
          toState: "working",
          event: "created",
          outcome: null,
          actor: "engine",
          at: 1,
          detail: null,
        });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    store.tx((t) => {
      expect(t.getRun("r1")).toBeUndefined();
      expect(t.transitions("r1")).toEqual([]);
    });
  });

  it("nested tx joins the outer transaction", () => {
    const store = open();
    expect(() =>
      store.tx((t) => {
        seed(t);
        store.tx((inner) => {
          inner.updateRunIf(
            "r1",
            { status: "working", currentStage: "draft" },
            { priority: 5 },
          );
        });
        expect(t.getRun("r1")?.priority).toBe(5);
        throw new Error("outer fails");
      }),
    ).toThrow("outer fails");
    store.tx((t) => expect(t.getRun("r1")).toBeUndefined());
  });

  it("rejects an async body and rolls back", () => {
    const store = open();
    expect(() =>
      // @ts-expect-error a Promise-returning body is a type error
      store.tx(async (t) => {
        seed(t);
      }),
    ).toThrow(/synchronous/);
    store.tx((t) => expect(t.getRun("r1")).toBeUndefined());
  });

  it("transitions are append-only", () => {
    const store = open();
    store.tx((t) => {
      const names = Object.getOwnPropertyNames(Object.getPrototypeOf(t)).filter(
        (n) => /transition/i.test(n),
      );
      expect(names.sort()).toEqual(["appendTransition", "transitions"]);
      // @ts-expect-error there is no way to change a transition
      void t.updateTransition;
      // @ts-expect-error there is no way to remove a transition
      void t.deleteTransition;
    });
  });

  it("returns ascending ids and the latest rows under a limit", () => {
    const store = open();
    store.tx((t) => {
      seed(t);
      for (let i = 0; i < 5; i++) {
        t.appendTransition({
          runId: "r1",
          stageRunId: null,
          fromState: null,
          toState: "working",
          event: `e${i}`,
          outcome: null,
          actor: "engine",
          at: i,
          detail: { i },
        });
      }
      expect(t.transitions("r1").map((r) => r.event)).toEqual([
        "e0",
        "e1",
        "e2",
        "e3",
        "e4",
      ]);
      const last = t.transitions("r1", 2);
      expect(last.map((r) => r.event)).toEqual(["e3", "e4"]);
      expect(last[1]?.detail).toEqual({ i: 4 });
    });
  });
});

describe("persistence", () => {
  it("reopen keeps data and WAL mode", () => {
    const file = tmpFile();
    const a = open(file);
    a.tx((t) => seed(t));
    a.close();
    const b = open(file);
    b.tx((t) => expect(t.getRun("r1")?.inputs).toEqual({ topic: "x" }));
    b.close();
    const raw = new DatabaseSync(file);
    expect(raw.prepare("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
    expect(
      raw.prepare("SELECT value FROM meta WHERE key='schema_version'").get(),
    ).toEqual({ value: String(SCHEMA_VERSION) });
    expect(
      raw.prepare("SELECT value FROM meta WHERE key='engine_version'").get(),
    ).toEqual({ value: "0.0.0" });
    raw.close();
  });

  it("schema_version mismatch refuses to open", () => {
    const file = tmpFile();
    open(file).close();
    const raw = new DatabaseSync(file);
    const newer = SCHEMA_VERSION + 1;
    raw.exec(`UPDATE meta SET value='${newer}' WHERE key='schema_version'`);
    raw.close();
    const message = `store schema ${newer} is newer than this engine (${SCHEMA_VERSION})`;
    expect(() => openSqliteStore(file)).toThrow(message);
    expect(() => openSqliteStore(file, { readonly: true })).toThrow(message);
  });

  it("read-only opens read but never write", () => {
    const file = tmpFile();
    const w = open(file);
    w.tx((t) => seed(t));
    const r = open(file, { readonly: true });
    r.tx((t) => expect(t.getRun("r1")?.runId).toBe("r1"));
    expect(() =>
      r.tx((t) =>
        t.updateRunIf(
          "r1",
          { status: "working", currentStage: "draft" },
          { priority: 9 },
        ),
      ),
    ).toThrow(/readonly/i);
    expect(() =>
      openSqliteStore(`${file}.missing`, { readonly: true }),
    ).toThrow(/does not exist/);
  });
});

describe("rows", () => {
  it("round-trips every row type", () => {
    const store = open();
    store.tx((t) => {
      seed(t);
      expect(t.getDefinition("demo", "h1")?.parsed).toEqual(def);
      expect(t.getDefinition("demo", "h1")?.briefs).toEqual({
        "briefs/a.md": "A",
      });
      t.putDefinition({
        pipelineId: "demo",
        hash: "h1",
        version: 9,
        parsed: def,
        briefs: {},
        loadedAt: 99,
      });
      expect(t.getDefinition("demo", "h1")?.loadedAt).toBe(1);

      const sr = stageRun({
        fields: { a: [1] },
        runtime: { provider: "p", model: "m" },
        waitReason: "gate",
        progressNote: "half",
      });
      t.insertStageRun(sr);
      expect(t.getStageRun("s1")).toEqual({
        ...sr,
        idempotencyKey: "r1:draft:1",
      });

      t.upsertGate({
        stageRunId: "s1",
        kind: "operator",
        waitingOn: "operator",
        remindAt: 5,
        resolvedBy: null,
        resolvedAt: null,
        prompt: "ok?",
        outcomes: ["approve", "reject"],
        pollAt: null,
        pollFailures: 0,
        pollError: null,
      });
      t.upsertGate({
        stageRunId: "s1",
        kind: "operator",
        waitingOn: "operator",
        remindAt: 9,
        resolvedBy: "operator",
        resolvedAt: 8,
        prompt: "ok?",
        outcomes: ["approve", "reject"],
        pollAt: 12,
        pollFailures: 2,
        pollError: "boom",
      });
      expect(t.getGate("s1")).toMatchObject({
        pollAt: 12,
        pollFailures: 2,
        pollError: "boom",
        remindAt: 9,
        resolvedBy: "operator",
        outcomes: ["approve", "reject"],
      });
      expect(t.getGate("nope")).toBeUndefined();
    });
  });

  it("clears the token and finds by hash", () => {
    const store = open();
    store.tx((t) => {
      seed(t);
      t.insertStageRun(stageRun({ tokenHash: "abc" }));
      expect(t.findStageRunByTokenHash("abc")?.stageRunId).toBe("s1");
      t.updateStageRunIf(
        "s1",
        { state: "submitted", attempt: 1 },
        { tokenHash: null },
      );
      expect(t.findStageRunByTokenHash("abc")).toBeUndefined();
    });
  });

  it("lists runs and stage runs in queue order under a limit", () => {
    const store = open();
    store.tx((t) => {
      seed(t, { runId: "a", createdAt: 3 });
      t.insertRun(run({ runId: "b", createdAt: 1, priority: 0 }));
      t.insertRun(run({ runId: "c", createdAt: 2, priority: 5 }));
      t.insertRun(
        run({
          runId: "d",
          createdAt: 0,
          status: "completed",
          pipelineId: "demo",
        }),
      );
      const all = t.listRuns({ limit: 10 }).map((r) => r.runId);
      expect(all).toEqual(["c", "d", "b", "a"]);
      expect(t.listRuns({ status: ["working"], limit: 2 }).length).toBe(2);
      expect(
        t.listRuns({ status: ["completed"], pipelineId: "demo", limit: 9 }),
      ).toHaveLength(1);
      expect(t.listRuns({ pipelineId: "zzz", limit: 9 })).toEqual([]);

      t.insertStageRun(
        stageRun({
          stageRunId: "x2",
          runId: "a",
          createdAt: 20,
        }),
      );
      t.insertStageRun(
        stageRun({
          stageRunId: "x1",
          runId: "b",
          createdAt: 10,
          state: "working",
          dispatchedAt: 12,
          progressAt: 11,
          progressSeq: 1,
        }),
      );
      expect(t.getStageRun("x1")).toMatchObject({
        dispatchedAt: 12,
        progressAt: 11,
        progressSeq: 1,
      });
      expect(t.listStageRuns({ limit: 5 }).map((s) => s.stageRunId)).toEqual([
        "x1",
        "x2",
      ]);
      expect(
        t.listStageRuns({ inFlight: true, limit: 5 }).map((s) => s.stageRunId),
      ).toEqual(["x1"]);
      expect(
        t
          .listStageRuns({ inFlight: false, state: ["working"], limit: 5 })
          .map((s) => s.stageRunId),
      ).toEqual([]);
      expect(
        t.updateStageRunIf(
          "x1",
          { state: "working", attempt: 1 },
          {
            dispatchedAt: null,
          },
        ),
      ).toBe(true);
      expect(t.listStageRuns({ inFlight: true, limit: 5 })).toEqual([]);
      expect(
        t
          .listStageRuns({ state: ["submitted"], limit: 5 })
          .map((s) => s.stageRunId),
      ).toEqual(["x2"]);
      expect(t.liveStageRun("a")?.stageRunId).toBe("x2");
      expect(t.liveStageRun("c")).toBeUndefined();
    });
  });

  it("limits: active only, upsert, clear", () => {
    const store = open();
    store.tx((t) => {
      t.putLimit({
        scope: "provider",
        key: "p",
        pausedUntil: 100,
        reason: "r",
        setAt: 1,
      });
      t.putLimit({
        scope: "provider",
        key: "p",
        pausedUntil: 200,
        reason: "r2",
        setAt: 2,
      });
      t.putLimit({
        scope: "provider",
        key: "q",
        pausedUntil: 50,
        reason: "r",
        setAt: 1,
      });
      expect(t.listLimits(60)).toEqual([
        {
          scope: "provider",
          key: "p",
          pausedUntil: 200,
          reason: "r2",
          setAt: 2,
        },
      ]);
      t.clearLimit("provider", "p");
      expect(t.listLimits(0).map((l) => l.key)).toEqual(["q"]);
    });
  });

  it("a shorter limit never shortens a pause in force", () => {
    const store = open();
    const DAY = 86_400_000;
    store.tx((t) => {
      t.putLimit({
        scope: "provider",
        key: "p",
        pausedUntil: 5 * DAY,
        reason: "weekly",
        setAt: 1,
      });
      t.putLimit({
        scope: "provider",
        key: "p",
        pausedUntil: 2 + 3_600_000,
        reason: "hourly",
        setAt: 2,
      });
      expect(t.listLimits(0)).toEqual([
        {
          scope: "provider",
          key: "p",
          pausedUntil: 5 * DAY,
          reason: "weekly",
          setAt: 1,
        },
      ]);
    });
  });

  it("counts outcomes of completed runs and attempts across visits", () => {
    const store = open();
    store.tx((t) => {
      seed(t);
      const mk = (
        n: number,
        state: StageRunRow["state"],
        outcome: string | null,
      ) =>
        t.insertStageRun(
          stageRun({
            stageRunId: `s${n}`,
            attempt: n,
            state,
            outcome,
          }),
        );
      mk(1, "completed", "revise");
      mk(2, "failed", null);
      mk(3, "completed", "revise");
      mk(4, "completed", "approve");
      t.insertStageRun(
        stageRun({
          stageRunId: "o",
          stage: "other",
          state: "completed",
          outcome: "revise",
        }),
      );
      expect(t.countOutcome("r1", "draft", "revise")).toBe(2);
      expect(t.countOutcome("r1", "draft", "nope")).toBe(0);
      expect(t.countAttempts("r1", "draft")).toBe(4);
      expect(t.countAttempts("r1", "none")).toBe(0);
    });
  });

  it("enforces foreign keys", () => {
    const store = open();
    expect(() => store.tx((t) => t.insertRun(run()))).toThrow(/FOREIGN KEY/);
  });
});

describe("attempts, visits and turn keys", () => {
  it("turnKey is the base key first, then numbered", () => {
    expect(turnKey("r1:draft:1", 1)).toBe("r1:draft:1");
    expect(turnKey("r1:draft:1", 2)).toBe("r1:draft:1:2");
    expect(turnKey("r1:draft:1", 3)).toBe("r1:draft:1:3");
  });

  it("maxAttempt and countVisits follow the rows", () => {
    const store = open();
    store.tx((t) => {
      seed(t);
      expect(t.maxAttempt("r1", "draft")).toBe(0);
      expect(t.countVisits("r1", "draft")).toBe(0);
      const mk = (n: number, visit: number, retryIndex: number) =>
        t.insertStageRun(
          stageRun({
            stageRunId: `s${n}`,
            attempt: n,
            visit,
            retryIndex,
          }),
        );
      mk(1, 1, 0);
      mk(2, 1, 1);
      mk(3, 2, 0);
      expect(t.maxAttempt("r1", "draft")).toBe(3);
      expect(t.countVisits("r1", "draft")).toBe(2);
      expect(t.maxAttempt("r1", "other")).toBe(0);
    });
  });

  it("latestCompleted returns the newest completed attempt of a stage", () => {
    const store = open();
    store.tx((t) => {
      seed(t);
      expect(t.latestCompleted("r1", "draft")).toBeUndefined();
      const mk = (n: number, state: StageRunRow["state"], fields: unknown) =>
        t.insertStageRun(
          stageRun({ stageRunId: `s${n}`, attempt: n, state, fields }),
        );
      mk(1, "completed", { v: 1 });
      mk(2, "completed", { v: 2 });
      mk(3, "failed", { v: 3 });
      mk(4, "working", null);
      expect(t.latestCompleted("r1", "draft")?.fields).toEqual({ v: 2 });
      expect(t.latestCompleted("r1", "other")).toBeUndefined();
    });
  });

  it("derives the idempotency key and round-trips the ending", () => {
    const store = open();
    store.tx((t) => {
      seed(t);
      t.insertStageRun(stageRun({ attempt: 3, ending: "usage_limited" }));
      const row = t.getStageRun("s1");
      expect(row?.idempotencyKey).toBe("r1:draft:3");
      expect(row?.ending).toBe("usage_limited");
      t.insertStageRun(stageRun({ stageRunId: "s2", attempt: 4 }));
      expect(t.getStageRun("s2")?.ending).toBeUndefined();
      expect(
        t.updateStageRunIf(
          "s2",
          { state: "submitted", attempt: 4 },
          {
            state: "failed",
            ending: "timeout",
          },
        ),
      ).toBe(true);
      expect(t.getStageRun("s2")?.ending).toBe("timeout");
    });
  });

  it("dispatchSeq can be bumped; attempt and key cannot", () => {
    const store = open();
    store.tx((t) => {
      seed(t);
      t.insertStageRun(stageRun());
      const e = { state: "submitted", attempt: 1 } as const;
      expect(t.updateStageRunIf("s1", e, { dispatchSeq: 1 })).toBe(true);
      expect(t.getStageRun("s1")?.dispatchSeq).toBe(1);
      for (const key of ["attempt", "visit", "retryIndex", "idempotencyKey"]) {
        expect(() =>
          t.updateStageRunIf("s1", e, { [key]: 9 } as never),
        ).toThrow(/cannot update/);
      }
      expect(() =>
        t.updateStageRunIf("s1", e, { toString: 1 } as never),
      ).toThrow(/cannot update/);
    });
  });

  it("rejects a duplicate idempotency key", () => {
    const store = open();
    expect(() =>
      store.tx((t) => {
        seed(t);
        t.insertStageRun(stageRun());
        t.insertStageRun(stageRun({ stageRunId: "s2" }));
      }),
    ).toThrow(/UNIQUE/);
  });

  it("keys the cancel action by run, once", () => {
    const store = open();
    store.tx((t) => {
      seed(t);
      t.insertStageRun(stageRun({ stage: "undo" }), { cancelAction: true });
      expect(t.getStageRun("s1")?.idempotencyKey).toBe("r1:cancel");
      expect(() =>
        t.insertStageRun(stageRun({ stageRunId: "s2", attempt: 2 }), {
          cancelAction: true,
        }),
      ).toThrow(/UNIQUE/);
    });
  });
});

describe("wake times", () => {
  it("lists due stage runs by wake time and agent rows without one", () => {
    const store = open();
    store.tx((t) => {
      seed(t);
      t.insertStageRun(stageRun({ stageRunId: "a", stage: "a", createdAt: 1 }));
      t.insertStageRun(
        stageRun({ stageRunId: "late", stage: "w1", wakeAt: 50, createdAt: 2 }),
      );
      t.insertStageRun(
        stageRun({ stageRunId: "soon", stage: "w2", wakeAt: 10, createdAt: 3 }),
      );
      t.insertStageRun(
        stageRun({
          stageRunId: "later",
          stage: "w3",
          wakeAt: 90,
          createdAt: 4,
        }),
      );
      const ids = (rows: StageRunRow[]) => rows.map((r) => r.stageRunId);
      expect(ids(t.listStageRuns({ wakeBy: 50, limit: 10 }))).toEqual([
        "soon",
        "late",
      ]);
      expect(ids(t.listStageRuns({ wakes: false, limit: 10 }))).toEqual(["a"]);
      expect(
        t.updateStageRunIf(
          "soon",
          { state: "submitted", attempt: 1 },
          {
            wakeAt: null,
          },
        ),
      ).toBe(true);
      expect(ids(t.listStageRuns({ wakeBy: 100, limit: 10 }))).toEqual([
        "late",
        "later",
      ]);
    });
  });
});

describe("guards", () => {
  it("lists need a positive integer limit", () => {
    const store = open();
    store.tx((t) => {
      for (const limit of [0, -1, 1.5, Number.NaN]) {
        expect(() => t.listRuns({ limit })).toThrow(
          "limit must be a positive integer",
        );
        expect(() => t.listStageRuns({ limit })).toThrow(
          "limit must be a positive integer",
        );
        expect(() => t.transitions("r1", limit)).toThrow(
          "limit must be a positive integer",
        );
      }
    });
  });

  it("StoreTx calls outside a transaction throw", () => {
    const store = open();
    let leaked: StoreTx | undefined;
    store.tx((t) => {
      leaked = t;
    });
    expect(() => leaked?.getRun("r1")).toThrow(/inside a transaction/);
  });

  it("an in-memory store cannot be read-only", () => {
    expect(() => openSqliteStore(":memory:", { readonly: true })).toThrow(
      /in-memory/,
    );
  });

  it("a read-only open leaves the files untouched", () => {
    const file = tmpFile();
    const w = open(file);
    w.tx((t) => seed(t));
    w.close();
    const dir = path.dirname(file);
    const snapshot = () =>
      // A WAL reader needs -wal/-shm beside the file; the database itself
      // must not change.
      readdirSync(dir)
        .filter((n) => n === path.basename(file))
        .map((n) => {
          const st = statSync(path.join(dir, n));
          return [n, st.size, st.mtimeMs];
        });
    const before = snapshot();
    const r = openSqliteStore(file, { readonly: true });
    r.tx((t) => expect(t.getRun("r1")?.runId).toBe("r1"));
    r.close();
    expect(snapshot()).toEqual(before);
  });

  it("two opens of a new file migrate once", () => {
    const file = tmpFile();
    const a = open(file);
    const b = open(file);
    a.tx((t) => seed(t));
    b.tx((t) => expect(t.getRun("r1")?.runId).toBe("r1"));
  });
});
