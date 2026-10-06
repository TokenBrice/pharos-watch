import { resolveMechanismArchetype } from "@shared/lib/classification";
import { CLIENT_ACTIVE_STABLECOINS, CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type { StablecoinClientListMeta } from "@shared/types/stablecoin-client-meta";
import type { StablecoinMeta } from "@shared/types";

function scoreRelatedStablecoin(
  candidate: Pick<StablecoinMeta, "flags">,
  current: Pick<StablecoinMeta, "flags">,
): number {
  let score = 0;
  if (candidate.flags.governance === current.flags.governance) score += 3;
  if (candidate.flags.backing === current.flags.backing) score += 2;
  if (candidate.flags.pegCurrency === current.flags.pegCurrency) score += 1;
  return score;
}

export function getRelatedStablecoins(
  current: Pick<StablecoinMeta, "id" | "flags" | "mechanismArchetype" | "archetypeOverride" | "variantOf">,
  options: {
    limit?: number;
    candidates?: readonly StablecoinClientListMeta[];
  } = {},
): StablecoinClientListMeta[] {
  const { limit = 6, candidates = CLIENT_ACTIVE_STABLECOINS } = options;
  const currentArchetype = resolveMechanismArchetype(current, CLIENT_TRACKED_META_BY_ID);

  return candidates
    .filter((candidate) => candidate.id !== current.id)
    .map((candidate) => ({
      coin: candidate,
      score: scoreRelatedStablecoin(candidate, current),
      sameCurrency: candidate.flags.pegCurrency === current.flags.pegCurrency,
      sameArchetype: currentArchetype !== null
        && resolveMechanismArchetype(candidate, CLIENT_TRACKED_META_BY_ID) === currentArchetype,
    }))
    .filter((entry) => entry.score > 0 || entry.sameArchetype)
    .sort((left, right) =>
      Number(right.sameCurrency) - Number(left.sameCurrency)
      || Number(right.sameArchetype) - Number(left.sameArchetype)
      || right.score - left.score,
    )
    .slice(0, limit)
    .map((entry) => entry.coin);
}
