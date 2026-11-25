import { resolveLinkedVariantSourceOwnerId } from "../yield-source-links";

interface YieldOpportunityExclusion {
  projects: readonly string[];
  /** Exact DeFiLlama UUIDs keep replacement deployments outside the hold. */
  poolIds?: readonly string[];
  assetSources?: {
    stablecoinId: string;
    sourceKeys: readonly string[];
    sourceKeyPrefixes?: readonly string[];
    sourceLabels?: readonly string[];
    legacyParent?: { stablecoinId: string; poolId: string };
  };
  since: string;
  reviewedAt: string;
  nextReviewAt: string;
  owner: "ops";
  reason: string;
}

/** Owner-reviewed holds stay closed after their review deadline, never auto-resume. */
export const YIELD_OPPORTUNITY_EXCLUSIONS: readonly YieldOpportunityExclusion[] = [
  {
    projects: ["radiant-v2"],
    since: "2026-11-07", reviewedAt: "2026-11-07", nextReviewAt: "2026-11-21", owner: "ops",
    reason: "Radiant disabled borrowing and emissions and entered recovery-only maintenance: https://medium.com/@RadiantCapital/sunsetting-radiant-capital-dao-entering-recovery-phase-and-lessons-for-the-future-of-defi-c47837ffa499",
  },
  {
    projects: ["sovryn-dex"],
    since: "2026-11-07", reviewedAt: "2026-11-07", nextReviewAt: "2026-11-21", owner: "ops",
    reason: "Lending withdrawals remain paused after the October 31 and November 1 attacks: https://forum.sovryn.com/t/sovryn-incident-report-31-october-1-november-2026/3609",
  },
  {
    projects: ["truefi"],
    // Legacy BUSD, USDT, TUSD and USDC contracts, mapped by https://yields.llama.fi/distinctID.
    poolIds: [
      "51752c3a-a277-4c54-b07f-5023bc476b71", "64bb6a50-3ace-4c90-960a-7e1e828e944f",
      "53406189-a08c-4654-8588-2eb4e83a44c9", "ca6ed758-967b-46ec-9e88-8fe50d7cc188",
    ],
    since: "2026-11-07", reviewedAt: "2026-11-07", nextReviewAt: "2026-11-21", owner: "ops",
    reason: "Legacy TrueFi pools are held during the Brila transition; replacement pools require separate review: https://forum.truefi.io/t/tfip-42-timelock-migration-to-gnosis-safe-multi-sig-transition-period/2907",
  },
  {
    projects: ["blend-pools-v2"],
    // All registered reserves of incumbent CAJJZSG / CCCCIQSD, not the V2.1 deployments.
    poolIds: [
      "e8a6579f-75bd-4b55-9084-de31affed8e2", "ecf788e3-d2ef-4fdd-9ece-8a2d96226ddf",
      "3a61420f-6f6e-45f9-accc-8d23f5a32d33", "240d9ba0-4701-4192-849f-507507668b88",
      "2d401ed8-2ced-4116-bda9-deb9058d423d", "799fd51e-bd83-4a75-8ace-1f33d7e7ffc0",
      "16086e0b-cd47-41ec-8c4e-9b157c24ae6d", "cd52bdc8-a5d3-438e-af73-bdaaa3084630",
      "48c597dc-9367-4b4a-aa10-49b9755c4c2e", "9a2f1f81-0a6e-441d-8219-c13b3520bd57",
    ],
    since: "2026-11-07", reviewedAt: "2026-11-07", nextReviewAt: "2026-11-21", owner: "ops",
    reason: "Incumbent V2 pools retain impaired Comet backing; V2.1 is a separate deployment: https://github.com/blend-capital/blend-contracts-v2/discussions/64",
  },
  {
    projects: ["loopscale", "loopscale-lending"],
    since: "2026-11-07", reviewedAt: "2026-11-07", nextReviewAt: "2026-11-21", owner: "ops",
    reason: "Genesis-funded repayments and vault withdrawals remain restricted after the November attacks: https://x.com/Loopscale/status/2118502123705159769",
  },
  {
    projects: ["k3"],
    assetSources: {
      stablecoinId: "sbold-k3-capital",
      sourceLabels: ["K3: sBOLD", "Liquity Stability Pool (via K3 sBOLD)", "K3 sBOLD Stability Pool vault"],
      sourceKeyPrefixes: ["protocol-api:k3:"],
      legacyParent: { stablecoinId: "bold-liquity", poolId: "dac71f4f-7b97-463a-b19f-9796c56c21f1" },
      sourceKeys: [
        "price-derived",
        "2ce146c4-4443-50eb-851b-fc7d37a3cd0a",
      ],
    },
    since: "2026-11-18", reviewedAt: "2026-11-25", nextReviewAt: "2026-12-09", owner: "ops",
    reason: "K3 paused sBOLD after the vault drain; re-verified 2026-11-25 at Ethereum block 26491336 (paused, 4.5725 BOLD / 4.372e19 shares, convertToAssets(1e18)=0; owner lifecycle decision on #2106 has no fixed deadline). Remove only after verified vault reopening, reconciled backing and a current exact-vault holder rate: https://x.com/i/article/2123376353923764224",
  },
];

export function findReviewedYieldSourceExclusion(params: {
  stablecoinId?: string;
  sourceKey?: string | null;
  project?: string | null;
  pool?: string | null;
}): YieldOpportunityExclusion | undefined {
  return YIELD_OPPORTUNITY_EXCLUSIONS.find(({ assetSources, poolIds, projects }) => {
    if (assetSources) {
      const { sourceKey } = params;
      return assetSources.stablecoinId === params.stablecoinId && sourceKey != null &&
        (assetSources.sourceKeys.includes(sourceKey) || assetSources.legacyParent?.poolId === sourceKey
          || assetSources.sourceKeyPrefixes?.some((prefix) => sourceKey.startsWith(prefix)) === true);
    }
    return poolIds
      ? poolIds.includes(params.pool ?? "")
      : projects.includes(params.project?.trim().toLowerCase() ?? "");
  });
}

export function isReviewedYieldSourceExcluded(params: Parameters<typeof findReviewedYieldSourceExclusion>[0]): boolean {
  return findReviewedYieldSourceExclusion(params) !== undefined;
}

export function isReviewedPublishedYieldSourceExcluded(
  stablecoinId: string, sourceKey: string | null | undefined, yieldSource?: string,
): boolean {
  if (!sourceKey) {
    return yieldSource != null && YIELD_OPPORTUNITY_EXCLUSIONS.some(({ assetSources }) =>
      (assetSources?.stablecoinId === stablecoinId || assetSources?.legacyParent?.stablecoinId === stablecoinId)
      && assetSources.sourceLabels?.includes(yieldSource) === true);
  }
  const ownerId = resolveLinkedVariantSourceOwnerId(stablecoinId, sourceKey);
  return isReviewedYieldSourceExcluded({
    stablecoinId: ownerId ?? stablecoinId,
    sourceKey: ownerId ? sourceKey.slice(`linked-variant:${ownerId}:`.length) : sourceKey,
  }) || (!ownerId && YIELD_OPPORTUNITY_EXCLUSIONS.some(({ assetSources }) =>
    assetSources?.legacyParent?.stablecoinId === stablecoinId &&
    (assetSources.legacyParent.poolId === sourceKey || assetSources.sourceKeyPrefixes?.some((prefix) => sourceKey.startsWith(prefix)))));
}
