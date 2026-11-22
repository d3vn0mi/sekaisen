import type { RunOutcome } from "../adapter/types.js";
import type { StageRunRow } from "../store/types.js";

/**
 * How a turn, or an attempt's wall-clock budget, ended without
 * `stage_complete`. `timeout` comes from the deadline, never from a turn.
 */
export type Ending =
  | "no_result"
  | "continue"
  | "turn_error"
  | "usage_limited"
  | "timeout";

/** The line a harness prints when a subscription limit refused the turn. */
export const USAGE_LIMIT_REFUSAL =
  /You've hit your (session |usage |weekly )?limit[^\n]*/;

const RESET_PHRASE = /resets (.+)$/m;

/** How long a pause lasts when the refusal gives no usable reset time. */
export const DEFAULT_PAUSE_MS = 3_600_000;
/** How long a pause lasts when the reset it names passed within the hour. */
export const RESET_GRACE_MS = 300_000;

/** The refusal line in an error, if the error carries one. */
export function refusalLine(error: string | undefined): string | undefined {
  return error === undefined ? undefined : USAGE_LIMIT_REFUSAL.exec(error)?.[0];
}

/**
 * Classifies a turn that ended. `sr` is the stage run as it stood when the
 * turn's end was read: a progress note counts as fresh when it was written
 * during the turn that just ended (its dispatch sequence), so a note left by
 * an earlier turn does not earn another one.
 */
export function classifyEnding(
  o: RunOutcome,
  sr: StageRunRow,
  _now: number,
): Ending {
  if (o.state !== "ended") {
    throw new Error(`the turn has not ended (${o.state})`);
  }
  if (o.ending === "ok") {
    const fresh = sr.progressSeq !== null && sr.progressSeq === sr.dispatchSeq;
    return fresh ? "continue" : "no_result";
  }
  return refusalLine(o.error) === undefined ? "turn_error" : "usage_limited";
}

/**
 * The instant a usage limit lifts, read from the `resets …` phrase of a
 * refusal: an ISO instant with a zone (`2026-11-22T18:00:00Z`), a time of
 * day (`7pm`, `7:30pm`; its next occurrence), or a date and time
 * (`Nov 1, 7pm`; the nearest such date). A time zone may follow in
 * parentheses (`(Europe/Berlin)`); UTC without one. A reset that passed
 * within the last hour is about to take effect: five minutes. Anything
 * unreadable, or a reset further in the past, gives `now` plus one hour.
 */
export function parseReset(error: string, now: number): number {
  const source = refusalLine(error) ?? error;
  const phrase = RESET_PHRASE.exec(source)?.[1];
  const at = phrase === undefined ? undefined : readPhrase(phrase, now);
  if (at === undefined || Number.isNaN(at)) return now + DEFAULT_PAUSE_MS;
  if (at > now) return at;
  return now - at <= DEFAULT_PAUSE_MS
    ? now + RESET_GRACE_MS
    : now + DEFAULT_PAUSE_MS;
}

const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*(am|pm)`;
const ZONE = String.raw`(?:\s*\(([^)]+)\))?`;
const TIME_OF_DAY = new RegExp(`^${TIME}${ZONE}$`, "i");
const DATE_TIME = new RegExp(
  String.raw`^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+${TIME}${ZONE}$`,
  "i",
);
const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

function readPhrase(raw: string, now: number): number | undefined {
  const phrase = raw.trim().replace(/[.,;]+$/, "");
  if (ISO_INSTANT.test(phrase)) {
    const at = Date.parse(phrase);
    return Number.isNaN(at) ? undefined : at;
  }
  try {
    const tod = TIME_OF_DAY.exec(phrase);
    if (tod) {
      const [, h, m, ampm, zone] = tod;
      const time = clock(h, m, ampm);
      return time && nextTimeOfDay(time, zone ?? "UTC", now);
    }
    const dt = DATE_TIME.exec(phrase);
    if (dt) {
      const [, mon, day, h, m, ampm, zone] = dt;
      const month = MONTHS.indexOf((mon ?? "").toLowerCase());
      const time = clock(h, m, ampm);
      const d = Number(day);
      if (month < 0 || !time || d < 1) return undefined;
      return nearestDate(month, d, time, zone ?? "UTC", now);
    }
  } catch {
    // An unknown time zone.
    return undefined;
  }
  return undefined;
}

interface Time {
  hour: number;
  minute: number;
}

/** A 12-hour clock reading to 24-hour, or undefined when out of range. */
function clock(
  h: string | undefined,
  m: string | undefined,
  ampm: string | undefined,
): Time | undefined {
  const hour12 = Number(h);
  const minute = m === undefined ? 0 : Number(m);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return undefined;
  const pm = ampm?.toLowerCase() === "pm";
  return { hour: (hour12 % 12) + (pm ? 12 : 0), minute };
}

/**
 * When the wall clock in `zone` reads `time`: its last occurrence when that
 * was within the hour (the reset is just taking effect), else its next.
 */
function nextTimeOfDay(time: Time, zone: string, now: number): number {
  const today = wallClock(now, zone);
  let last = Number.NaN;
  for (let days = -1; days <= 2; days++) {
    const at = fromWallClock(
      today.year,
      today.month,
      today.day + days,
      time,
      zone,
    );
    if (at <= now) {
      last = at;
      continue;
    }
    return now - last <= DEFAULT_PAUSE_MS ? last : at;
  }
  return Number.NaN;
}

/** The instant of `month`/`day` at `time` in `zone`, in the year that puts it nearest `now`. */
function nearestDate(
  month: number,
  day: number,
  time: Time,
  zone: string,
  now: number,
): number {
  const { year } = wallClock(now, zone);
  let best = Number.NaN;
  for (const y of [year - 1, year, year + 1]) {
    // A day the month does not have (Feb 30) is no date at all.
    if (new Date(Date.UTC(y, month, day)).getUTCMonth() !== month) continue;
    const at = fromWallClock(y, month, day, time, zone);
    if (Number.isNaN(best) || Math.abs(at - now) < Math.abs(best - now)) {
      best = at;
    }
  }
  return best;
}

interface WallClock {
  year: number;
  /** 0-based. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** What a wall clock in `zone` reads at `instant`. Throws on an unknown zone. */
function wallClock(instant: number, zone: string): WallClock {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(zone, f);
  }
  const parts: Record<string, number> = {};
  for (const p of f.formatToParts(instant)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year ?? 0,
    month: (parts.month ?? 1) - 1,
    day: parts.day ?? 1,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

/** How far `zone`'s wall clock is ahead of UTC at `instant`, in milliseconds. */
function offsetAt(instant: number, zone: string): number {
  const w = wallClock(instant, zone);
  const asUtc = Date.UTC(w.year, w.month, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `zone` reads the given date and
 * time. Two passes, so a date across a daylight-saving change from `now`
 * still lands on its own offset. Day overflow rolls into the next month.
 */
function fromWallClock(
  year: number,
  month: number,
  day: number,
  time: Time,
  zone: string,
): number {
  const local = Date.UTC(year, month, day, time.hour, time.minute);
  const first = local - offsetAt(local, zone);
  const second = local - offsetAt(first, zone);
  return second;
}
