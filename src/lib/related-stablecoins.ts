import { resolveMechanismArchetype } from "@shared/lib/classification";
import { fnv1a32 } from "@shared/lib/fnv1a";
import { CLIENT_ACTIVE_STABLECOINS, CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type { StablecoinClientListMeta } from "@shared/types/stablecoin-client-meta";
import type { StablecoinMeta } from "@shared/types";

interface RankedRelatedCoin {
  coin: StablecoinClientListMeta;
  score: number;
  sameCurrency: boolean;
  sameArchetype: boolean;
}

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

  const ranked: RankedRelatedCoin[] = candidates
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
    );

  const selected = ranked.slice(0, limit);
  const sixth = selected[5];
  if (limit !== 6 || !sixth) return selected.map((entry) => entry.coin);

  // Slots 1–5 keep their ranked order. The sixth slot is a stable distribution
  // across the tied tier, not a rotation: hash the source:candidate pair so a
  // profile does not always hand the same equally relevant peer the last chip.
  const leading = selected.slice(0, 5);
  const taken = new Set([current.id, ...leading.map((entry) => entry.coin.id)]);
  let chosen = sixth;
  let chosenHash = fnv1a32(`${current.id}:${sixth.coin.id}`);
  for (const entry of ranked) {
    if (taken.has(entry.coin.id)) continue;
    if (entry.sameCurrency !== sixth.sameCurrency || entry.sameArchetype !== sixth.sameArchetype || entry.score !== sixth.score) {
      continue;
    }
    const hash = fnv1a32(`${current.id}:${entry.coin.id}`);
    if (hash < chosenHash || (hash === chosenHash && entry.coin.id < chosen.coin.id)) {
      chosen = entry;
      chosenHash = hash;
    }
  }

  return [...leading, chosen].map((entry) => entry.coin);
}
