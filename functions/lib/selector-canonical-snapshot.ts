import type { SelectorInput, SelectorOutput } from "@shared/lib/selector/types";
import type { SiteDataProxyEnv } from "./site-api-env";

export type SelectorCanonicalSnapshotEnv = Pick<SiteDataProxyEnv, "SITE_API_ORIGIN" | "SITE_API_SHARED_SECRET">;

/**
 * Selector recommendations remain unavailable until their V9 pillar policy is
 * reviewed. The previous implementation recomputed against V8 after V9 became
 * canonical, which could mint new "verified" snapshots from a retired model.
 */
export async function recomputeVerifiedSelectorSnapshot(
  _input: SelectorInput,
  _request: Request,
  _env: SelectorCanonicalSnapshotEnv,
  _now = Date.now(),
): Promise<SelectorOutput> {
  throw new Error("V9 selector recommendation policy is not available");
}
