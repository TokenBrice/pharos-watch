import type { StablecoinMeta } from "../types";

export type BlacklistStatus = NonNullable<StablecoinMeta["blacklistabilityReview"]>["reviewedStatus"];

export function getBlacklistStatusLabel(
  status: BlacklistStatus,
): "Yes" | "Possible" | "Upstream" | "No" {
  if (status === true) return "Yes";
  if (status === "possible") return "Possible";
  if (status === "inherited") return "Upstream";
  return "No";
}

export function resolveBlacklistStatus(meta: StablecoinMeta): BlacklistStatus {
  const status = meta.blacklistabilityReview?.reviewedStatus;
  if (status === undefined) {
    throw new Error(`Stablecoin ${meta.id} has no reviewed blacklistability status`);
  }
  return status;
}

export function resolveBlacklistStatuses(
  metas: readonly StablecoinMeta[],
): Map<string, BlacklistStatus> {
  return new Map(metas.map((meta) => [meta.id, resolveBlacklistStatus(meta)]));
}
