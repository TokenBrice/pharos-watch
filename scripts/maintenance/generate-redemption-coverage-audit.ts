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

export type RedemptionCoverageDisposition = "add" | "defer" | "hard-reject" | "needs-research";

export type RedemptionCoverageReasonCode =
  | "borrower-repay-only"
  | "capacity-unpublished"
  | "frozen"
  | "issuer-terms-missing"
  | "no-holder-route"
  | "pegkeeper-only"
  | "pre-launch"
  | "source-review-needed";

export type RedemptionCoverageLifecycle = "active" | "pre-launch" | "frozen";
export type RedemptionCoverageClassificationSource = "curated" | "default-inferred";

type AuditCoin = Pick<
  StablecoinMeta,
  "id" | "name" | "symbol" | "status" | "flags" | "links" | "pegMechanism" | "variantOf"
>;

export interface CoverageClassification {
  disposition: RedemptionCoverageDisposition;
  reasonCode: RedemptionCoverageReasonCode;
  classificationSource: RedemptionCoverageClassificationSource;
  blocker: string;
  evidenceNeeded: string;
  allowedRouteFamilyIfProven: RedemptionRouteFamily | null;
  sourceLink: string | null;
  reviewedDate: string | null;
}

export interface CoverageAuditRow extends CoverageClassification {
  id: string;
  name: string;
  symbol: string;
  lifecycle: RedemptionCoverageLifecycle;
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

const OFFCHAIN_CANDIDATES = new Set(["mmxn-moneta-digital", "vndc-jade-labs", "zkusd-goal3"]);
const WRAPPER_OR_NAV_CANDIDATES = new Set(["iusd-initia", "susd1plus-lorenzo", "witry-brix", "inalpha-nest"]);
const PROTOCOL_RESEARCH_CANDIDATES = new Set(["hollar-hydrated", "crvusd-curve"]);
const PROTOCOL_DEFER_CANDIDATES = new Set([
  "mim-abracadabra",
  "mai-qidao",
  "usdx-kava",
  "usdh-hubble",
  "bnusd-balanced",
  "fxd-fathom",
  "iusd-indigo-protocol",
  "pht-pht",
  "nxusd-nereus",
]);
const PROTOCOL_HARD_REJECTS = new Set([
  "frax-frax",
  "usg-tangent",
  "xtusd-xt",
  "usdv-solomon",
  "spusd-soulpeg",
  "jusd-jusd-stable-token",
  "usdr-ring",
  "gramg-token-teknoloji",
  "grams-token-teknoloji",
]);

function lifecycleForCoin(coin: AuditCoin): RedemptionCoverageLifecycle {
  if (coin.status === "pre-launch" || coin.status === "frozen") return coin.status;
  return "active";
}

function firstSourceLink(coin: AuditCoin): string | null {
  return coin.links?.[0]?.url ?? null;
}

function classifyActiveUnconfiguredCoin(coin: AuditCoin): CoverageClassification {
  if (OFFCHAIN_CANDIDATES.has(coin.id)) {
    return {
      disposition: "needs-research",
      reasonCode: "issuer-terms-missing",
      classificationSource: "curated",
      blocker: "Official holder redemption terms have not been source-reviewed for v4.",
      evidenceNeeded: "Holder eligibility, output asset, mechanics, capacity basis, fees, and settlement timing.",
      allowedRouteFamilyIfProven: "offchain-issuer",
      sourceLink: firstSourceLink(coin),
      reviewedDate: null,
    };
  }

  if (WRAPPER_OR_NAV_CANDIDATES.has(coin.id)) {
    return {
      disposition: "needs-research",
      reasonCode: "capacity-unpublished",
      classificationSource: "curated",
      blocker: "Wrapper, vault, or NAV exit has not been source-reviewed for holder exercisability and capacity.",
      evidenceNeeded:
        "App or contract redemption docs, downstream dependency, output asset, cooldown/queue terms, and capacity source.",
      allowedRouteFamilyIfProven: coin.flags?.navToken ? "queue-redeem" : "stablecoin-redeem",
      sourceLink: firstSourceLink(coin),
      reviewedDate: null,
    };
  }

  if (PROTOCOL_RESEARCH_CANDIDATES.has(coin.id)) {
    return {
      disposition: "needs-research",
      reasonCode: coin.id === "crvusd-curve" ? "pegkeeper-only" : "capacity-unpublished",
      classificationSource: "curated",
      blocker: "Protocol route requires strict proof of broad holder-exercisable redemption.",
      evidenceNeeded:
        "Official docs or audited contract evidence proving holder redemption beyond market-operations routes.",
      allowedRouteFamilyIfProven: "collateral-redeem",
      sourceLink: firstSourceLink(coin),
      reviewedDate: null,
    };
  }

  if (PROTOCOL_DEFER_CANDIDATES.has(coin.id)) {
    return {
      disposition: "defer",
      reasonCode: "no-holder-route",
      classificationSource: "curated",
      blocker: "No broad holder-exercisable route is accepted without new public source evidence.",
      evidenceNeeded: "Official redemption docs or audited callable route available to ordinary holders.",
      allowedRouteFamilyIfProven: "collateral-redeem",
      sourceLink: firstSourceLink(coin),
      reviewedDate: null,
    };
  }

  if (PROTOCOL_HARD_REJECTS.has(coin.id)) {
    return {
      disposition: "hard-reject",
      reasonCode: "no-holder-route",
      classificationSource: "curated",
      blocker: "V4 plan marks this as a hard reject until new public terms prove holder redemption.",
      evidenceNeeded: "New issuer or protocol terms proving a holder-exercisable redemption route.",
      allowedRouteFamilyIfProven: null,
      sourceLink: firstSourceLink(coin),
      reviewedDate: null,
    };
  }

  return {
    disposition: "needs-research",
    reasonCode: "source-review-needed",
    classificationSource: "default-inferred",
    blocker: "Active unconfigured coin has not yet been source-reviewed for v4 redemption coverage.",
    evidenceNeeded:
      "Official issuer/protocol docs, audited contracts, or live API/onchain evidence for route, capacity, fees, access, and settlement.",
    allowedRouteFamilyIfProven: inferLikelyRouteFamily(coin),
    sourceLink: firstSourceLink(coin),
    reviewedDate: null,
  };
}

function inferLikelyRouteFamily(coin: AuditCoin): RedemptionRouteFamily | null {
  if (coin.flags?.navToken || coin.variantOf) return "queue-redeem";
  if (coin.flags?.governance === "centralized") return "offchain-issuer";
  if (coin.flags?.backing === "crypto-backed") return "collateral-redeem";
  return null;
}

function classifyLifecycleExcludedCoin(
  coin: AuditCoin,
  lifecycle: Extract<RedemptionCoverageLifecycle, "pre-launch" | "frozen">,
): CoverageClassification {
  if (lifecycle === "pre-launch") {
    return {
      disposition: "defer",
      reasonCode: "pre-launch",
      classificationSource: "curated",
      blocker: "Pre-launch assets are excluded from active route count targets.",
      evidenceNeeded: "Lifecycle must change to active before source-reviewed route config work.",
      allowedRouteFamilyIfProven: null,
      sourceLink: firstSourceLink(coin),
      reviewedDate: null,
    };
  }

  return {
    disposition: "hard-reject",
    reasonCode: "frozen",
    classificationSource: "curated",
    blocker: "Frozen assets are excluded from active route count targets.",
    evidenceNeeded: "Lifecycle must change back to active before route config work.",
    allowedRouteFamilyIfProven: null,
    sourceLink: firstSourceLink(coin),
    reviewedDate: null,
  };
}

function toAuditRow(
  coin: AuditCoin,
  classification: CoverageClassification,
  lifecycle: RedemptionCoverageLifecycle = lifecycleForCoin(coin),
): CoverageAuditRow {
  return {
    id: coin.id,
    name: coin.name,
    symbol: coin.symbol,
    lifecycle,
    ...classification,
  };
}

function sortById<T extends { id: string }>(rows: T[]): T[] {
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

export function generateRedemptionCoverageAudit(
  input: {
    trackedCoins?: readonly AuditCoin[];
    activeCoins?: readonly AuditCoin[];
    preLaunchCoins?: readonly AuditCoin[];
    frozenCoins?: readonly AuditCoin[];
    configs?: Record<string, RedemptionBackstopConfig>;
    generatedAt?: string;
  } = {},
): RedemptionCoverageAudit {
  const trackedCoins = input.trackedCoins ?? TRACKED_STABLECOINS;
  const activeCoins = input.activeCoins ?? ACTIVE_STABLECOINS;
  const preLaunchCoins = input.preLaunchCoins ?? PRE_LAUNCH_STABLECOINS;
  const frozenCoins = input.frozenCoins ?? FROZEN_STABLECOINS;
  const configs = input.configs ?? REDEMPTION_BACKSTOP_CONFIGS;
  const configuredIds = new Set(Object.keys(configs));

  const activeUnconfigured = sortById(
    activeCoins
      .filter((coin) => !configuredIds.has(coin.id))
      .map((coin) => toAuditRow(coin, classifyActiveUnconfiguredCoin(coin))),
  );

  const lifecycleExcludedUnconfigured = sortById([
    ...preLaunchCoins
      .filter((coin) => !configuredIds.has(coin.id))
      .map((coin) => toAuditRow(coin, classifyLifecycleExcludedCoin(coin, "pre-launch"), "pre-launch")),
    ...frozenCoins
      .filter((coin) => !configuredIds.has(coin.id))
      .map((coin) => toAuditRow(coin, classifyLifecycleExcludedCoin(coin, "frozen"), "frozen")),
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
      activeDefaultClassified: activeUnconfigured.filter((row) => row.classificationSource === "default-inferred")
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
  "id | lifecycle | current disposition | classification source | blocker | evidence needed | allowed route family if proven | source link | reviewed date";
const COVERAGE_ROW_SEPARATOR = "--- | --- | --- | --- | --- | --- | --- | --- | ---";

function renderCoverageRows(rows: readonly CoverageAuditRow[]): string[] {
  return [
    COVERAGE_ROW_HEADER,
    COVERAGE_ROW_SEPARATOR,
    ...rows.map((row) =>
      [
        row.id,
        row.lifecycle,
        `${row.disposition} (${row.reasonCode})`,
        row.classificationSource,
        row.blocker,
        row.evidenceNeeded,
        row.allowedRouteFamilyIfProven ?? "TBD",
        row.sourceLink,
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
