import { isActiveStablecoinMeta } from "@shared/lib/stablecoins/status";
import { findCommonCriticalControls } from "@shared/lib/control-identities";
import type { MintAuthorityControl, MintAuthorityProfile, StablecoinLink, StablecoinMeta } from "@shared/types";

const ROUTE_CHECK_MINT_PATHS = new Set<MintAuthorityProfile["mintPath"]>([
  "bridge-or-oft-synthetic",
  "offchain-attested-minter",
  "m0-permissioned-minter",
]);

/**
 * Abilities that let a control create durable supply. This is a curation
 * predicate over reviewed metadata, not a scoring input: the queues below use
 * it to decide which controls still owe evidence. Safety Score V9 derives its
 * own mint capability set from the same field in the fact compiler.
 */
const MINT_CAPABLE_ABILITIES = new Set<MintAuthorityControl["directMintAbility"]>([
  "direct",
  "can-authorize",
  "cap-limited",
  "upgrade-only",
]);

function isMintCapableAbility(ability: MintAuthorityControl["directMintAbility"]): boolean {
  return MINT_CAPABLE_ABILITIES.has(ability);
}

const KEY_CUSTODY_PROSE_PATTERN = /\b(mpc|hsm|fireblocks|key management|key custody|signing key)\b/i;

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

export interface MintAuthorityAuditIncidentRow extends MintAuthorityAuditCoinRow {
  activeDates: string[];
}

export interface MintAuthorityAuditCommonControlRow extends MintAuthorityAuditCoinRow {
  key: string;
  paths: string[];
  labels: string[];
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
    routeCheckQueue: number;
    capDescriptionQueue: number;
    unresolvedQuestionProfiles: number;
    verifiedWithUnresolvedQuestions: number;
    sourceFreeProfiles: number;
    custodyAttestationQueue: number;
    explicitUnresolvedProfiles: number;
    activeIncidentProfiles: number;
    missingUpgradeabilityProfiles: number;
    unknownUpgradeabilityProfiles: number;
    controlsMissingObservation: number;
    commonCriticalControls: number;
    sourceUrls: MintAuthorityAuditSourceStats;
  };
  activeMissingReviews: MintAuthorityAuditCoinRow[];
  routeCheckQueue: MintAuthorityAuditControlRow[];
  capDescriptionQueue: MintAuthorityAuditControlRow[];
  unresolvedQuestionQueue: MintAuthorityAuditUnresolvedRow[];
  sourceFreeQueue: MintAuthorityAuditSourceFreeRow[];
  custodyAttestationQueue: MintAuthorityAuditControlRow[];
  explicitUnresolvedProfiles: MintAuthorityAuditUnresolvedRow[];
  activeIncidentProfiles: MintAuthorityAuditIncidentRow[];
  missingUpgradeabilityQueue: MintAuthorityAuditCoinRow[];
  unknownUpgradeabilityQueue: MintAuthorityAuditCoinRow[];
  controlObservationQueue: MintAuthorityAuditControlRow[];
  commonControlQueue: MintAuthorityAuditCommonControlRow[];
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
  collectLinksFromSources(links, profile.upgradeability?.sources);
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

function proseForCustodyScan(control: MintAuthorityControl): string {
  return [control.label, control.evidence, ...(control.sources ?? []).flatMap((source) => [source.label, source.url])]
    .filter(Boolean)
    .join("\n");
}

function shouldQueueCustodyAttestation(control: MintAuthorityControl): boolean {
  if (control.authorityType !== "eoa") return false;
  if (!isMintCapableAbility(control.directMintAbility)) return false;
  if (control.keyCustodyAttestation) return false;
  return KEY_CUSTODY_PROSE_PATTERN.test(proseForCustodyScan(control));
}

function sortRows<T extends { coinId: string }>(rows: T[]): T[] {
  return rows.sort((a, b) => a.coinId.localeCompare(b.coinId));
}

export function buildMintAuthorityReviewAudit({
  coins,
  generatedAt = new Date().toISOString(),
}: BuildMintAuthorityReviewAuditOptions): MintAuthorityReviewAudit {
  const sourceStats = { totalLinks: 0, urls: new Map<string, number>() };

  const activeMissingReviews: MintAuthorityAuditCoinRow[] = [];
  const routeCheckQueue: MintAuthorityAuditControlRow[] = [];
  const capDescriptionQueue: MintAuthorityAuditControlRow[] = [];
  const unresolvedQuestionQueue: MintAuthorityAuditUnresolvedRow[] = [];
  const sourceFreeQueue: MintAuthorityAuditSourceFreeRow[] = [];
  const custodyAttestationQueue: MintAuthorityAuditControlRow[] = [];
  const explicitUnresolvedProfiles: MintAuthorityAuditUnresolvedRow[] = [];
  const activeIncidentProfiles: MintAuthorityAuditIncidentRow[] = [];
  const missingUpgradeabilityQueue: MintAuthorityAuditCoinRow[] = [];
  const unknownUpgradeabilityQueue: MintAuthorityAuditCoinRow[] = [];
  const controlObservationQueue: MintAuthorityAuditControlRow[] = [];
  const commonControlQueue: MintAuthorityAuditCommonControlRow[] = [];
  let reviewedProfiles = 0;

  for (const coin of coins) {
    const profile = coin.mintAuthority;
    if (!profile) {
      if (activeCoin(coin)) activeMissingReviews.push(coinRow(coin));
      continue;
    }

    reviewedProfiles += 1;
    appendSourceStats(sourceStats, collectMintAuthoritySources(profile));

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
      if (profile.review.disposition === "unresolved") {
        explicitUnresolvedProfiles.push({
          ...coinRow(coin),
          confidence: profile.confidence,
          questionCount: unresolvedQuestions.length,
          verified: false,
        });
      }
    }

    const activeIncidentDates = (profile.mintIncidents ?? [])
      .filter((incident) => incident.status === "active")
      .map((incident) => incident.date)
      .sort();
    if (activeIncidentDates.length > 0) {
      activeIncidentProfiles.push({ ...coinRow(coin), activeDates: activeIncidentDates });
    }

    if (activeCoin(coin) && profile.upgradeability == null) {
      missingUpgradeabilityQueue.push(coinRow(coin));
    } else if (activeCoin(coin) && profile.upgradeability?.model === "unknown") {
      unknownUpgradeabilityQueue.push(coinRow(coin));
    }

    for (const common of findCommonCriticalControls(coin)) {
      commonControlQueue.push({ ...coinRow(coin), ...common });
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

      if (shouldQueueCustodyAttestation(control)) {
        custodyAttestationQueue.push(
          controlRow(coin, profile, control, "EOA mint-capable control mentions custody but lacks attestation"),
        );
      }
      if (
        control.address != null &&
        control.observedAt == null &&
        control.observedBlock == null &&
        control.safe?.observedAt == null &&
        control.safe?.observedBlock == null
      ) {
        controlObservationQueue.push(
          controlRow(coin, profile, control, "addressed control lacks observedAt/observedBlock"),
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
      routeCheckQueue: routeCheckQueue.length,
      capDescriptionQueue: capDescriptionQueue.length,
      unresolvedQuestionProfiles: unresolvedQuestionQueue.length,
      verifiedWithUnresolvedQuestions,
      sourceFreeProfiles: sourceFreeQueue.length,
      custodyAttestationQueue: custodyAttestationQueue.length,
      explicitUnresolvedProfiles: explicitUnresolvedProfiles.length,
      activeIncidentProfiles: activeIncidentProfiles.length,
      missingUpgradeabilityProfiles: missingUpgradeabilityQueue.length,
      unknownUpgradeabilityProfiles: unknownUpgradeabilityQueue.length,
      controlsMissingObservation: controlObservationQueue.length,
      commonCriticalControls: commonControlQueue.length,
      sourceUrls: sourceStatsFrom(sourceStats),
    },
    activeMissingReviews: sortRows(activeMissingReviews),
    routeCheckQueue: sortRows(routeCheckQueue),
    capDescriptionQueue: sortRows(capDescriptionQueue),
    unresolvedQuestionQueue: sortRows(unresolvedQuestionQueue),
    sourceFreeQueue: sortRows(sourceFreeQueue),
    custodyAttestationQueue: sortRows(custodyAttestationQueue),
    explicitUnresolvedProfiles: sortRows(explicitUnresolvedProfiles),
    activeIncidentProfiles: sortRows(activeIncidentProfiles),
    missingUpgradeabilityQueue: sortRows(missingUpgradeabilityQueue),
    unknownUpgradeabilityQueue: sortRows(unknownUpgradeabilityQueue),
    controlObservationQueue: sortRows(controlObservationQueue),
    commonControlQueue: sortRows(commonControlQueue),
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
    `- Route-check queue: ${summary.routeCheckQueue}`,
    `- Cap-description queue: ${summary.capDescriptionQueue}`,
    `- Profiles with unresolved questions: ${summary.unresolvedQuestionProfiles}`,
    `- Verified profiles with unresolved questions: ${summary.verifiedWithUnresolvedQuestions}`,
    `- Source-free profiles: ${summary.sourceFreeProfiles}`,
    `- Custody-attestation queue: ${summary.custodyAttestationQueue}`,
    `- Explicit unresolved dispositions: ${summary.explicitUnresolvedProfiles}`,
    `- Active incident profiles: ${summary.activeIncidentProfiles}`,
    `- Missing upgradeability profiles: ${summary.missingUpgradeabilityProfiles}`,
    `- Unknown upgradeability profiles: ${summary.unknownUpgradeabilityProfiles}`,
    `- Addressed controls missing an observation point: ${summary.controlsMissingObservation}`,
    `- Reused critical controls: ${summary.commonCriticalControls}`,
    `- Source URLs: ${summary.sourceUrls.uniqueUrls} unique / ${summary.sourceUrls.totalLinks} links (${summary.sourceUrls.duplicateUrls} duplicate URLs)`,
    "",
    "## Active Missing Reviews",
    "",
    ...renderCoinRows(audit.activeMissingReviews),
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
    "## Explicit Unresolved Dispositions",
    "",
    ...renderCoinRows(audit.explicitUnresolvedProfiles),
    "",
    "## Active Incidents",
    "",
    ...(audit.activeIncidentProfiles.length === 0
      ? ["- None."]
      : audit.activeIncidentProfiles.map((row) => `- \`${row.coinId}\`: ${row.activeDates.join(", ")}`)),
    "",
    "## Upgradeability Backfill Queue",
    "",
    ...renderCoinRows(audit.missingUpgradeabilityQueue),
    "",
    "## Control Observation Queue",
    "",
    ...renderControlRows(audit.controlObservationQueue),
    "",
  ].join("\n");
}
