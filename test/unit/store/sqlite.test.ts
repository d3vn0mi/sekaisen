import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Definition } from "../../../src/format/types.js";
import { SCHEMA_VERSION } from "../../../src/store/migrations.js";
import { openSqliteStore } from "../../../src/store/sqlite.js";
import type {
  RunRow,
  StageRunRow,
  Store,
  StoreTx,
} from "../../../src/store/types.js";

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

const stageRun = (over: Partial<StageRunRow> = {}): StageRunRow => ({
  stageRunId: "s1",
  runId: "r1",
  stage: "draft",
  attempt: 1,
  state: "submitted",
  tokenHash: null,
  idempotencyKey: "r1:draft:1",
  adapterRunId: null,
  sessionKey: null,
  turnsUsed: 0,
  deadlineAt: null,
  createdAt: 1000,
  startedAt: null,
  endedAt: null,
  outcome: null,
  fields: null,
  progressNote: null,
  runtime: null,
  waitReason: null,
  ...over,
});

const seed = (t: StoreTx, over: Partial<RunRow> = {}) => {
  t.putDefinition({
    pipelineId: "demo",
    hash: "h1",
    version: 1,
    parsed: def,
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
    raw.exec("UPDATE meta SET value='2' WHERE key='schema_version'");
    raw.close();
    expect(() => openSqliteStore(file)).toThrow(
      "store schema 2 is newer than this engine (1)",
    );
    expect(() => openSqliteStore(file, { readonly: true })).toThrow(
      "store schema 2 is newer than this engine (1)",
    );
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
      t.putDefinition({
        pipelineId: "demo",
        hash: "h1",
        version: 9,
        parsed: def,
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
      expect(t.getStageRun("s1")).toEqual(sr);

      t.upsertGate({
        stageRunId: "s1",
        kind: "operator",
        waitingOn: "operator",
        remindAt: 5,
        resolvedBy: null,
        resolvedAt: null,
        prompt: "ok?",
        outcomes: ["approve", "reject"],
      });
      t.upsertGate({
        stageRunId: "s1",
        kind: "operator",
        waitingOn: "operator",
        remindAt: 9,
        resolvedBy: "hud",
        resolvedAt: 8,
        prompt: "ok?",
        outcomes: ["approve", "reject"],
      });
      expect(t.getGate("s1")).toMatchObject({
        remindAt: 9,
        resolvedBy: "hud",
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
          idempotencyKey: "a:d:1",
          createdAt: 20,
        }),
      );
      t.insertStageRun(
        stageRun({
          stageRunId: "x1",
          runId: "b",
          idempotencyKey: "b:d:1",
          createdAt: 10,
          state: "working",
        }),
      );
      expect(t.listStageRuns({ limit: 5 }).map((s) => s.stageRunId)).toEqual([
        "x1",
        "x2",
      ]);
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
            idempotencyKey: `r1:draft:${n}`,
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
          idempotencyKey: "r1:other:1",
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
    expect(() => store.tx((t) => t.insertRun(run()))).toThrow();
  });
});
