import type { StablecoinMeta, MintAuthorityControl, MintAuthorityProfile, StablecoinLink } from "@shared/types";
import type { MintAuthorityClientSummary } from "@shared/types/stablecoin-client-meta";
import { collectMintAuthoritySources } from "@shared/lib/mint-authority-sources";
import { dedupeStablecoinLinksByUrl } from "@/lib/stablecoin-detail-links-client";

type MintAuthorityClientControlSummary = NonNullable<MintAuthorityClientSummary["controls"]>[number];
type MintAuthorityClientSourceSummary = NonNullable<MintAuthorityClientSummary["sources"]>[number];

export const MAX_MINT_AUTHORITY_DETAIL_CONTROLS = 12;

const CONTROL_DISPLAY_PRIORITY: Record<MintAuthorityClientControlSummary["directMintAbility"], number> = {
  direct: 0,
  "can-authorize": 1,
  unknown: 2,
  "cap-limited": 3,
  "upgrade-only": 4,
  "parameter-only": 5,
  none: 6,
};

/** Only overflowing censuses change order; ordinary reviews keep their authored presentation. */
export function selectMintAuthorityDetailControls(
  controls: MintAuthorityClientControlSummary[],
): MintAuthorityClientControlSummary[] {
  if (controls.length <= MAX_MINT_AUTHORITY_DETAIL_CONTROLS) return controls;
  return controls.toSorted((a, b) =>
    CONTROL_DISPLAY_PRIORITY[a.directMintAbility] - CONTROL_DISPLAY_PRIORITY[b.directMintAbility],
  ).slice(0, MAX_MINT_AUTHORITY_DETAIL_CONTROLS);
}

function projectSources(sources: readonly StablecoinLink[]): MintAuthorityClientSourceSummary[] {
  return dedupeStablecoinLinksByUrl(sources.filter(({ label, url }) => label && url).map(({ label, url }) => ({ label, url })));
}

function buildMintIncidents(
  incidents: MintAuthorityProfile["mintIncidents"],
): MintAuthorityClientSummary["mintIncidents"] | undefined {
  return incidents?.map(({ date, status, resolvedAt, summary, sources }) => ({
    date,
    status,
    ...(resolvedAt ? { resolvedAt } : {}),
    summary,
    sources: projectSources(sources),
  }));
}

function buildControlSummary(value: MintAuthorityControl): MintAuthorityClientControlSummary {
  const summary: MintAuthorityClientControlSummary = {
    label: value.label,
    role: value.role,
    authorityType: value.authorityType,
    directMintAbility: value.directMintAbility,
  };

  if (value.chain) summary.chain = value.chain;
  if (value.address) summary.address = value.address;
  if (value.threshold != null) summary.threshold = value.threshold;
  if (value.signerCount != null) summary.signerCount = value.signerCount;
  if (value.timelockDelaySec != null) summary.timelockDelaySec = value.timelockDelaySec;
  if (value.capDescription) summary.capDescription = value.capDescription;
  if (value.canRaiseCap != null) summary.canRaiseCap = value.canRaiseCap;
  if (value.modulesOrGuardsStatus) summary.modulesOrGuardsStatus = value.modulesOrGuardsStatus;
  if (value.keyCustodyAttestation) {
    summary.keyCustodyAttestation = {
      kind: value.keyCustodyAttestation.kind,
      sources: projectSources(value.keyCustodyAttestation.sources),
    };
  }

  return summary;
}

export function projectMintAuthorityClientSummary(coin: StablecoinMeta): MintAuthorityClientSummary | null {
  const profile = coin.mintAuthority;
  if (!profile) return null;

  const summary: MintAuthorityClientSummary = {
    mintPath: profile.mintPath,
    authorityPosture: profile.authorityPosture,
    confidence: profile.confidence,
    summary: profile.summary,
  };

  if (profile.headline) summary.headline = profile.headline;
  if (profile.inheritedFrom) summary.inheritedFrom = profile.inheritedFrom;
  const mintIncidents = buildMintIncidents(profile.mintIncidents);
  if (mintIncidents) summary.mintIncidents = mintIncidents;

  const controls = profile.controls?.map(buildControlSummary) ?? [];
  if (controls.length > 0) {
    summary.controls = selectMintAuthorityDetailControls(controls);
    if (controls.length > summary.controls.length) {
      summary.totalControlCount = controls.length;
      summary.controlCensusUrl = `https://github.com/TokenBrice/pharos-watch/blob/main/shared/data/stablecoins/domains/mint-authority/${coin.id}.json`;
    }
  }

  const review = profile.review;
  if (review?.reviewedAt) summary.reviewedAt = review.reviewedAt;
  if (review?.sourceFreeRationale) summary.sourceFreeRationale = review.sourceFreeRationale;
  if (review?.unresolvedQuestions?.length) summary.unresolvedQuestions = review.unresolvedQuestions;
  const sources = projectSources(collectMintAuthoritySources(profile));
  if (sources.length > 0) summary.sources = sources;

  return summary;
}
