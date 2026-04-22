import type { StablecoinMeta } from "../types";
import {
  createBlacklistResolutionContext,
  enrichLiveSlicesForBlacklist,
  getBlacklistStatusLabel,
  isBlacklistable,
  resolveBlacklistStatus,
  type BlacklistStatus,
  type BlacklistResolutionContext,
  type ResolveBlacklistStatusOptions,
  type ResolveBlacklistStatusesOptions,
} from "./report-card-blacklist-matchers";

export {
  createBlacklistResolutionContext,
  enrichLiveSlicesForBlacklist,
  getBlacklistStatusLabel,
  isBlacklistable,
  resolveBlacklistStatus,
};
export type {
  BlacklistStatus,
  BlacklistResolutionContext,
  ResolveBlacklistStatusOptions,
  ResolveBlacklistStatusesOptions,
};

export function resolveBlacklistStatuses(
  metas: readonly StablecoinMeta[],
  options: ResolveBlacklistStatusesOptions = {},
): Map<string, BlacklistStatus> {
  const trackedMetaById = options.trackedMetaById ?? new Map(
    metas.map((meta) => [meta.id, meta] as const),
  );
  const blacklistableIds = new Set(
    metas
      .filter((meta) => (
        meta.canBeBlacklisted === true ||
        (meta.canBeBlacklisted === undefined && meta.flags.governance === "centralized")
      ))
      .map((meta) => meta.id),
  );
  const reserveSlicesById = options.reserveSlicesById;
  const maxIterations = metas.length + 1;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const context = createBlacklistResolutionContext(blacklistableIds, trackedMetaById);
    let addedThisPass = false;

    for (const meta of metas) {
      const status = resolveBlacklistStatus(meta, {
        context,
        reserveSlices: reserveSlicesById?.get(meta.id),
      });
      if ((status === true || status === "inherited") && !blacklistableIds.has(meta.id)) {
        blacklistableIds.add(meta.id);
        addedThisPass = true;
      }
    }

    if (!addedThisPass) {
      const finalContext: BlacklistResolutionContext = createBlacklistResolutionContext(blacklistableIds, trackedMetaById);
      return new Map(
        metas.map((meta) => [meta.id, resolveBlacklistStatus(meta, {
          context: finalContext,
          reserveSlices: reserveSlicesById?.get(meta.id),
        })] as const),
      );
    }
  }

  throw new Error("Blacklist status resolution did not converge");
}
