import type { Capabilities } from "../adapter/types.js";
import type { ProviderPolicy } from "../format/types.js";

/**
 * Two kinds of pause share the `limits` table:
 *
 * - `provider:<p>`: a turn was refused for a usage limit, so the harness's
 *   whole fallback chain failed on `p`.
 * - `policy:<key>`: a turn of a `subscription` or `allow` pipeline ran on a
 *   provider outside its allowed set. `<key>` is that set, sorted, without
 *   duplicates and comma-joined, so `subscription` and an `allow` list of
 *   just the subscription provider share one.
 */
export const PROVIDER_SCOPE = "provider";
export const POLICY_SCOPE = "policy";
/** The provider name used when neither the turn nor the harness gives one. */
export const DEFAULT_PROVIDER = "default";

/** The wait reason of a stage run held by a limit of `scope` and `key`. */
export const pausedReason = (scope: string, key: string): string =>
  `paused:${scope}:${key}`;

/** The provider a refused turn ran on, as the turn or else the harness says. */
export function refusedProvider(
  runtime: { provider: string } | undefined,
  caps: Capabilities,
): string {
  return runtime?.provider ?? caps.subscriptionProvider ?? DEFAULT_PROVIDER;
}

/**
 * The providers a pipeline accepts, or undefined under `fleet` (every
 * provider). Under `subscription` with no subscription provider reported
 * the set is empty: nothing can be judged outside it.
 */
export function allowedSet(
  policy: ProviderPolicy,
  caps: Capabilities,
): string[] | undefined {
  if (policy === "fleet") return undefined;
  const list =
    policy === "subscription"
      ? caps.subscriptionProvider === undefined
        ? []
        : [caps.subscriptionProvider]
      : policy.allow;
  return [...new Set(list)].sort();
}

/** The `policy:` limit key of a pipeline's allowed set. */
export function policyKey(allowed: readonly string[]): string {
  return allowed.join(",");
}

/**
 * The policy key to pause when a turn ran on `provider`, or undefined when
 * the turn was within the pipeline's policy.
 */
export function degradedPolicy(
  policy: ProviderPolicy,
  provider: string | undefined,
  caps: Capabilities,
): string | undefined {
  const allowed = allowedSet(policy, caps);
  if (provider === undefined || allowed === undefined) return undefined;
  if (allowed.length === 0 || allowed.includes(provider)) return undefined;
  return policyKey(allowed);
}
