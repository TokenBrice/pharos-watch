#!/usr/bin/env tsx

import type { StablecoinMeta } from "@shared/types";
import type { RedemptionRouteFamily } from "@shared/types/redemption";
import { resolveCapacityConfidence } from "@shared/lib/redemption-backstop-confidence";
import { REDEMPTION_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstop-configs";
import type { RedemptionBackstopConfig } from "@shared/lib/redemption-backstop-configs/shared";
import {
  ACTIVE_STABLECOINS,
  DELISTED_STABLECOINS,
  FROZEN_STABLECOINS,
  PRE_LAUNCH_STABLECOINS,
  QUARANTINED_STABLECOINS,
  TRACKED_STABLECOINS,
} from "@shared/lib/stablecoins/registry";
import { parseCoverageAuditCliArgs, runAsMain, writeOutputFile } from "../lib/coverage-audit-cli";
import {
  REDEMPTION_COVERAGE_DISPOSITIONS,
  REDEMPTION_COVERAGE_REASON_CODES,
  REVIEWED_REDEMPTION_COVERAGE_DISPOSITIONS,
  type RedemptionCoverageDisposition,
  type RedemptionCoverageReasonCode,
  type ReviewedRedemptionCoverageDisposition,
} from "@shared/data/coverage-dispositions/redemption-coverage-dispositions";

export type { RedemptionCoverageDisposition, RedemptionCoverageReasonCode };

export type RedemptionCoverageLifecycle = "active" | "pre-launch" | "quarantined" | "delisted" | "frozen";
export type RedemptionCoverageClassificationSource = "reviewed-registry" | "lifecycle-default";

type AuditCoin = Pick<
  StablecoinMeta,
  "id" | "name" | "symbol" | "status" | "flags" | "links" | "pegMechanism" | "variantOf"
>;

export interface CoverageClassification {
  disposition: RedemptionCoverageDisposition;
  reasonCode: RedemptionCoverageReasonCode | "frozen" | "pre-launch" | "quarantined" | "delisted";
  classificationSource: RedemptionCoverageClassificationSource;
  blocker: string;
  rationale: string;
  evidenceNeeded: string;
  allowedRouteFamilyIfProven: RedemptionRouteFamily | null;
  evidenceUrls: readonly string[];
  reviewer: string | null;
  reviewedDate: string | null;
}

export interface CoverageAuditRow extends CoverageClassification {
  id: string;
  name: string;
  symbol: string;
  lifecycle: RedemptionCoverageLifecycle;
  marketCapRank: number;
}

export interface HeuristicRouteAuditRow {
  id: string;
  routeFamily: RedemptionRouteFamily;
  capacityModel: RedemptionBackstopConfig["capacityModel"]["kind"];
  reviewedDate: string | null;
  blocker: string;
  evidenceNeeded: string;
}

export interface RedemptionCoverageAudit {
  generatedAt: string;
  validationErrors: string[];
  summary: {
    trackedCoins: number;
    configuredRoutes: number;
    activeCoins: number;
    activeConfigured: number;
    activeUnconfigured: number;
    preLaunchUnconfigured: number;
    quarantinedUnconfigured: number;
    delistedUnconfigured: number;
    frozenUnconfigured: number;
    activeUnclassified: number;
    activeDefaultClassified: number;
    heuristicConfiguredRoutes: number;
    validationErrors: number;
  };
  dispositionCounts: Record<RedemptionCoverageDisposition, number>;
  activeUnconfigured: CoverageAuditRow[];
  lifecycleExcludedUnconfigured: CoverageAuditRow[];
  heuristicConfiguredRoutes: HeuristicRouteAuditRow[];
}

export interface RedemptionCoverageAuditCheckFinding {
  code: "active-unclassified-gaps" | "active-default-classified-gaps" | "reviewed-disposition-invalid";
  message: string;
}

function lifecycleForCoin(coin: AuditCoin): RedemptionCoverageLifecycle {
  if (
    coin.status === "pre-launch"
    || coin.status === "quarantined"
    || coin.status === "delisted"
    || coin.status === "frozen"
  ) return coin.status;
  return "active";
}

function toReviewedClassification(row: ReviewedRedemptionCoverageDisposition): CoverageClassification {
  return {
    disposition: row.disposition,
    reasonCode: row.reasonCode,
    classificationSource: "reviewed-registry",
    blocker: row.blocker,
    rationale: row.rationale,
    evidenceNeeded: row.evidenceNeeded,
    allowedRouteFamilyIfProven: row.allowedRouteFamilyIfProven,
    evidenceUrls: row.evidenceUrls,
    reviewer: row.reviewer,
    reviewedDate: row.reviewedDate,
  };
}

function classifyLifecycleExcludedCoin(
  coin: AuditCoin,
  lifecycle: Exclude<RedemptionCoverageLifecycle, "active">,
): CoverageClassification {
  if (lifecycle === "pre-launch") {
    return {
      disposition: "defer",
      reasonCode: "pre-launch",
      classificationSource: "lifecycle-default",
      blocker: "Pre-launch assets are excluded from active route count targets.",
      rationale: "Redemption coverage becomes mandatory only when the asset enters the active lifecycle.",
      evidenceNeeded: "Lifecycle must change to active before source-reviewed route config work.",
      allowedRouteFamilyIfProven: null,
      evidenceUrls: coin.links?.[0]?.url ? [coin.links[0].url] : [],
      reviewer: null,
      reviewedDate: null,
    };
  }

  if (lifecycle === "quarantined") {
    return {
      disposition: "defer",
      reasonCode: "quarantined",
      classificationSource: "lifecycle-default",
      blocker: "Quarantined assets are withheld from active route coverage pending an explicit manual review.",
      rationale: "A quarantined record cannot satisfy active publication or scoring targets.",
      evidenceNeeded: "Resolve the listing review and pass the normal active runtime price and supply gate before reactivation.",
      allowedRouteFamilyIfProven: null,
      evidenceUrls: coin.links?.[0]?.url ? [coin.links[0].url] : [],
      reviewer: null,
      reviewedDate: null,
    };
  }

  if (lifecycle === "delisted") {
    return {
      disposition: "hard-reject",
      reasonCode: "delisted",
      classificationSource: "lifecycle-default",
      blocker: "Delisted assets are outside the Pharos listing scope.",
      rationale: "Historical identity is retained without active redemption-route coverage.",
      evidenceNeeded: "A new listing-policy scope decision would be required before readmission.",
      allowedRouteFamilyIfProven: null,
      evidenceUrls: coin.links?.[0]?.url ? [coin.links[0].url] : [],
      reviewer: null,
      reviewedDate: null,
    };
  }

  return {
    disposition: "hard-reject",
    reasonCode: "frozen",
    classificationSource: "lifecycle-default",
    blocker: "Frozen assets are excluded from active route count targets.",
    rationale: "Frozen assets do not participate in current score production or active route coverage.",
    evidenceNeeded: "Lifecycle must change back to active before route config work.",
    allowedRouteFamilyIfProven: null,
    evidenceUrls: coin.links?.[0]?.url ? [coin.links[0].url] : [],
    reviewer: null,
    reviewedDate: null,
  };
}

function toAuditRow(
  coin: AuditCoin,
  classification: CoverageClassification,
  marketCapRank: number,
  lifecycle: RedemptionCoverageLifecycle = lifecycleForCoin(coin),
): CoverageAuditRow {
  return {
    id: coin.id,
    name: coin.name,
    symbol: coin.symbol,
    lifecycle,
    marketCapRank,
    ...classification,
  };
}

function sortById<T extends { id: string }>(rows: T[]): T[] {
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

const ROUTE_FAMILIES = new Set<RedemptionRouteFamily>([
  "stablecoin-redeem",
  "basket-redeem",
  "collateral-redeem",
  "psm-swap",
  "queue-redeem",
  "offchain-issuer",
]);

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

type ReviewedDispositionValidationInput = {
  reviewedDispositions: readonly ReviewedRedemptionCoverageDisposition[];
  trackedCoins: readonly AuditCoin[];
  activeCoins: readonly AuditCoin[];
  configuredIds: ReadonlySet<string>;
};

function collectReviewedRedemptionDispositionValidation(input: ReviewedDispositionValidationInput): {
  byId: ReadonlyMap<string, ReviewedRedemptionCoverageDisposition>;
  errors: string[];
} {
  const trackedIds = new Set(input.trackedCoins.map((coin) => coin.id));
  const activeIds = new Set(input.activeCoins.map((coin) => coin.id));
  const expectedIds = new Set(
    input.activeCoins.filter((coin) => !input.configuredIds.has(coin.id)).map((coin) => coin.id),
  );
  const byId = new Map<string, ReviewedRedemptionCoverageDisposition>();
  const errors: string[] = [];

  for (const row of input.reviewedDispositions) {
    if (byId.has(row.id)) {
      errors.push(`Duplicate reviewed redemption disposition: ${row.id}`);
      continue;
    }
    byId.set(row.id, row);
    if (!trackedIds.has(row.id)) {
      errors.push(`Reviewed redemption disposition references unknown stablecoin: ${row.id}`);
    }
    if (!activeIds.has(row.id)) {
      errors.push(`Reviewed redemption disposition is stale because the stablecoin is not active: ${row.id}`);
    }
    if (input.configuredIds.has(row.id)) {
      errors.push(`Reviewed redemption disposition is stale because a route is now configured: ${row.id}`);
    }
    if (!REDEMPTION_COVERAGE_DISPOSITIONS.includes(row.disposition)) {
      errors.push(`Reviewed redemption disposition has invalid disposition for ${row.id}`);
    }
    if (!REDEMPTION_COVERAGE_REASON_CODES.includes(row.reasonCode)) {
      errors.push(`Reviewed redemption disposition has invalid reasonCode for ${row.id}`);
    }
    if (!row.blocker.trim() || !row.rationale.trim() || !row.evidenceNeeded.trim() || !row.reviewer.trim()) {
      errors.push(`Reviewed redemption disposition has incomplete review fields for ${row.id}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.reviewedDate) || Number.isNaN(Date.parse(`${row.reviewedDate}T00:00:00Z`))) {
      errors.push(`Reviewed redemption disposition has invalid reviewedDate for ${row.id}`);
    }
    if (row.evidenceUrls.length === 0 || row.evidenceUrls.some((url) => !isHttpUrl(url))) {
      errors.push(`Reviewed redemption disposition has invalid evidenceUrls for ${row.id}`);
    }
    if (new Set(row.evidenceUrls).size !== row.evidenceUrls.length) {
      errors.push(`Reviewed redemption disposition has duplicate evidenceUrls for ${row.id}`);
    }
    if (row.allowedRouteFamilyIfProven !== null && !ROUTE_FAMILIES.has(row.allowedRouteFamilyIfProven)) {
      errors.push(`Reviewed redemption disposition has invalid route family for ${row.id}`);
    }
    if (row.disposition === "add" && row.allowedRouteFamilyIfProven === null) {
      errors.push(`Reviewed redemption add disposition lacks a route family for ${row.id}`);
    }
    if (row.disposition === "hard-reject" && row.allowedRouteFamilyIfProven !== null) {
      errors.push(`Reviewed redemption hard reject must not retain a route family for ${row.id}`);
    }
  }

  const missingIds = [...expectedIds].filter((id) => !byId.has(id)).sort();
  if (missingIds.length > 0) {
    errors.push(`Missing reviewed redemption dispositions for active unconfigured stablecoins: ${missingIds.join(", ")}`);
  }
  return { byId, errors };
}

export function validateReviewedRedemptionDispositions(
  input: ReviewedDispositionValidationInput,
): ReadonlyMap<string, ReviewedRedemptionCoverageDisposition> {
  const validation = collectReviewedRedemptionDispositionValidation(input);
  if (validation.errors.length > 0) throw new Error(validation.errors.join("\n"));
  return validation.byId;
}

export function generateRedemptionCoverageAudit(
  input: {
    trackedCoins?: readonly AuditCoin[];
    activeCoins?: readonly AuditCoin[];
    preLaunchCoins?: readonly AuditCoin[];
    quarantinedCoins?: readonly AuditCoin[];
    delistedCoins?: readonly AuditCoin[];
    frozenCoins?: readonly AuditCoin[];
    configs?: Record<string, RedemptionBackstopConfig>;
    reviewedDispositions?: readonly ReviewedRedemptionCoverageDisposition[];
    generatedAt?: string;
  } = {},
): RedemptionCoverageAudit {
  const trackedCoins = input.trackedCoins ?? TRACKED_STABLECOINS;
  const activeCoins = input.activeCoins ?? ACTIVE_STABLECOINS;
  const preLaunchCoins = input.preLaunchCoins ?? PRE_LAUNCH_STABLECOINS;
  const quarantinedCoins = input.quarantinedCoins
    ?? (input.trackedCoins ? trackedCoins.filter((coin) => coin.status === "quarantined") : QUARANTINED_STABLECOINS);
  const delistedCoins = input.delistedCoins
    ?? (input.trackedCoins ? trackedCoins.filter((coin) => coin.status === "delisted") : DELISTED_STABLECOINS);
  const frozenCoins = input.frozenCoins ?? FROZEN_STABLECOINS;
  const configs = input.configs ?? REDEMPTION_BACKSTOP_CONFIGS;
  const configuredIds = new Set(Object.keys(configs));
  const trackedRankById = new Map(trackedCoins.map((coin, index) => [coin.id, index + 1]));
  const validation = collectReviewedRedemptionDispositionValidation({
    reviewedDispositions: input.reviewedDispositions ?? REVIEWED_REDEMPTION_COVERAGE_DISPOSITIONS,
    trackedCoins,
    activeCoins,
    configuredIds,
  });
  const reviewedById = validation.byId;

  const activeUnconfigured = activeCoins
    .filter((coin) => !configuredIds.has(coin.id))
    .map((coin) => {
      const review = reviewedById.get(coin.id);
      return toAuditRow(
        coin,
        review
          ? toReviewedClassification(review)
          : {
              disposition: "needs-research",
              reasonCode: "documentation-insufficient",
              classificationSource: "lifecycle-default",
              blocker: "Missing reviewed redemption disposition.",
              rationale: "The active unconfigured asset has no source-reviewed coverage disposition.",
              evidenceNeeded: "Add a complete source-reviewed redemption coverage disposition.",
              allowedRouteFamilyIfProven: null,
              evidenceUrls: [],
              reviewer: null,
              reviewedDate: null,
            },
        trackedRankById.get(coin.id) ?? Number.MAX_SAFE_INTEGER,
      );
    });

  const lifecycleExcludedUnconfigured = sortById([
    ...preLaunchCoins
      .filter((coin) => !configuredIds.has(coin.id))
      .map((coin) =>
        toAuditRow(
          coin,
          classifyLifecycleExcludedCoin(coin, "pre-launch"),
          trackedRankById.get(coin.id) ?? Number.MAX_SAFE_INTEGER,
          "pre-launch",
        ),
      ),
    ...frozenCoins
      .filter((coin) => !configuredIds.has(coin.id))
      .map((coin) =>
        toAuditRow(
          coin,
          classifyLifecycleExcludedCoin(coin, "frozen"),
          trackedRankById.get(coin.id) ?? Number.MAX_SAFE_INTEGER,
          "frozen",
        ),
      ),
    ...quarantinedCoins
      .filter((coin) => !configuredIds.has(coin.id))
      .map((coin) =>
        toAuditRow(
          coin,
          classifyLifecycleExcludedCoin(coin, "quarantined"),
          trackedRankById.get(coin.id) ?? Number.MAX_SAFE_INTEGER,
          "quarantined",
        ),
      ),
    ...delistedCoins
      .filter((coin) => !configuredIds.has(coin.id))
      .map((coin) =>
        toAuditRow(
          coin,
          classifyLifecycleExcludedCoin(coin, "delisted"),
          trackedRankById.get(coin.id) ?? Number.MAX_SAFE_INTEGER,
          "delisted",
        ),
      ),
  ]);

  const heuristicConfiguredRoutes = sortById(
    Object.entries(configs)
      .filter(([, config]) => resolveCapacityConfidence(config.capacityModel) === "heuristic")
      .map(([id, config]) => ({
        id,
        routeFamily: config.routeFamily,
        capacityModel: config.capacityModel.kind,
        reviewedDate: config.reviewedAt ?? null,
        blocker: "Configured route still uses heuristic capacity confidence.",
        evidenceNeeded: "Hard route-capacity evidence before promotion to non-heuristic confidence.",
      })),
  );

  const dispositionCounts = {
    add: 0,
    defer: 0,
    "hard-reject": 0,
    "needs-research": 0,
  } satisfies Record<RedemptionCoverageDisposition, number>;
  for (const row of activeUnconfigured) {
    dispositionCounts[row.disposition] += 1;
  }

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    validationErrors: validation.errors,
    summary: {
      trackedCoins: trackedCoins.length,
      configuredRoutes: configuredIds.size,
      activeCoins: activeCoins.length,
      activeConfigured: activeCoins.filter((coin) => configuredIds.has(coin.id)).length,
      activeUnconfigured: activeUnconfigured.length,
      preLaunchUnconfigured: preLaunchCoins.filter((coin) => !configuredIds.has(coin.id)).length,
      quarantinedUnconfigured: quarantinedCoins.filter((coin) => !configuredIds.has(coin.id)).length,
      delistedUnconfigured: delistedCoins.filter((coin) => !configuredIds.has(coin.id)).length,
      frozenUnconfigured: frozenCoins.filter((coin) => !configuredIds.has(coin.id)).length,
      activeUnclassified: activeUnconfigured.filter((row) => !row.disposition || !row.reasonCode).length,
      activeDefaultClassified: activeUnconfigured.filter((row) => row.classificationSource !== "reviewed-registry")
        .length,
      heuristicConfiguredRoutes: heuristicConfiguredRoutes.length,
      validationErrors: validation.errors.length,
    },
    dispositionCounts,
    activeUnconfigured,
    lifecycleExcludedUnconfigured,
    heuristicConfiguredRoutes,
  };
}

function markdownValue(value: string | null): string {
  return value && value.length > 0 ? value.replace(/[\r\n]+/g, " ").replaceAll("|", "\\|") : "TBD";
}

const COVERAGE_ROW_HEADER =
  "market-cap rank | id | lifecycle | current disposition | classification source | blocker | rationale | evidence needed | allowed route family if proven | evidence URLs | reviewer | reviewed date";
const COVERAGE_ROW_SEPARATOR = "--- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---";

function renderCoverageRows(rows: readonly CoverageAuditRow[]): string[] {
  return [
    COVERAGE_ROW_HEADER,
    COVERAGE_ROW_SEPARATOR,
    ...rows.map((row) =>
      [
        String(row.marketCapRank),
        row.id,
        row.lifecycle,
        `${row.disposition} (${row.reasonCode})`,
        row.classificationSource,
        row.blocker,
        row.rationale,
        row.evidenceNeeded,
        row.allowedRouteFamilyIfProven ?? "none",
        row.evidenceUrls.join(" "),
        row.reviewer,
        row.reviewedDate,
      ]
        .map(markdownValue)
        .join(" | "),
    ),
  ];
}

export function renderRedemptionCoverageAuditMarkdown(audit: RedemptionCoverageAudit): string {
  const lines = [
    "# Redemption Backstop v4 Coverage Audit",
    "",
    `Generated: ${audit.generatedAt}`,
    "",
    "## Summary",
    "",
    `- Tracked coins: ${audit.summary.trackedCoins}`,
    `- Configured redemption routes: ${audit.summary.configuredRoutes}`,
    `- Active coins: ${audit.summary.activeCoins}`,
    `- Active configured routes: ${audit.summary.activeConfigured}`,
    `- Active unconfigured gaps: ${audit.summary.activeUnconfigured}`,
    `- Active unclassified gaps: ${audit.summary.activeUnclassified}`,
    `- Active default-classified gaps: ${audit.summary.activeDefaultClassified}`,
    `- Pre-launch unconfigured exclusions: ${audit.summary.preLaunchUnconfigured}`,
    `- Quarantined unconfigured exclusions: ${audit.summary.quarantinedUnconfigured}`,
    `- Delisted unconfigured exclusions: ${audit.summary.delistedUnconfigured}`,
    `- Frozen unconfigured exclusions: ${audit.summary.frozenUnconfigured}`,
    `- Heuristic configured routes for V4-43: ${audit.summary.heuristicConfiguredRoutes}`,
    `- Reviewed disposition validation errors: ${audit.summary.validationErrors}`,
    "",
    "## Reviewed Disposition Validation Errors",
    "",
    ...(audit.validationErrors.length > 0 ? audit.validationErrors.map((error) => `- ${error}`) : ["None."]),
    "",
    "## Active Unconfigured Gaps",
    "",
    ...renderCoverageRows(audit.activeUnconfigured),
    "",
    "## Lifecycle Exclusions",
    "",
    ...renderCoverageRows(audit.lifecycleExcludedUnconfigured),
    "",
    "## V4-43 Heuristic Route Review Queue",
    "",
    "id | route family | capacity model | reviewed date | blocker | evidence needed",
    "--- | --- | --- | --- | --- | ---",
    ...audit.heuristicConfiguredRoutes.map((row) =>
      [row.id, row.routeFamily, row.capacityModel, row.reviewedDate, row.blocker, row.evidenceNeeded]
        .map(markdownValue)
        .join(" | "),
    ),
    "",
  ];

  return `${lines.join("\n").trimEnd()}\n`;
}

type CliOptions = {
  format: "markdown" | "json";
  reportPath: string | null;
  strictActiveGaps: boolean;
  check: boolean;
};

export function parseArgs(argv: string[]): CliOptions {
  return parseCoverageAuditCliArgs(argv, {
    createOptions: (): CliOptions => ({ format: "markdown", reportPath: null, strictActiveGaps: false, check: false }),
    includeCheck: true,
    options: [
      { flag: "--strict-active-gaps", kind: "boolean", apply: (options) => { options.strictActiveGaps = true; } },
    ],
  });
}

export function evaluateRedemptionCoverageAudit(
  audit: RedemptionCoverageAudit,
  options: { strictActiveGaps?: boolean } = {},
): RedemptionCoverageAuditCheckFinding[] {
  const findings: RedemptionCoverageAuditCheckFinding[] = audit.validationErrors.map((message) => ({
    code: "reviewed-disposition-invalid",
    message,
  }));
  if (audit.summary.activeUnclassified > 0) {
    findings.push({
      code: "active-unclassified-gaps",
      message: `Active unconfigured redemption gaps include ${audit.summary.activeUnclassified} unclassified rows.`,
    });
  }
  if (options.strictActiveGaps && audit.summary.activeDefaultClassified > 0) {
    findings.push({
      code: "active-default-classified-gaps",
      message: `Active unconfigured redemption gaps include ${audit.summary.activeDefaultClassified} default-inferred rows.`,
    });
  }
  return findings;
}

export function runCli(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  auditFactory: () => RedemptionCoverageAudit = generateRedemptionCoverageAudit,
): number {
  const options = parseArgs(argv);
  const audit = auditFactory();
  const output =
    options.format === "json" ? `${JSON.stringify(audit, null, 2)}\n` : renderRedemptionCoverageAuditMarkdown(audit);
  const findings = evaluateRedemptionCoverageAudit(audit, { strictActiveGaps: options.strictActiveGaps });

  if (options.reportPath) {
    const target = writeOutputFile(options.reportPath, output, cwd);
    console.log(`Wrote redemption coverage audit to ${target}`);
  } else if (options.check) {
    console.log(
      `Redemption coverage audit check ${findings.length > 0 ? "failed" : "passed"}` +
        `; active-unconfigured=${audit.summary.activeUnconfigured}` +
        `, default-inferred=${audit.summary.activeDefaultClassified}` +
        `, heuristic=${audit.summary.heuristicConfiguredRoutes}.`,
    );
  } else {
    process.stdout.write(output);
  }

  for (const finding of findings) {
    console.error(`${finding.code}: ${finding.message}`);
  }
  return findings.length > 0 ? 1 : 0;
}

runAsMain(import.meta.url, runCli);
