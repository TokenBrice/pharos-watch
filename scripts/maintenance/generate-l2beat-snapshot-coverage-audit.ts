#!/usr/bin/env tsx

import { existsSync } from "node:fs";
import {
  buildL2BeatChainCoverageAudit,
  type L2BeatChainCoverageAudit,
} from "@shared/lib/chains/l2beat-audit";
import {
  L2BEAT_CHAIN_RISK_FIELD_LABELS,
  L2BEAT_CHAIN_RISK_FIELDS,
  L2BEAT_CHAIN_RISK_SNAPSHOT,
  type L2BeatChainRiskSnapshot,
  type L2BeatRiskField,
} from "@shared/lib/chains/l2beat-risk";
import {
  isRecord,
  markdownValue,
  readJsonFile,
  resolveGeneratedAt,
  runAsMain,
  stringValue,
  writeOutputFile,
} from "../lib/coverage-audit-cli";

const L2BEAT_SUMMARY_URL = "https://l2beat.com/api/scaling/summary";

interface CliOptions {
  inputPath: string | null;
  live: boolean;
  format: "markdown" | "json";
  reportPath: string | null;
  check: boolean;
  generatedAt: string | null;
}

type DriftKind =
  | "missing-live-project"
  | "metadata-changed"
  | "stage-changed"
  | "risk-value-changed"
  | "risk-sentiment-changed";

interface ObservedProject {
  id: string;
  slug: string;
  name: string;
  type: string;
  category: string;
  hostChain: string;
  stage: string;
  isUnderReview: boolean;
  risks: Partial<Record<L2BeatRiskField, { value: string; sentiment: string }>>;
}

interface SnapshotDriftRow {
  projectId: string;
  field: string;
  current: string;
  observed: string;
  kind: DriftKind;
}

interface L2BeatSnapshotCoverageAudit {
  coverage: L2BeatChainCoverageAudit;
  observedSource: "none" | "input" | "live";
  driftRows: SnapshotDriftRow[];
  observedOnlyProjects: string[];
}

const RISK_FIELD_BY_LABEL = new Map<string, L2BeatRiskField>(
  L2BEAT_CHAIN_RISK_FIELDS.map((field) => [L2BEAT_CHAIN_RISK_FIELD_LABELS[field], field]),
);

function usage(): string {
  return [
    "Usage: tsx scripts/maintenance/generate-l2beat-snapshot-coverage-audit.ts [options]",
    "",
    "Options:",
    "  --input <path>        Compare the checked-in snapshot to a saved L2BEAT summary JSON payload",
    "  --live                Fetch https://l2beat.com/api/scaling/summary for an advisory drift comparison",
    "  --json                Print JSON instead of Markdown",
    "  --markdown            Print Markdown (default)",
    "  --report <path>       Write output to a file instead of stdout",
    "  --check               Exit non-zero on alias-integrity issues or consumed-field drift",
    "  --generated-at <iso>  Override generated timestamp; use 'now' for current time",
    "  --help, -h            Show this help text",
  ].join("\n");
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    inputPath: null,
    live: false,
    format: "markdown",
    reportPath: null,
    check: false,
    generatedAt: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") {
      const value = argv[++index];
      if (!value) throw new Error("--input requires a path");
      options.inputPath = value;
    } else if (arg === "--live") {
      options.live = true;
    } else if (arg === "--json") {
      options.format = "json";
    } else if (arg === "--markdown") {
      options.format = "markdown";
    } else if (arg === "--report") {
      const value = argv[++index];
      if (!value) throw new Error("--report requires a path");
      options.reportPath = value;
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg === "--generated-at") {
      const value = argv[++index];
      if (!value) throw new Error("--generated-at requires an ISO timestamp");
      options.generatedAt = value;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.inputPath && options.live) {
    throw new Error("Choose only one of --input or --live.");
  }

  return options;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function parseObservedRisk(value: unknown): { name: string; value: string; sentiment: string } | null {
  if (!isRecord(value)) return null;
  const name = stringValue(value.name);
  const riskValue = stringValue(value.value);
  const sentiment = stringValue(value.sentiment);
  if (!name || !riskValue || !sentiment) return null;
  return { name, value: riskValue, sentiment };
}

function parseObservedProject(value: unknown): ObservedProject | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const slug = stringValue(value.slug);
  const name = stringValue(value.name);
  const type = stringValue(value.type);
  const category = stringValue(value.category);
  const hostChain = stringValue(value.hostChain);
  const stage = stringValue(value.stage);
  if (!id || !slug || !name || !type || !category || !hostChain || !stage) return null;

  const risks: ObservedProject["risks"] = {};
  if (Array.isArray(value.risks)) {
    for (const rawRisk of value.risks) {
      const risk = parseObservedRisk(rawRisk);
      if (!risk) continue;
      const field = RISK_FIELD_BY_LABEL.get(risk.name);
      if (field) risks[field] = { value: risk.value, sentiment: risk.sentiment };
    }
  }

  return {
    id,
    slug,
    name,
    type,
    category,
    hostChain,
    stage,
    isUnderReview: booleanValue(value.isUnderReview) ?? false,
    risks,
  };
}

export function parseL2BeatSummaryProjects(payload: unknown): Map<string, ObservedProject> {
  const projects = isRecord(payload) && isRecord(payload.projects) ? payload.projects : null;
  if (!projects) throw new Error("L2BEAT summary payload must contain a projects object.");

  const observed = new Map<string, ObservedProject>();
  for (const value of Object.values(projects)) {
    const project = parseObservedProject(value);
    if (project) observed.set(project.id, project);
  }
  return observed;
}

function compareScalar(
  rows: SnapshotDriftRow[],
  projectId: string,
  field: string,
  current: string | boolean,
  observed: string | boolean,
  kind: DriftKind,
): void {
  if (current === observed) return;
  rows.push({
    projectId,
    field,
    current: String(current),
    observed: String(observed),
    kind,
  });
}

export function compareSnapshotToObserved(observed: ReadonlyMap<string, ObservedProject>): {
  driftRows: SnapshotDriftRow[];
  observedOnlyProjects: string[];
} {
  const driftRows: SnapshotDriftRow[] = [];

  for (const [projectId, snapshot] of Object.entries(L2BEAT_CHAIN_RISK_SNAPSHOT)) {
    const live = observed.get(projectId);
    if (!live) {
      driftRows.push({
        projectId,
        field: "project",
        current: "present in Pharos snapshot",
        observed: "missing from observed L2BEAT summary",
        kind: "missing-live-project",
      });
      continue;
    }

    compareScalar(driftRows, projectId, "slug", snapshot.slug, live.slug, "metadata-changed");
    compareScalar(driftRows, projectId, "name", snapshot.name, live.name, "metadata-changed");
    compareScalar(driftRows, projectId, "type", snapshot.type, live.type, "metadata-changed");
    compareScalar(driftRows, projectId, "category", snapshot.category, live.category, "metadata-changed");
    compareScalar(driftRows, projectId, "hostChain", snapshot.hostChain, live.hostChain, "metadata-changed");
    compareScalar(driftRows, projectId, "stage", snapshot.stage, live.stage, "stage-changed");
    compareScalar(driftRows, projectId, "isUnderReview", snapshot.isUnderReview, live.isUnderReview, "metadata-changed");

    for (const field of L2BEAT_CHAIN_RISK_FIELDS) {
      const observedRisk = live.risks[field];
      const currentRisk = (snapshot as L2BeatChainRiskSnapshot).risks[field];
      if (!observedRisk) {
        driftRows.push({
          projectId,
          field: L2BEAT_CHAIN_RISK_FIELD_LABELS[field],
          current: `${currentRisk.value} (${currentRisk.sentiment})`,
          observed: "missing from observed L2BEAT summary",
          kind: "risk-value-changed",
        });
        continue;
      }
      compareScalar(
        driftRows,
        projectId,
        `${L2BEAT_CHAIN_RISK_FIELD_LABELS[field]} value`,
        currentRisk.value,
        observedRisk.value,
        "risk-value-changed",
      );
      compareScalar(
        driftRows,
        projectId,
        `${L2BEAT_CHAIN_RISK_FIELD_LABELS[field]} sentiment`,
        currentRisk.sentiment,
        observedRisk.sentiment,
        "risk-sentiment-changed",
      );
    }
  }

  const snapshotProjectIds = new Set(Object.keys(L2BEAT_CHAIN_RISK_SNAPSHOT));
  const observedOnlyProjects = [...observed.keys()].filter((projectId) => !snapshotProjectIds.has(projectId)).sort();
  return { driftRows, observedOnlyProjects };
}

export function buildL2BeatSnapshotCoverageAudit(input: {
  observedProjects?: ReadonlyMap<string, ObservedProject>;
  observedSource?: L2BeatSnapshotCoverageAudit["observedSource"];
  generatedAt?: string;
} = {}): L2BeatSnapshotCoverageAudit {
  const coverage = buildL2BeatChainCoverageAudit({ generatedAt: input.generatedAt });
  const drift = input.observedProjects
    ? compareSnapshotToObserved(input.observedProjects)
    : { driftRows: [], observedOnlyProjects: [] };

  return {
    coverage,
    observedSource: input.observedSource ?? "none",
    driftRows: drift.driftRows,
    observedOnlyProjects: drift.observedOnlyProjects,
  };
}

function renderMatchedChains(audit: L2BeatChainCoverageAudit): string[] {
  if (audit.matchedChains.length === 0) return ["_None._"];
  return [
    "pharos chain | L2BEAT project | slug | stage | env score | host | weak risks",
    "--- | --- | --- | --- | ---: | --- | ---",
    ...audit.matchedChains.map((row) => [
      `${row.chainName} (${row.chainId})`,
      `${row.name} (${row.projectId})`,
      row.slug,
      row.stage,
      row.chainEnvironmentScore,
      row.hostChain,
      `bad ${row.riskSentiments.bad}, warning ${row.riskSentiments.warning}`,
    ].map(markdownValue).join(" | ")),
  ];
}

function renderAliasIssues(audit: L2BeatChainCoverageAudit): string[] {
  if (audit.aliasIssues.length === 0) return ["_None._"];
  return [
    "kind | chain | project | message",
    "--- | --- | --- | ---",
    ...audit.aliasIssues.map((issue) => [
      issue.kind,
      issue.chainId,
      issue.projectId,
      issue.message,
    ].map(markdownValue).join(" | ")),
  ];
}

function renderDriftRows(rows: readonly SnapshotDriftRow[]): string[] {
  if (rows.length === 0) return ["_None._"];
  return [
    "project | field | current | observed | kind",
    "--- | --- | --- | --- | ---",
    ...rows.map((row) => [
      row.projectId,
      row.field,
      row.current,
      row.observed,
      row.kind,
    ].map(markdownValue).join(" | ")),
  ];
}

export function renderL2BeatSnapshotCoverageAuditMarkdown(audit: L2BeatSnapshotCoverageAudit): string {
  const lines = [
    "# L2BEAT Snapshot Coverage Audit",
    "",
    `Generated: ${audit.coverage.generatedAt}`,
    `Observed source: ${audit.observedSource}`,
    "",
    "## Summary",
    "",
    `- Pharos chains: ${audit.coverage.summary.pharosChainCount}`,
    `- Matched chains: ${audit.coverage.summary.matchedChainCount}`,
    `- Unmatched chains: ${audit.coverage.summary.unmatchedChainCount}`,
    `- Explicit aliases: ${audit.coverage.summary.explicitAliasCount}`,
    `- Snapshot projects: ${audit.coverage.summary.snapshotProjectCount}`,
    `- Alias issues: ${audit.coverage.summary.aliasIssueCount}`,
    `- Consumed-field drift rows: ${audit.driftRows.length}`,
    `- Observed-only L2BEAT projects: ${audit.observedOnlyProjects.length}`,
    "",
    "## Matched Pharos Chains",
    "",
    ...renderMatchedChains(audit.coverage),
    "",
    "## Alias Integrity Issues",
    "",
    ...renderAliasIssues(audit.coverage),
    "",
    "## Consumed-Field Drift",
    "",
    ...renderDriftRows(audit.driftRows),
    "",
    "## Observed-Only L2BEAT Projects",
    "",
    audit.observedOnlyProjects.length > 0
      ? audit.observedOnlyProjects.map(markdownValue).join(", ")
      : "_None._",
    "",
  ];

  return `${lines.join("\n").trimEnd()}\n`;
}

function writeOutput(path: string, contents: string): void {
  writeOutputFile(path, contents);
}

async function loadObservedProjects(options: CliOptions): Promise<{
  projects?: Map<string, ObservedProject>;
  source: L2BeatSnapshotCoverageAudit["observedSource"];
}> {
  if (options.inputPath) {
    if (!existsSync(options.inputPath)) throw new Error(`--input file not found: ${options.inputPath}`);
    return { projects: parseL2BeatSummaryProjects(readJsonFile(options.inputPath)), source: "input" };
  }
  if (options.live) {
    const response = await fetch(L2BEAT_SUMMARY_URL, { headers: { Accept: "application/json" } });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Failed to fetch ${L2BEAT_SUMMARY_URL}: ${response.status} ${body.slice(0, 160)}`);
    }
    return { projects: parseL2BeatSummaryProjects(JSON.parse(body) as unknown), source: "live" };
  }
  return { source: "none" };
}

export async function runCli(
  argv = process.argv.slice(2),
  stdout: Pick<NodeJS.WriteStream, "write"> = process.stdout,
): Promise<number> {
  const options = parseArgs(argv);
  const observed = await loadObservedProjects(options);
  const generatedAt = resolveGeneratedAt({ generatedAt: options.generatedAt });
  const audit = buildL2BeatSnapshotCoverageAudit({
    observedProjects: observed.projects,
    observedSource: observed.source,
    generatedAt,
  });
  const output = options.format === "json"
    ? `${JSON.stringify(audit, null, 2)}\n`
    : renderL2BeatSnapshotCoverageAuditMarkdown(audit);

  if (options.reportPath) {
    writeOutput(options.reportPath, output);
  } else {
    stdout.write(output);
  }

  if (options.check) {
    const failures = [
      ...audit.coverage.aliasIssues.map((issue) => issue.message),
      ...audit.driftRows.map((row) => `${row.projectId} ${row.field} drifted: ${row.current} -> ${row.observed}`),
    ];
    if (failures.length > 0) {
      if (options.reportPath) stdout.write(`L2BEAT snapshot coverage check failed: ${failures.length} issue(s)\n`);
      return 1;
    }
    if (options.reportPath) stdout.write("L2BEAT snapshot coverage check passed\n");
  }

  return 0;
}

runAsMain(import.meta.url, runCli);
