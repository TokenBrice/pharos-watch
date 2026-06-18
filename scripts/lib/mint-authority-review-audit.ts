import {
  computeMintAuthorityScore,
  isMintCapableAbility,
  stablecoinToMintAuthorityScoringInput,
  type MintAuthorityParentResolver,
} from "../../shared/lib/mint-authority-scoring";
import { isActiveStablecoinMeta } from "../../shared/lib/stablecoins/status";
import type { MintAuthorityControl, MintAuthorityProfile, StablecoinLink, StablecoinMeta } from "../../shared/types";

const ROUTE_CHECK_MINT_PATHS = new Set<MintAuthorityProfile["mintPath"]>([
  "bridge-or-oft-synthetic",
  "offchain-attested-minter",
  "m0-permissioned-minter",
]);

const CUSTODY_PROSE_PATTERN = /\b(mpc|hsm|fireblocks|custod(?:y|ian)|key management)\b/i;

export interface MintAuthorityAuditCoinRow {
  coinId: string;
  symbol: string;
  status: StablecoinMeta["status"];
}

export interface MintAuthorityAuditControlRow extends MintAuthorityAuditCoinRow {
  controlLabel: string;
  mintPath: MintAuthorityProfile["mintPath"];
  role: MintAuthorityControl["role"];
  authorityType: MintAuthorityControl["authorityType"];
  directMintAbility: MintAuthorityControl["directMintAbility"];
  reason: string;
}

export interface MintAuthorityAuditUnresolvedRow extends MintAuthorityAuditCoinRow {
  confidence: MintAuthorityProfile["confidence"];
  questionCount: number;
  verified: boolean;
}

export interface MintAuthorityAuditSourceFreeRow extends MintAuthorityAuditCoinRow {
  rationale: string;
}

export interface MintAuthorityAuditUnscoreableRow extends MintAuthorityAuditCoinRow {
  unresolvedReason: string;
}

export interface MintAuthorityAuditSourceStats {
  totalLinks: number;
  uniqueUrls: number;
  duplicateUrls: number;
}

export interface MintAuthorityReviewAudit {
  generatedAt: string;
  summary: {
    trackedCoins: number;
    activeCoins: number;
    reviewedProfiles: number;
    activeMissingReviews: number;
    reviewedButUnscoreable: number;
    routeCheckQueue: number;
    capDescriptionQueue: number;
    unresolvedQuestionProfiles: number;
    verifiedWithUnresolvedQuestions: number;
    sourceFreeProfiles: number;
    custodyAttestationQueue: number;
    sourceUrls: MintAuthorityAuditSourceStats;
  };
  activeMissingReviews: MintAuthorityAuditCoinRow[];
  reviewedButUnscoreable: MintAuthorityAuditUnscoreableRow[];
  routeCheckQueue: MintAuthorityAuditControlRow[];
  capDescriptionQueue: MintAuthorityAuditControlRow[];
  unresolvedQuestionQueue: MintAuthorityAuditUnresolvedRow[];
  sourceFreeQueue: MintAuthorityAuditSourceFreeRow[];
  custodyAttestationQueue: MintAuthorityAuditControlRow[];
}

export interface BuildMintAuthorityReviewAuditOptions {
  coins: readonly StablecoinMeta[];
  generatedAt?: string;
}

function activeCoin(coin: StablecoinMeta): boolean {
  return isActiveStablecoinMeta(coin);
}

function coinRow(coin: StablecoinMeta): MintAuthorityAuditCoinRow {
  return {
    coinId: coin.id,
    symbol: coin.symbol,
    status: coin.status,
  };
}

function collectLinksFromSources(target: StablecoinLink[], sources: readonly StablecoinLink[] | undefined) {
  if (!sources) return;
  target.push(...sources);
}

function collectMintAuthoritySources(profile: MintAuthorityProfile): StablecoinLink[] {
  const links: StablecoinLink[] = [];
  collectLinksFromSources(links, profile.review.sources);
  for (const incident of profile.mintIncidents ?? []) {
    collectLinksFromSources(links, incident.sources);
  }
  for (const control of profile.controls ?? []) {
    collectLinksFromSources(links, control.sources);
    collectLinksFromSources(links, control.keyCustodyAttestation?.sources);
  }
  return links;
}

function appendSourceStats(
  stats: { totalLinks: number; urls: Map<string, number> },
  sources: readonly StablecoinLink[],
) {
  for (const source of sources) {
    stats.totalLinks += 1;
    stats.urls.set(source.url, (stats.urls.get(source.url) ?? 0) + 1);
  }
}

function sourceStatsFrom(stats: { totalLinks: number; urls: Map<string, number> }): MintAuthorityAuditSourceStats {
  let duplicateUrls = 0;
  for (const count of stats.urls.values()) {
    if (count > 1) duplicateUrls += 1;
  }
  return {
    totalLinks: stats.totalLinks,
    uniqueUrls: stats.urls.size,
    duplicateUrls,
  };
}

function controlRow(
  coin: StablecoinMeta,
  profile: MintAuthorityProfile,
  control: MintAuthorityControl,
  reason: string,
): MintAuthorityAuditControlRow {
  return {
    ...coinRow(coin),
    controlLabel: control.label,
    mintPath: profile.mintPath,
    role: control.role,
    authorityType: control.authorityType,
    directMintAbility: control.directMintAbility,
    reason,
  };
}

function proseForCustodyScan(profile: MintAuthorityProfile, control: MintAuthorityControl): string {
  return [
    profile.summary,
    profile.review.evidence,
    profile.review.sourceFreeRationale,
    ...(profile.review.unresolvedQuestions ?? []),
    control.evidence,
    ...(control.sources ?? []).flatMap((source) => [source.label, source.url]),
    ...(profile.review.sources ?? []).flatMap((source) => [source.label, source.url]),
  ]
    .filter(Boolean)
    .join("\n");
}

function shouldQueueCustodyAttestation(profile: MintAuthorityProfile, control: MintAuthorityControl): boolean {
  if (control.authorityType !== "eoa") return false;
  if (!isMintCapableAbility(control.directMintAbility)) return false;
  if (control.keyCustodyAttestation) return false;
  return CUSTODY_PROSE_PATTERN.test(proseForCustodyScan(profile, control));
}

function sortRows<T extends { coinId: string }>(rows: T[]): T[] {
  return rows.sort((a, b) => a.coinId.localeCompare(b.coinId));
}

export function buildMintAuthorityReviewAudit({
  coins,
  generatedAt = new Date().toISOString(),
}: BuildMintAuthorityReviewAuditOptions): MintAuthorityReviewAudit {
  const coinById = new Map(coins.map((coin) => [coin.id, coin]));
  const resolveParent: MintAuthorityParentResolver = (id) => {
    const parent = coinById.get(id);
    return stablecoinToMintAuthorityScoringInput(parent);
  };
  const sourceStats = { totalLinks: 0, urls: new Map<string, number>() };

  const activeMissingReviews: MintAuthorityAuditCoinRow[] = [];
  const reviewedButUnscoreable: MintAuthorityAuditUnscoreableRow[] = [];
  const routeCheckQueue: MintAuthorityAuditControlRow[] = [];
  const capDescriptionQueue: MintAuthorityAuditControlRow[] = [];
  const unresolvedQuestionQueue: MintAuthorityAuditUnresolvedRow[] = [];
  const sourceFreeQueue: MintAuthorityAuditSourceFreeRow[] = [];
  const custodyAttestationQueue: MintAuthorityAuditControlRow[] = [];
  let reviewedProfiles = 0;

  for (const coin of coins) {
    const profile = coin.mintAuthority;
    if (!profile) {
      if (activeCoin(coin)) activeMissingReviews.push(coinRow(coin));
      continue;
    }

    reviewedProfiles += 1;
    appendSourceStats(sourceStats, collectMintAuthoritySources(profile));

    const score = computeMintAuthorityScore(stablecoinToMintAuthorityScoringInput(coin), resolveParent);
    if (score.score == null) {
      reviewedButUnscoreable.push({
        ...coinRow(coin),
        unresolvedReason: score.unresolvedReason ?? "unknown",
      });
    }

    if (profile.review.sourceFreeRationale) {
      sourceFreeQueue.push({ ...coinRow(coin), rationale: profile.review.sourceFreeRationale });
    }

    const unresolvedQuestions = profile.review.unresolvedQuestions ?? [];
    if (unresolvedQuestions.length > 0) {
      unresolvedQuestionQueue.push({
        ...coinRow(coin),
        confidence: profile.confidence,
        questionCount: unresolvedQuestions.length,
        verified: profile.confidence === "verified",
      });
    }

    for (const control of profile.controls ?? []) {
      if (
        ROUTE_CHECK_MINT_PATHS.has(profile.mintPath) &&
        isMintCapableAbility(control.directMintAbility) &&
        !control.routeChecks
      ) {
        routeCheckQueue.push(controlRow(coin, profile, control, "missing routeChecks"));
      }

      if (control.directMintAbility === "cap-limited" && !control.capDescription) {
        capDescriptionQueue.push(controlRow(coin, profile, control, "cap-limited without capDescription"));
      }

      if (shouldQueueCustodyAttestation(profile, control)) {
        custodyAttestationQueue.push(
          controlRow(coin, profile, control, "EOA mint-capable control mentions custody but lacks attestation"),
        );
      }
    }
  }

  const verifiedWithUnresolvedQuestions = unresolvedQuestionQueue.filter((row) => row.verified).length;
  const activeCoins = coins.filter(activeCoin).length;

  return {
    generatedAt,
    summary: {
      trackedCoins: coins.length,
      activeCoins,
      reviewedProfiles,
      activeMissingReviews: activeMissingReviews.length,
      reviewedButUnscoreable: reviewedButUnscoreable.length,
      routeCheckQueue: routeCheckQueue.length,
      capDescriptionQueue: capDescriptionQueue.length,
      unresolvedQuestionProfiles: unresolvedQuestionQueue.length,
      verifiedWithUnresolvedQuestions,
      sourceFreeProfiles: sourceFreeQueue.length,
      custodyAttestationQueue: custodyAttestationQueue.length,
      sourceUrls: sourceStatsFrom(sourceStats),
    },
    activeMissingReviews: sortRows(activeMissingReviews),
    reviewedButUnscoreable: sortRows(reviewedButUnscoreable),
    routeCheckQueue: sortRows(routeCheckQueue),
    capDescriptionQueue: sortRows(capDescriptionQueue),
    unresolvedQuestionQueue: sortRows(unresolvedQuestionQueue),
    sourceFreeQueue: sortRows(sourceFreeQueue),
    custodyAttestationQueue: sortRows(custodyAttestationQueue),
  };
}

function renderCoinRows(rows: readonly MintAuthorityAuditCoinRow[]): string[] {
  if (rows.length === 0) return ["- None."];
  return rows.map((row) => `- \`${row.coinId}\` (${row.symbol}, ${row.status})`);
}

function renderControlRows(rows: readonly MintAuthorityAuditControlRow[]): string[] {
  if (rows.length === 0) return ["- None."];
  return rows.map(
    (row) =>
      `- \`${row.coinId}\` / ${row.controlLabel}: ${row.reason} (${row.mintPath}, ${row.authorityType}, ${row.directMintAbility})`,
  );
}

export function renderMintAuthorityReviewAuditMarkdown(audit: MintAuthorityReviewAudit): string {
  const summary = audit.summary;
  return [
    "# Mint Authority Review Audit",
    "",
    `Generated: ${audit.generatedAt}`,
    "",
    "Static advisory audit for Mint Authority review queues. This report is not a blocking CI gate.",
    "",
    "## Summary",
    "",
    `- Tracked coins: ${summary.trackedCoins}`,
    `- Active coins: ${summary.activeCoins}`,
    `- Reviewed Mint Authority profiles: ${summary.reviewedProfiles}`,
    `- Active missing reviews: ${summary.activeMissingReviews}`,
    `- Reviewed but unscoreable: ${summary.reviewedButUnscoreable}`,
    `- Route-check queue: ${summary.routeCheckQueue}`,
    `- Cap-description queue: ${summary.capDescriptionQueue}`,
    `- Profiles with unresolved questions: ${summary.unresolvedQuestionProfiles}`,
    `- Verified profiles with unresolved questions: ${summary.verifiedWithUnresolvedQuestions}`,
    `- Source-free profiles: ${summary.sourceFreeProfiles}`,
    `- Custody-attestation queue: ${summary.custodyAttestationQueue}`,
    `- Source URLs: ${summary.sourceUrls.uniqueUrls} unique / ${summary.sourceUrls.totalLinks} links (${summary.sourceUrls.duplicateUrls} duplicate URLs)`,
    "",
    "## Active Missing Reviews",
    "",
    ...renderCoinRows(audit.activeMissingReviews),
    "",
    "## Reviewed But Unscoreable",
    "",
    ...(audit.reviewedButUnscoreable.length === 0
      ? ["- None."]
      : audit.reviewedButUnscoreable.map((row) => `- \`${row.coinId}\` (${row.symbol}): ${row.unresolvedReason}`)),
    "",
    "## Route-Check Queue",
    "",
    ...renderControlRows(audit.routeCheckQueue),
    "",
    "## Cap-Description Queue",
    "",
    ...renderControlRows(audit.capDescriptionQueue),
    "",
    "## Custody-Attestation Queue",
    "",
    ...renderControlRows(audit.custodyAttestationQueue),
    "",
  ].join("\n");
}
