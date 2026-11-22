import { isSlidingWindowRateLimited } from "./sliding-window-rate-limit";
import { hashClientIp } from "@shared/lib/client-ip-hash";

export interface SiteDataRateLimitEnv {
  SITE_API_SHARED_SECRET?: string;
}

/**
 * Per-isolate hashed-IP sliding-window limiter for the website-data lane.
 *
 * The Origin/Referer gate is a caller-shape signal, not authentication: any
 * non-browser client can forge it. The Worker's site-api lane replaces the
 * per-key quota with the shared proxy secret, so without a local ceiling one
 * source can drive unbounded Pages and Worker invocations, including
 * provider-triggering detail refresh and `cacheBypass` report-card
 * materialization.
 *
 * One reader's first paint is roughly 15-20 same-origin reads, a navigation
 * adds about the same, and the fastest polls refetch on a multi-minute
 * cadence, so 600/minute (10 reads/second per hashed IP) leaves more than an
 * order of magnitude of headroom for multi-tab browsing and aligns the Pages
 * isolate ceiling with the Worker's enforced `SITE_SOURCE_RATE_LIMIT`
 * (`600/60s` per client network). Detail-snapshot generation uses credentialed
 * `bulk` (`site-api.pharos.watch`) or keyed `api.pharos.watch` instead of
 * uncredentialed `/_site-data` bursts.
 *
 * Isolate-local state is best-effort (resets on isolate recycle, not shared
 * across colos) and mirrors the selector-snapshot write limiter: it bounds the
 * realistic single-source read loop rather than claiming a global quota.
 * `siteDataRequestTimestampsByIpHash` is registered in
 * `shared/lib/isolate-local-state-registry.ts`.
 */
export const SITE_DATA_RATE_LIMIT_WINDOW_MS = 60_000;
export const SITE_DATA_RATE_LIMIT_MAX_PER_WINDOW = 600;
export const SITE_DATA_RATE_LIMIT_MAX_TRACKED_IPS = 5_000;

const siteDataRequestTimestampsByIpHash = new Map<string, number[]>();

export function resetSiteDataRateLimitStateForTests(): void {
  siteDataRequestTimestampsByIpHash.clear();
}

/**
 * True when this client-IP hash has spent its window budget. A missing client
 * IP or hashing secret cannot be metered; the Function's env validation
 * already fails closed when the lane secret is absent.
 */
export async function isSiteDataRateLimited(
  request: Request,
  env: SiteDataRateLimitEnv,
): Promise<boolean> {
  const ip = request.headers.get("CF-Connecting-IP");
  const secret = env.SITE_API_SHARED_SECRET?.trim();
  if (!ip || !secret) return false;

  const key = await hashClientIp(ip, secret);
  return isSlidingWindowRateLimited(
    siteDataRequestTimestampsByIpHash, key, Date.now(),
    SITE_DATA_RATE_LIMIT_WINDOW_MS, SITE_DATA_RATE_LIMIT_MAX_PER_WINDOW, SITE_DATA_RATE_LIMIT_MAX_TRACKED_IPS,
  );
}
