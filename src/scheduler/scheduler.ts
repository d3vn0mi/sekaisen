import type { Capabilities } from "../adapter/types.js";
import {
  allowedSet,
  POLICY_SCOPE,
  PROVIDER_SCOPE,
  pausedReason,
  policyKey,
} from "../engine/providers.js";
import type { ProviderPolicy } from "../format/types.js";
import type { LimitRow, RunRow, StageRunRow } from "../store/types.js";

/**
 * Which submitted agent stage runs may start a turn now. Pure: everything it
 * decides on is passed in, and it writes nothing.
 *
 * Candidates are taken in order: run priority (higher first), then the stage
 * run's creation time (oldest first), then its id. A candidate is refused,
 * with the first reason that applies, when
 *
 * - `paused:provider:<p>` / `paused:policy:<key>`: a live limit holds it (see
 *   `pauseReason`);
 * - `wip:<agent>`: its agent already has `wip(agent)` working stage runs on
 *   the same session key;
 * - `lane_full`: `capabilities.maxConcurrent` harness lanes are taken (see
 *   `holdsLane`).
 *
 * Only agent stage runs take a lane or count toward WIP; only working ones
 * count toward WIP. A candidate admitted earlier in the same call counts at
 * once.
 */

/** What admission needs to know about an agent stage run. */
export interface AgentSlot {
  agent: string;
  /** The session key its turns run under. */
  sessionKey: string;
  /** Its pipeline's provider policy. */
  providers: ProviderPolicy;
}

export interface AdmitCtx {
  /** Stage runs working now; those `stageOf` does not describe are ignored. */
  working: StageRunRow[];
  /**
   * Other stage runs that may still hold a harness turn (completed with a
   * turn in flight, or with an abort pending); those `holdsLane` accepts
   * take a lane, and never count toward WIP.
   */
  holding: StageRunRow[];
  /** Limits; those that end at or before `now` are ignored. */
  limits: LimitRow[];
  capabilities: Capabilities;
  /** Most working stage runs an agent may have on one session key. */
  wip: (agent: string) => number;
  /** The runs of the candidates, by id; a candidate whose run is missing or not working is skipped. */
  runs: Map<string, RunRow>;
  now: number;
  /**
   * The agent, session key and provider policy of an agent stage run, or
   * undefined for any other stage type (skipped, and never counted).
   */
  stageOf: (row: StageRunRow) => AgentSlot | undefined;
}

export interface Admission {
  /** Stage run ids to dispatch, in admission order. */
  admit: string[];
  /** Refused candidates, in admission order, with why. */
  waiting: Array<{ id: string; reason: string }>;
}

export const LANE_FULL = "lane_full";

/** The wait reason of a stage run held by its agent's WIP limit. */
export const wipReason = (agent: string): string => `wip:${agent}`;

const PAUSED_PROVIDER = pausedReason(PROVIDER_SCOPE, "");

/** True for the wait reason of a stage run a pause holds. */
export const isPause = (reason: string): boolean =>
  reason.startsWith("paused:");

/**
 * Whether a stage run holds a harness lane: it is working, or its agent
 * completed it while its turn may still run (dispatched less than the
 * harness's turn cap ago), or an abort of its turn is still pending.
 */
export function holdsLane(
  row: StageRunRow,
  now: number,
  caps: Capabilities,
): boolean {
  if (row.state === "working" || row.abortRunId !== null) return true;
  return (
    row.state === "completed" &&
    row.dispatchedAt !== null &&
    row.adapterRunId !== null &&
    now < row.dispatchedAt + caps.turnCapMs
  );
}

/** How many harness lanes the agent stage runs of `ctx` take now. */
export function lanesTaken(
  ctx: Pick<
    AdmitCtx,
    "working" | "holding" | "stageOf" | "now" | "capabilities"
  >,
): number {
  const seen = new Set<string>();
  for (const row of [...ctx.working, ...ctx.holding]) {
    if (!ctx.stageOf(row) || !holdsLane(row, ctx.now, ctx.capabilities)) {
      continue;
    }
    seen.add(row.stageRunId);
  }
  return seen.size;
}

export function admit(candidates: StageRunRow[], ctx: AdmitCtx): Admission {
  const sessions = new Map<string, number>();
  let lane = lanesTaken(ctx);
  for (const row of ctx.working) {
    const slot = ctx.stageOf(row);
    if (!slot) continue;
    const key = sessionOf(slot);
    sessions.set(key, (sessions.get(key) ?? 0) + 1);
  }

  const queue: Array<{ row: StageRunRow; run: RunRow; slot: AgentSlot }> = [];
  for (const row of candidates) {
    const run = ctx.runs.get(row.runId);
    const slot = ctx.stageOf(row);
    if (row.state !== "submitted" || run?.status !== "working" || !slot) {
      continue;
    }
    queue.push({ row, run, slot });
  }
  queue.sort(
    (a, b) =>
      b.run.priority - a.run.priority ||
      a.row.createdAt - b.row.createdAt ||
      compareIds(a.row.stageRunId, b.row.stageRunId),
  );

  const out: Admission = { admit: [], waiting: [] };
  for (const { row, slot } of queue) {
    const key = sessionOf(slot);
    const reason =
      pauseReason(row, slot.providers, ctx.limits, ctx.capabilities, ctx.now) ??
      ((sessions.get(key) ?? 0) >= ctx.wip(slot.agent)
        ? wipReason(slot.agent)
        : lane >= ctx.capabilities.maxConcurrent
          ? LANE_FULL
          : undefined);
    if (reason !== undefined) {
      out.waiting.push({ id: row.stageRunId, reason });
      continue;
    }
    out.admit.push(row.stageRunId);
    lane += 1;
    sessions.set(key, (sessions.get(key) ?? 0) + 1);
  }
  return out;
}

/**
 * Why `row` must not be dispatched yet because of a pause, or undefined
 * when no live limit holds it. The only place dispatch reads limits.
 *
 * - The provider its own refused turn named (its wait reason) holds it
 *   first, whatever else is live, so no other limit hides it.
 * - A `fleet` row is held by any provider limit (a refusal means the whole
 *   fallback chain failed) and never by a policy limit.
 * - A `subscription` or `allow` row is held by a provider limit on any
 *   provider in its allowed set and by the limit of its own policy key.
 */
export function pauseReason(
  row: StageRunRow,
  policy: ProviderPolicy,
  limits: readonly LimitRow[],
  caps: Capabilities,
  now: number,
): string | undefined {
  const live = limits.filter((l) => l.pausedUntil > now);
  const own = row.waitReason?.startsWith(PAUSED_PROVIDER)
    ? row.waitReason.slice(PAUSED_PROVIDER.length)
    : undefined;
  if (
    own !== undefined &&
    live.some((l) => l.scope === PROVIDER_SCOPE && l.key === own)
  ) {
    return pausedReason(PROVIDER_SCOPE, own);
  }
  const allowed = allowedSet(policy, caps);
  for (const l of live) {
    if (l.scope !== PROVIDER_SCOPE) continue;
    if (allowed === undefined || allowed.includes(l.key)) {
      return pausedReason(PROVIDER_SCOPE, l.key);
    }
  }
  if (allowed === undefined) return undefined;
  const key = policyKey(allowed);
  return live.some((l) => l.scope === POLICY_SCOPE && l.key === key)
    ? pausedReason(POLICY_SCOPE, key)
    : undefined;
}

function sessionOf(slot: AgentSlot): string {
  return JSON.stringify([slot.agent, slot.sessionKey]);
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
