import { afterEach, describe, expect, it } from "vitest";
import {
  stageCompleteTool,
  stageProgressTool,
} from "../../../src/completion/tools.js";
import { mintToken } from "../../../src/engine/tokens.js";
import { lastToken, type Rig, rig, variant } from "./engine-helpers.js";

const rigs: Rig[] = [];
async function make(): Promise<Rig> {
  const r = await rig();
  rigs.push(r);
  return r;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.engine.stop();
    r.store.close();
  }
});

/** Starts a run and dispatches its first stage; returns the run id and token. */
async function started(r: Rig): Promise<{ runId: string; token: string }> {
  const { runId } = await r.engine.startRun("review-loop", { topic: "rust" });
  await r.engine.tick();
  return { runId, token: lastToken(r.adapter) };
}

describe("stage_complete", () => {
  it("stage_complete advances to the next stage", async () => {
    const r = await make();
    const { runId, token } = await started(r);
    const result = await r.engine.complete({
      token,
      outcome: "drafted",
      fields: { pr_url: "https://example.test/pr/1", summary: "short" },
      callerAgent: "drafter",
    });
    expect(result).toEqual({ ok: true, next: "check", applied: "now" });
    const view = r.engine.status(runId);
    expect(view.run.currentStage).toBe("check");
    expect(view.live?.stage).toBe("check");
    expect(view.live?.state).toBe("submitted");
    const done = view.transitions.find((t) => t.event === "stage_completed");
    expect(done?.outcome).toBe("drafted");
    expect(done?.actor).toBe("agent:drafter");
    expect(done?.detail).toEqual({ next: "check" });

    // The next brief sees the earlier stage's fields.
    await r.engine.tick();
    expect(r.adapter.calls[1]?.agent).toBe("checker");
    expect(r.adapter.calls[1]?.message).toContain(
      "Check the draft for rust and pick an outcome.",
    );
    expect(r.adapter.calls[1]?.idempotencyKey).toBe(`${runId}:check:1`);
  });

  it("unknown outcome returns an error listing declared outcomes and leaves state unchanged", async () => {
    const r = await make();
    const { runId, token } = await started(r);
    const before = r.engine.status(runId);
    const result = await r.engine.complete({ token, outcome: "done" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/unknown outcome "done"/);
    expect(result.error).toContain(
      "- drafted (fields: pr_url: string, summary: string?)",
    );
    expect(result.error).toContain("- blocked (fields: reason: string)");
    expect(r.engine.status(runId)).toEqual(before);
  });

  it("wrong caller agent is refused", async () => {
    const r = await make();
    const { runId, token } = await started(r);
    const result = await r.engine.complete({
      token,
      outcome: "blocked",
      fields: { reason: "x" },
      callerAgent: "checker",
    });
    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/belongs to agent drafter.*not checker/),
    });
    expect(r.engine.status(runId).live?.state).toBe("working");
  });

  it("dead token from attempt 1 is refused after a retry", async () => {
    const r = await make();
    const { runId, token: first } = await started(r);
    // A retry, as the retry policy performs it: the old attempt ends failed
    // with its token retired and a new attempt row starts submitted.
    r.store.tx((t) => {
      const live = t.liveStageRun(runId);
      if (!live) throw new Error("no live row");
      t.updateStageRunIf(
        live.stageRunId,
        { state: "working", attempt: 1 },
        { state: "failed", ending: "no_result", tokenHash: null, endedAt: 1 },
      );
      t.insertStageRun({
        ...live,
        stageRunId: "s_retry",
        attempt: 2,
        retryIndex: 1,
        state: "submitted",
        tokenHash: null,
        adapterRunId: null,
        sessionKey: null,
        turnsUsed: 0,
        dispatchSeq: 0,
        deadlineAt: null,
        startedAt: null,
        dispatchedAt: null,
      });
    });
    await r.engine.tick();
    expect(r.adapter.calls[1]?.idempotencyKey).toBe(`${runId}:draft:2`);
    const stale = await r.engine.complete({
      token: first,
      outcome: "blocked",
      fields: { reason: "late" },
    });
    expect(stale).toEqual({
      ok: false,
      error: expect.stringMatching(/not live/),
    });
    expect(r.engine.status(runId).live?.stageRunId).toBe("s_retry");
    const fresh = await r.engine.complete({
      token: lastToken(r.adapter),
      outcome: "blocked",
      fields: { reason: "now" },
    });
    expect(fresh.ok).toBe(true);
  });

  it("a token of an ended attempt that kept its hash is refused and logged", async () => {
    const r = await make();
    const { runId, token } = await started(r);
    r.store.tx((t) => {
      const live = t.liveStageRun(runId);
      if (!live) throw new Error("no live row");
      t.updateStageRunIf(
        live.stageRunId,
        { state: "working", attempt: 1 },
        { state: "failed", ending: "turn_error" },
      );
    });
    const result = await r.engine.complete({
      token,
      outcome: "blocked",
      fields: { reason: "x" },
    });
    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/attempt has ended \(failed\)/),
    });
    const last = r.engine.status(runId).transitions.at(-1);
    expect([last?.event, last?.fromState, last?.toState]).toEqual([
      "completion_refused",
      "failed",
      "failed",
    ]);
  });

  it("a wrong caller is refused after the attempt completed", async () => {
    const r = await make();
    const { token } = await started(r);
    const params = { token, outcome: "blocked", fields: { reason: "x" } };
    await r.engine.complete({ ...params, callerAgent: "drafter" });
    for (const outcome of ["blocked", "drafted"]) {
      expect(
        await r.engine.complete({ ...params, outcome, callerAgent: "checker" }),
      ).toEqual({
        ok: false,
        error: "this stage belongs to agent drafter, not checker",
      });
    }
  });

  it("a wrong caller with a token of an ended attempt is still logged", async () => {
    const r = await make();
    const { runId, token } = await started(r);
    r.store.tx((t) => {
      const live = t.liveStageRun(runId);
      if (!live) throw new Error("no live row");
      t.updateStageRunIf(
        live.stageRunId,
        { state: "working", attempt: 1 },
        { state: "failed", ending: "turn_error" },
      );
    });
    const result = await r.engine.complete({
      token,
      outcome: "blocked",
      fields: { reason: "x" },
      callerAgent: "checker",
    });
    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/attempt has ended/),
    });
    const last = r.engine.status(runId).transitions.at(-1);
    expect([last?.event, last?.actor]).toEqual([
      "completion_refused",
      "agent:checker",
    ]);
  });

  it("an unknown token is refused", async () => {
    const r = await make();
    await started(r);
    const result = await r.engine.complete({
      token: mintToken().token,
      outcome: "blocked",
    });
    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/not live/),
    });
  });

  it("second stage_complete on the same attempt is idempotent", async () => {
    const r = await make();
    const { runId, token } = await started(r);
    const params = {
      token,
      outcome: "drafted",
      fields: { summary: "s", pr_url: "u" },
    };
    expect(await r.engine.complete(params)).toEqual({
      ok: true,
      next: "check",
      applied: "now",
    });
    const count = r.engine.status(runId).transitions.length;
    // Same outcome and fields, keys in another order.
    expect(
      await r.engine.complete({
        ...params,
        fields: { pr_url: "u", summary: "s" },
      }),
    ).toEqual({ ok: true, next: "check", applied: "already" });
    const view = r.engine.status(runId);
    expect(view.transitions).toHaveLength(count);
    expect(
      view.transitions.filter((t) => t.event === "stage_completed"),
    ).toHaveLength(1);
    expect(
      await r.engine.complete({
        token,
        outcome: "blocked",
        fields: { reason: "x" },
      }),
    ).toEqual({
      ok: false,
      error: "this stage was already completed with outcome drafted",
    });
    expect(
      await r.engine.complete({ ...params, fields: { pr_url: "other" } }),
    ).toEqual({
      ok: false,
      error: expect.stringMatching(/already completed .*other fields/),
    });
  });

  it("fields that are not an object are refused", async () => {
    const r = await make();
    const { runId, token } = await started(r);
    for (const fields of [["u"], "u", null, 3]) {
      const result = await r.engine.complete({
        token,
        outcome: "drafted",
        fields,
      });
      expect(result).toEqual({
        ok: false,
        error: expect.stringMatching(/fields must be an object/),
      });
    }
    expect(r.engine.status(runId).live?.state).toBe("working");
  });

  it("fields over 64 KiB are refused", async () => {
    const r = await make();
    const { runId, token } = await started(r);
    const result = await r.engine.complete({
      token,
      outcome: "drafted",
      fields: { pr_url: "x".repeat(64 * 1024) },
    });
    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/64 KiB/),
    });
    expect(r.engine.status(runId).live?.state).toBe("working");
  });

  it("fields that fail the outcome's schema are refused with the declared fields", async () => {
    const r = await make();
    const { token } = await started(r);
    const missing = await r.engine.complete({ token, outcome: "drafted" });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error).toMatch(/fields for outcome drafted/);
    expect(missing.error).toMatch(/pr_url/);
    expect(missing.error).toContain("pr_url: string, summary: string?");
    const extra = await r.engine.complete({
      token,
      outcome: "drafted",
      fields: { pr_url: "u", colour: "red" },
    });
    expect(extra.ok).toBe(false);
  });

  it("an outcome without declared fields accepts only an empty object", async () => {
    const r = await make();
    const { runId, token } = await started(r);
    await r.engine.complete({
      token,
      outcome: "drafted",
      fields: { pr_url: "u" },
    });
    await r.engine.tick();
    const check = lastToken(r.adapter);
    const extra = await r.engine.complete({
      token: check,
      outcome: "pass",
      fields: { note: "n" },
    });
    expect(extra).toEqual({
      ok: false,
      error: expect.stringMatching(/outcome pass declares no fields/),
    });
    expect(
      await r.engine.complete({ token: check, outcome: "pass", fields: {} }),
    ).toEqual({ ok: true, next: "publish", applied: "now" });
    expect(r.engine.status(runId).live?.stage).toBe("publish");
  });

  it("the completion records which branch it took: the guarded one, then the fallback", async () => {
    const r = await make();
    const { runId } = await r.engine.startRun("review-loop", { topic: "t" });
    for (let i = 0; i < 6; i++) {
      await r.engine.tick();
      const draft = i % 2 === 0;
      await r.engine.complete({
        token: lastToken(r.adapter),
        outcome: draft ? "drafted" : "fail",
        fields: draft ? { pr_url: "u" } : { findings: "f" },
      });
    }
    const checks = r.store
      .tx((t) => t.transitions(runId))
      .filter(
        (row) => row.event === "stage_completed" && row.outcome === "fail",
      );
    expect(checks.map((row) => row.detail)).toEqual([
      { next: "draft", branch: 0 },
      { next: "draft", branch: 0 },
      { next: "failed", branch: 1 },
    ]);
    // A plain next records no branch.
    const drafted = r.store
      .tx((t) => t.transitions(runId))
      .find((row) => row.outcome === "drafted");
    expect(drafted?.detail).toEqual({ next: "check" });
  });

  it("a guard counts the completion being applied", async () => {
    const r = await make();
    const { runId } = await r.engine.startRun("review-loop", { topic: "t" });
    const nexts: Array<string | null> = [];
    for (let i = 0; i < 6; i++) {
      await r.engine.tick();
      const draft = i % 2 === 0;
      const result = await r.engine.complete({
        token: lastToken(r.adapter),
        outcome: draft ? "drafted" : "fail",
        fields: draft ? { pr_url: "u" } : { findings: "f" },
      });
      if (result.ok) nexts.push(result.next);
    }
    expect(nexts).toEqual([
      "check",
      "draft",
      "check",
      "draft",
      "check",
      "failed",
    ]);
    const view = r.engine.status(runId);
    expect(view.run.status).toBe("failed");
    expect(view.run.currentStage).toBe("failed");
    expect(view.run.endedAt).not.toBeNull();
    // Attempts are cumulative across visits.
    expect(
      r.adapter.calls.map((c) => c.idempotencyKey.slice(runId.length)),
    ).toEqual([
      ":draft:1",
      ":check:1",
      ":draft:2",
      ":check:2",
      ":draft:3",
      ":check:3",
    ]);
  });

  it("a guard that cannot be evaluated fails the run and names the branch", async () => {
    const bad = await variant("bad-guard", (def) => {
      const check = def.stages.check;
      if (check?.type !== "agent") throw new Error("fixture changed");
      check.outcomes.fail = {
        ...check.outcomes.fail,
        next: [{ if: "check.findings > 1", to: "draft" }, { to: "failed" }],
      };
    });
    const r = await make();
    r.source.defs.set("review-loop", bad);
    const { runId, token } = await started(r);
    await r.engine.complete({
      token,
      outcome: "drafted",
      fields: { pr_url: "u" },
    });
    await r.engine.tick();
    const result = await r.engine.complete({
      token: lastToken(r.adapter),
      outcome: "fail",
      fields: { findings: "many" },
    });
    expect(result).toEqual({ ok: true, next: null, applied: "now" });
    const view = r.engine.status(runId);
    expect(view.run.status).toBe("failed");
    const last = view.transitions.at(-1);
    expect(last?.event).toBe("guard_error");
    expect(last?.toState).toBe("failed");
    expect(last?.detail).toMatchObject({
      branchEdge: "check.fail[0]",
      error: expect.stringMatching(/needs two numbers/),
    });
  });

  it("in-flight run keeps its pinned definition", async () => {
    const r = await make();
    const { runId, token } = await started(r);
    // A new version: drafted goes straight to done and the briefs change.
    const v2 = await variant("v2", (def, briefs) => {
      const draft = def.stages.draft;
      if (draft?.type !== "agent") throw new Error("fixture changed");
      draft.outcomes.drafted = { ...draft.outcomes.drafted, next: "done" };
      briefs["briefs/draft.md"] = "NEW DRAFT BRIEF";
      briefs["briefs/check.md"] = "NEW CHECK BRIEF";
    });
    r.source.defs.set("review-loop", v2);

    expect(
      await r.engine.complete({
        token,
        outcome: "drafted",
        fields: { pr_url: "u" },
      }),
    ).toMatchObject({ ok: true, next: "check" });
    await r.engine.tick();
    expect(r.adapter.calls[1]?.message).toContain("Check the draft for rust");
    await r.engine.complete({
      token: lastToken(r.adapter),
      outcome: "fail",
      fields: { findings: "f" },
    });
    await r.engine.tick();
    expect(r.adapter.calls[2]?.message).toContain(
      "Write a short draft about rust.",
    );
    await r.engine.complete({
      token: lastToken(r.adapter),
      outcome: "blocked",
      fields: { reason: "r" },
    });
    expect(r.engine.status(runId).run.status).toBe("failed");

    // A run started after the swap uses the new version.
    const { runId: newer } = await r.engine.startRun("review-loop", {
      topic: "go",
    });
    await r.engine.tick();
    expect(r.adapter.calls[3]?.message).toMatch(/^NEW DRAFT BRIEF/);
    expect(
      await r.engine.complete({
        token: lastToken(r.adapter),
        outcome: "drafted",
        fields: { pr_url: "u" },
      }),
    ).toEqual({ ok: true, next: "done", applied: "now" });
    expect(r.engine.status(newer).run.status).toBe("completed");
  });
});

describe("stage_progress", () => {
  it("stores the note and refuses a wrong caller or an ended attempt", async () => {
    const r = await make();
    const { runId, token } = await started(r);
    expect(
      await r.engine.progress({
        token,
        note: "outline done",
        callerAgent: "drafter",
      }),
    ).toEqual({ ok: true, next: null, applied: "now" });
    expect(r.engine.status(runId).live?.progressNote).toBe("outline done");
    expect(r.engine.status(runId).transitions.at(-1)?.event).toBe("progress");
    expect(
      await r.engine.progress({ token, note: "x", callerAgent: "checker" }),
    ).toMatchObject({ ok: false });
    expect(await r.engine.progress({ token, note: "" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/note/),
    });
    await r.engine.complete({
      token,
      outcome: "blocked",
      fields: { reason: "r" },
    });
    expect(await r.engine.progress({ token, note: "late" })).toEqual({
      ok: false,
      error: "this stage was already completed with outcome blocked",
    });
  });
});

describe("completion edge cases", () => {
  it("progress with a token of an ended attempt logs progress_refused", async () => {
    const r = await make();
    const { runId, token } = await started(r);
    r.store.tx((t) => {
      const live = t.liveStageRun(runId);
      if (!live) throw new Error("no live row");
      t.updateStageRunIf(
        live.stageRunId,
        { state: "working", attempt: 1 },
        { state: "failed", ending: "turn_error" },
      );
    });
    expect(await r.engine.progress({ token, note: "late" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/attempt has ended/),
    });
    expect(r.engine.status(runId).transitions.at(-1)?.event).toBe(
      "progress_refused",
    );
  });

  it("the 64 KiB fields error lists the declared fields", async () => {
    const r = await make();
    const { token } = await started(r);
    const result = await r.engine.complete({
      token,
      outcome: "drafted",
      fields: { pr_url: "x".repeat(64 * 1024) },
    });
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("pr_url: string, summary: string?"),
    });
  });
});

describe("completion tools", () => {
  it("turn an engine exception into a tool error", async () => {
    const broken = {
      complete: async () => {
        throw new Error("store closed");
      },
      progress: async () => {
        throw new Error("store closed");
      },
    };
    const args = { token: "t", outcome: "o", note: "n" };
    expect(await stageCompleteTool(broken).handler(args)).toEqual({
      text: expect.stringMatching(/store closed/),
      isError: true,
    });
    expect(await stageProgressTool(broken).handler(args)).toEqual({
      text: expect.stringMatching(/store closed/),
      isError: true,
    });
  });

  it("wrap complete and progress for any harness", async () => {
    const r = await make();
    const { token } = await started(r);
    const complete = stageCompleteTool(r.engine);
    const progress = stageProgressTool(r.engine);
    expect(complete.name).toBe("stage_complete");
    expect(progress.name).toBe("stage_progress");
    expect(complete.inputSchema.required).toEqual(["token", "outcome"]);
    expect(progress.inputSchema.required).toEqual(["token", "note"]);

    expect(
      await progress.handler({ token, note: "half" }, { agent: "drafter" }),
    ).toEqual({
      text: expect.stringMatching(/checkpoint saved/i),
      isError: false,
    });
    expect(await complete.handler({ token }, { agent: "drafter" })).toEqual({
      text: expect.stringMatching(/outcome/),
      isError: true,
    });
    expect(
      await complete.handler(
        { token, outcome: "blocked", fields: { reason: "r" } },
        { agent: "checker" },
      ),
    ).toMatchObject({ isError: true });
    expect(
      await complete.handler(
        { token, outcome: "blocked", fields: { reason: "r" } },
        { agent: "drafter" },
      ),
    ).toEqual({
      text: expect.stringMatching(/recorded.*blocked/i),
      isError: false,
    });
    expect(
      await complete.handler(
        { token, outcome: "blocked", fields: { reason: "r" } },
        { agent: "drafter" },
      ),
    ).toEqual({
      text: expect.stringMatching(/already recorded/i),
      isError: false,
    });
    expect(await complete.handler("nope", undefined)).toMatchObject({
      isError: true,
    });
  });
});
