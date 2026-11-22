import type { Capabilities } from "../adapter/types.js";
import type { ProviderPolicy } from "../format/types.js";
import type { LimitRow, StageRunRow } from "../store/types.js";

/** The `limits` scope of a paused provider. */
export const PROVIDER_SCOPE = "provider";
/** The provider name used when neither the turn nor the harness gives one. */
export const DEFAULT_PROVIDER = "default";

const PAUSED = "paused:provider:";

/** The wait reason of a stage run held for `provider`. */
export const pausedReason = (provider: string): string =>
  `${PAUSED}${provider}`;

/**
 * The provider a pipeline's fresh turns are meant to run on: the harness's
 * subscription provider when it reports one.
 */
export function preferredProvider(caps: Capabilities): string {
  return caps.subscriptionProvider ?? DEFAULT_PROVIDER;
}

/** The provider a refused turn ran on, as the turn or else the harness says. */
export function refusedProvider(
  runtime: { provider: string } | undefined,
  caps: Capabilities,
): string {
  return runtime?.provider ?? preferredProvider(caps);
}

/**
 * True when a turn that ran on `provider` falls outside the pipeline's
 * policy. Under `fleet` nothing does; under `subscription` anything but the
 * subscription provider does (unknowable when the harness names none).
 */
export function isDegraded(
  policy: ProviderPolicy,
  provider: string | undefined,
  caps: Capabilities,
): boolean {
  if (provider === undefined || policy === "fleet") return false;
  if (policy === "subscription") {
    return (
      caps.subscriptionProvider !== undefined &&
      provider !== caps.subscriptionProvider
    );
  }
  return !policy.allow.includes(provider);
}

/**
 * The provider the next turn of `row` will run on: under `fleet`, the one
 * its last turn ran on; under any narrower policy, the preferred one.
 */
export function dispatchProvider(
  row: StageRunRow,
  policy: ProviderPolicy,
  caps: Capabilities,
): string {
  const last = policy === "fleet" ? row.runtime?.provider : undefined;
  return last ?? preferredProvider(caps);
}

/**
 * Why `row` must not be dispatched yet because a provider is paused, or
 * undefined when no pause holds it. This is the only place dispatch reads
 * provider limits. A row a refusal sent back also waits for the provider it
 * was refused on.
 */
export function providerPause(
  row: StageRunRow,
  policy: ProviderPolicy,
  limits: readonly LimitRow[],
  caps: Capabilities,
): string | undefined {
  const providers = [dispatchProvider(row, policy, caps)];
  if (row.waitReason?.startsWith(PAUSED)) {
    providers.push(row.waitReason.slice(PAUSED.length));
  }
  const paused = providers.find((p) =>
    limits.some((l) => l.scope === PROVIDER_SCOPE && l.key === p),
  );
  return paused === undefined ? undefined : pausedReason(paused);
}
