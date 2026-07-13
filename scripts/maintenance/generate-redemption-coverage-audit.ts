#!/usr/bin/env tsx

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { StablecoinMeta } from "../../shared/types";
import type { RedemptionRouteFamily } from "../../shared/types/redemption";
import { resolveCapacityConfidence } from "../../shared/lib/redemption-backstop-confidence";
import { REDEMPTION_BACKSTOP_CONFIGS } from "../../shared/lib/redemption-backstop-configs";
import type { RedemptionBackstopConfig } from "../../shared/lib/redemption-backstop-configs/shared";
import {
  ACTIVE_STABLECOINS,
  FROZEN_STABLECOINS,
  PRE_LAUNCH_STABLECOINS,
  TRACKED_STABLECOINS,
} from "../../shared/lib/stablecoins/registry";
import { writeOutputFile } from "../lib/coverage-audit-cli";
import {
  REDEMPTION_COVERAGE_DISPOSITIONS,
  REDEMPTION_COVERAGE_REASON_CODES,
  REVIEWED_REDEMPTION_COVERAGE_DISPOSITIONS,
  type RedemptionCoverageDisposition,
  type RedemptionCoverageReasonCode,
  type ReviewedRedemptionCoverageDisposition,
} from "../lib/redemption-coverage-dispositions";

export type { RedemptionCoverageDisposition, RedemptionCoverageReasonCode };

export type RedemptionCoverageLifecycle = "active" | "pre-launch" | "frozen";
export type RedemptionCoverageClassificationSource = "reviewed-registry" | "lifecycle-default";

type AuditCoin = Pick<
  StablecoinMeta,
  "id" | "name" | "symbol" | "status" | "flags" | "links" | "pegMechanism" | "variantOf"
>;

export interface CoverageClassification {
  disposition: RedemptionCoverageDisposition;
  reasonCode: RedemptionCoverageReasonCode | "frozen" | "pre-launch";
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
  summary: {
    trackedCoins: number;
    configuredRoutes: number;
    activeCoins: number;
    activeConfigured: number;
    activeUnconfigured: number;
    preLaunchUnconfigured: number;
    frozenUnconfigured: number;
    activeUnclassified: number;
    activeDefaultClassified: number;
    heuristicConfiguredRoutes: number;
  };
  dispositionCounts: Record<RedemptionCoverageDisposition, number>;
  activeUnconfigured: CoverageAuditRow[];
  lifecycleExcludedUnconfigured: CoverageAuditRow[];
  heuristicConfiguredRoutes: HeuristicRouteAuditRow[];
}

export interface RedemptionCoverageAuditBaseline {
  activeDefaultClassified: number;
  activeUnconfigured: number;
  heuristicConfiguredRoutes: number;
}

export interface RedemptionCoverageAuditCheckFinding {
  code:
    | "active-unclassified-gaps"
    | "active-default-classified-gaps"
    | "active-default-classified-ratchet-regressed"
    | "active-unconfigured-ratchet-regressed"
    | "heuristic-configured-ratchet-regressed";
  message: string;
}

const CHECK_BASELINE_PATH = "scripts/lib/redemption-coverage-audit-baseline.json";

function lifecycleForCoin(coin: AuditCoin): RedemptionCoverageLifecycle {
  if (coin.status === "pre-launch" || coin.status === "frozen") return coin.status;
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
  lifecycle: Extract<RedemptionCoverageLifecycle, "pre-launch" | "frozen">,
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

export function validateReviewedRedemptionDispositions(input: {
  reviewedDispositions: readonly ReviewedRedemptionCoverageDisposition[];
  trackedCoins: readonly AuditCoin[];
  activeCoins: readonly AuditCoin[];
  configuredIds: ReadonlySet<string>;
}): ReadonlyMap<string, ReviewedRedemptionCoverageDisposition> {
  const trackedIds = new Set(input.trackedCoins.map((coin) => coin.id));
  const activeIds = new Set(input.activeCoins.map((coin) => coin.id));
  const expectedIds = new Set(
    input.activeCoins.filter((coin) => !input.configuredIds.has(coin.id)).map((coin) => coin.id),
  );
  const byId = new Map<string, ReviewedRedemptionCoverageDisposition>();

  for (const row of input.reviewedDispositions) {
    if (byId.has(row.id)) {
      throw new Error(`Duplicate reviewed redemption disposition: ${row.id}`);
    }
    if (!trackedIds.has(row.id)) {
      throw new Error(`Reviewed redemption disposition references unknown stablecoin: ${row.id}`);
    }
    if (!activeIds.has(row.id)) {
      throw new Error(`Reviewed redemption disposition is stale because the stablecoin is not active: ${row.id}`);
    }
    if (input.configuredIds.has(row.id)) {
      throw new Error(`Reviewed redemption disposition is stale because a route is now configured: ${row.id}`);
    }
    if (!REDEMPTION_COVERAGE_DISPOSITIONS.includes(row.disposition)) {
      throw new Error(`Reviewed redemption disposition has invalid disposition for ${row.id}`);
    }
    if (!REDEMPTION_COVERAGE_REASON_CODES.includes(row.reasonCode)) {
      throw new Error(`Reviewed redemption disposition has invalid reasonCode for ${row.id}`);
    }
    if (!row.blocker.trim() || !row.rationale.trim() || !row.evidenceNeeded.trim() || !row.reviewer.trim()) {
      throw new Error(`Reviewed redemption disposition has incomplete review fields for ${row.id}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.reviewedDate) || Number.isNaN(Date.parse(`${row.reviewedDate}T00:00:00Z`))) {
      throw new Error(`Reviewed redemption disposition has invalid reviewedDate for ${row.id}`);
    }
    if (row.evidenceUrls.length === 0 || row.evidenceUrls.some((url) => !isHttpUrl(url))) {
      throw new Error(`Reviewed redemption disposition has invalid evidenceUrls for ${row.id}`);
    }
    if (new Set(row.evidenceUrls).size !== row.evidenceUrls.length) {
      throw new Error(`Reviewed redemption disposition has duplicate evidenceUrls for ${row.id}`);
    }
    if (row.allowedRouteFamilyIfProven !== null && !ROUTE_FAMILIES.has(row.allowedRouteFamilyIfProven)) {
      throw new Error(`Reviewed redemption disposition has invalid route family for ${row.id}`);
    }
    if (row.disposition === "add" && row.allowedRouteFamilyIfProven === null) {
      throw new Error(`Reviewed redemption add disposition lacks a route family for ${row.id}`);
    }
    if (row.disposition === "hard-reject" && row.allowedRouteFamilyIfProven !== null) {
      throw new Error(`Reviewed redemption hard reject must not retain a route family for ${row.id}`);
    }
    byId.set(row.id, row);
  }

  const missingIds = [...expectedIds].filter((id) => !byId.has(id)).sort();
  if (missingIds.length > 0) {
    throw new Error(
      `Missing reviewed redemption dispositions for active unconfigured stablecoins: ${missingIds.join(", ")}`,
    );
  }
  return byId;
}

export function generateRedemptionCoverageAudit(
  input: {
    trackedCoins?: readonly AuditCoin[];
    activeCoins?: readonly AuditCoin[];
    preLaunchCoins?: readonly AuditCoin[];
    frozenCoins?: readonly AuditCoin[];
    configs?: Record<string, RedemptionBackstopConfig>;
    reviewedDispositions?: readonly ReviewedRedemptionCoverageDisposition[];
    generatedAt?: string;
  } = {},
): RedemptionCoverageAudit {
  const trackedCoins = input.trackedCoins ?? TRACKED_STABLECOINS;
  const activeCoins = input.activeCoins ?? ACTIVE_STABLECOINS;
  const preLaunchCoins = input.preLaunchCoins ?? PRE_LAUNCH_STABLECOINS;
  const frozenCoins = input.frozenCoins ?? FROZEN_STABLECOINS;
  const configs = input.configs ?? REDEMPTION_BACKSTOP_CONFIGS;
  const configuredIds = new Set(Object.keys(configs));
  const trackedRankById = new Map(trackedCoins.map((coin, index) => [coin.id, index + 1]));
  const reviewedById = validateReviewedRedemptionDispositions({
    reviewedDispositions: input.reviewedDispositions ?? REVIEWED_REDEMPTION_COVERAGE_DISPOSITIONS,
    trackedCoins,
    activeCoins,
    configuredIds,
  });

  const activeUnconfigured = activeCoins
    .filter((coin) => !configuredIds.has(coin.id))
    .map((coin) => {
      const review = reviewedById.get(coin.id);
      if (!review) throw new Error(`Missing reviewed redemption disposition after validation: ${coin.id}`);
      return toAuditRow(
        coin,
        toReviewedClassification(review),
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
    summary: {
      trackedCoins: trackedCoins.length,
      configuredRoutes: configuredIds.size,
      activeCoins: activeCoins.length,
      activeConfigured: activeCoins.filter((coin) => configuredIds.has(coin.id)).length,
      activeUnconfigured: activeUnconfigured.length,
      preLaunchUnconfigured: preLaunchCoins.filter((coin) => !configuredIds.has(coin.id)).length,
      frozenUnconfigured: frozenCoins.filter((coin) => !configuredIds.has(coin.id)).length,
      activeUnclassified: activeUnconfigured.filter((row) => !row.disposition || !row.reasonCode).length,
      activeDefaultClassified: activeUnconfigured.filter((row) => row.classificationSource !== "reviewed-registry")
        .length,
      heuristicConfiguredRoutes: heuristicConfiguredRoutes.length,
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
    `- Frozen unconfigured exclusions: ${audit.summary.frozenUnconfigured}`,
    `- Heuristic configured routes for V4-43: ${audit.summary.heuristicConfiguredRoutes}`,
    "",
    "## Active Unconfigured Gaps",
    "",
    ...renderCoverageRows(audit.activeUnconfigured),
    "",
    "## Pre-launch And Frozen Exclusions",
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

export function parseArgs(argv: string[]): {
  format: "markdown" | "json";
  reportPath: string | null;
  strictActiveGaps: boolean;
  check: boolean;
} {
  let format: "markdown" | "json" = "markdown";
  let reportPath: string | null = null;
  let strictActiveGaps = false;
  let check = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      format = "json";
      continue;
    }
    if (arg === "--markdown") {
      format = "markdown";
      continue;
    }
    if (arg === "--strict-active-gaps") {
      strictActiveGaps = true;
      continue;
    }
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg === "--report") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--report requires a path");
      }
      reportPath = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { format, reportPath, strictActiveGaps, check };
}

export function loadRedemptionCoverageAuditBaseline(cwd = process.cwd()): RedemptionCoverageAuditBaseline {
  const baseline = JSON.parse(readFileSync(resolve(cwd, CHECK_BASELINE_PATH), "utf8")) as Record<string, unknown>;
  const readBaselineCount = (key: keyof RedemptionCoverageAuditBaseline): number => {
    const value = baseline[key];
    if (!Number.isInteger(value) || (value as number) < 0) {
      throw new Error(`${CHECK_BASELINE_PATH} has invalid ${key} baseline`);
    }
    return value as number;
  };
  return {
    activeDefaultClassified: readBaselineCount("activeDefaultClassified"),
    activeUnconfigured: readBaselineCount("activeUnconfigured"),
    heuristicConfiguredRoutes: readBaselineCount("heuristicConfiguredRoutes"),
  };
}

export function evaluateRedemptionCoverageAudit(
  audit: RedemptionCoverageAudit,
  options: {
    strictActiveGaps?: boolean;
    baseline?: RedemptionCoverageAuditBaseline | null;
  } = {},
): RedemptionCoverageAuditCheckFinding[] {
  const findings: RedemptionCoverageAuditCheckFinding[] = [];
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
  if (options.baseline) {
    if (audit.summary.activeDefaultClassified > options.baseline.activeDefaultClassified) {
      findings.push({
        code: "active-default-classified-ratchet-regressed",
        message: `Default-inferred active redemption gaps increased to ${audit.summary.activeDefaultClassified} (baseline ${options.baseline.activeDefaultClassified}).`,
      });
    }
    if (audit.summary.activeUnconfigured > options.baseline.activeUnconfigured) {
      findings.push({
        code: "active-unconfigured-ratchet-regressed",
        message: `Active unconfigured redemption gaps increased to ${audit.summary.activeUnconfigured} (baseline ${options.baseline.activeUnconfigured}).`,
      });
    }
    if (audit.summary.heuristicConfiguredRoutes > options.baseline.heuristicConfiguredRoutes) {
      findings.push({
        code: "heuristic-configured-ratchet-regressed",
        message: `Heuristic configured redemption routes increased to ${audit.summary.heuristicConfiguredRoutes} (baseline ${options.baseline.heuristicConfiguredRoutes}).`,
      });
    }
  }
  return findings;
}

export function runCli(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  auditFactory: () => RedemptionCoverageAudit = generateRedemptionCoverageAudit,
  baseline: RedemptionCoverageAuditBaseline | null = null,
): number {
  const options = parseArgs(argv);
  const audit = auditFactory();
  const output =
    options.format === "json" ? `${JSON.stringify(audit, null, 2)}\n` : renderRedemptionCoverageAuditMarkdown(audit);
  const checkBaseline = options.check ? (baseline ?? loadRedemptionCoverageAuditBaseline()) : null;
  const findings = evaluateRedemptionCoverageAudit(audit, {
    strictActiveGaps: options.strictActiveGaps,
    baseline: checkBaseline,
  });

  if (options.reportPath) {
    const target = writeOutputFile(options.reportPath, output, cwd);
    console.log(`Wrote redemption coverage audit to ${target}`);
  } else if (options.check) {
    const baselineDetail = checkBaseline
      ? `; default-inferred=${audit.summary.activeDefaultClassified}/${checkBaseline.activeDefaultClassified}, active-unconfigured=${audit.summary.activeUnconfigured}/${checkBaseline.activeUnconfigured}, heuristic=${audit.summary.heuristicConfiguredRoutes}/${checkBaseline.heuristicConfiguredRoutes}`
      : "";
    console.log(`Redemption coverage audit check ${findings.length > 0 ? "failed" : "passed"}${baselineDetail}.`);
  } else {
    process.stdout.write(output);
  }

  for (const finding of findings) {
    console.error(`${finding.code}: ${finding.message}`);
  }
  return findings.length > 0 ? 1 : 0;
}

if (process.argv[1]?.endsWith("generate-redemption-coverage-audit.ts")) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
