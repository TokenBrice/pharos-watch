#!/usr/bin/env tsx

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildL2BeatBridgeRouteReviewAudit,
  type L2BeatBridgeRouteReviewAudit,
  type L2BeatBridgeRouteReviewRow,
} from "../../shared/lib/chains/l2beat-audit";
import { ACTIVE_META_BY_ID, ACTIVE_STABLECOINS } from "../../shared/lib/stablecoins/registry";
import type { StablecoinMeta } from "../../shared/types";
import { markdownValue, resolveGeneratedAt } from "../lib/coverage-audit-cli";

const DEFAULT_OUTPUT_PATH = "agents/l2beat-bridge-route-candidates.md";
const DEFAULT_LIMIT = 75;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

interface CliOptions {
  coinIds: string[];
  limit: number;
  all: boolean;
  format: "markdown" | "json";
  reportPath: string | null;
  stdout: boolean;
  generatedAt: string | null;
}

function usage(): string {
  return [
    "Usage: tsx scripts/maintenance/build-l2beat-bridge-route-candidates.ts [options]",
    "",
    "Options:",
    "  --coin <id>           Include one active stablecoin. Repeat for multiple coins.",
    `  --limit <n>           Limit rendered candidate rows unless --all is set (default ${DEFAULT_LIMIT})`,
    "  --all                 Include all candidate rows",
    "  --json                Emit JSON instead of Markdown",
    "  --markdown            Emit Markdown (default)",
    `  --report <path>       Write report path (default ${DEFAULT_OUTPUT_PATH}; ignored with --stdout)`,
    "  --stdout              Write to stdout instead of a report file",
    "  --generated-at <iso>  Override generated timestamp; use 'now' for current time",
    "  --help, -h            Show this help text",
  ].join("\n");
}

function toPositiveInt(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    coinIds: [],
    limit: DEFAULT_LIMIT,
    all: false,
    format: "markdown",
    reportPath: DEFAULT_OUTPUT_PATH,
    stdout: false,
    generatedAt: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--coin") {
      const value = argv[++index];
      if (!value) throw new Error("--coin requires a stablecoin ID");
      options.coinIds.push(value);
    } else if (arg === "--limit") {
      options.limit = toPositiveInt(argv[++index] ?? "", "--limit");
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--json") {
      options.format = "json";
    } else if (arg === "--markdown") {
      options.format = "markdown";
    } else if (arg === "--report") {
      const value = argv[++index];
      if (!value) throw new Error("--report requires a path");
      options.reportPath = value;
    } else if (arg === "--stdout") {
      options.stdout = true;
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

  if (options.all && options.limit !== DEFAULT_LIMIT) {
    throw new Error("Choose either --all or --limit, not both.");
  }

  return options;
}

function resolveSelectedStablecoins(options: CliOptions): StablecoinMeta[] {
  if (options.coinIds.length > 0) {
    return options.coinIds.map((id) => {
      const coin = ACTIVE_META_BY_ID.get(id);
      if (!coin) throw new Error(`Unknown active stablecoin ID: ${id}`);
      return coin;
    });
  }
  return ACTIVE_STABLECOINS;
}

function limitAuditRows(audit: L2BeatBridgeRouteReviewAudit, options: CliOptions): L2BeatBridgeRouteReviewAudit {
  return {
    ...audit,
    reviewRows: options.all ? audit.reviewRows : audit.reviewRows.slice(0, options.limit),
  };
}

function renderProtocolList(row: L2BeatBridgeRouteReviewRow): string {
  if (row.protocols.length === 0) return "none";
  return row.protocols
    .map((protocol) => `${protocol.name} (${protocol.type}; ${protocol.bridgeTypes.join(", ")})`)
    .join("; ");
}

function renderReviewRows(rows: readonly L2BeatBridgeRouteReviewRow[]): string[] {
  if (rows.length === 0) return ["_None._"];
  return [
    "coin | deploymentModel | current tier | suggested tier | L2BEAT protocols | reasons | notes",
    "--- | --- | --- | --- | --- | --- | ---",
    ...rows.map((row) => [
      `${row.symbol} (${row.coinId})`,
      row.deploymentModel,
      row.currentBridgeRouteTier,
      row.suggestedBridgeRouteTier,
      renderProtocolList(row),
      row.reasons.join(", "),
      row.notes.join("; "),
    ].map(markdownValue).join(" | ")),
  ];
}

export function renderL2BeatBridgeRouteReviewAuditMarkdown(audit: L2BeatBridgeRouteReviewAudit): string {
  const lines = [
    "# L2BEAT Bridge Route Candidates",
    "",
    `Generated: ${audit.generatedAt}`,
    "",
    "## Summary",
    "",
    `- Active stablecoins reviewed: ${audit.summary.stablecoinCount}`,
    `- L2BEAT Interop protocols snapshotted: ${audit.summary.l2beatInteropProtocolCount}`,
    `- Protocol references found: ${audit.summary.protocolReferenceCount}`,
    `- Stablecoins with protocol references: ${audit.summary.stablecoinsWithProtocolReferences}`,
    `- Stablecoins with reviewed bridgeRouteRisk: ${audit.summary.stablecoinsWithBridgeRouteRisk}`,
    `- Candidate rows: ${audit.summary.reviewRowCount}`,
    "",
    "## Review Queue",
    "",
    ...renderReviewRows(audit.reviewRows),
    "",
    "## Operator Notes",
    "",
    "- Reviewed `bridgeRouteRisk` can affect Safety Score v8.12 through a penalty-only Decentralization blend.",
    "- This report is a review queue only. It never mutates stablecoin metadata.",
    "- Strong native or canonical routes never lift a score; missing bridgeRouteRisk remains neutral until reviewed.",
    "",
  ];

  return `${lines.join("\n").trimEnd()}\n`;
}

function assertSafeReportPath(cwd: string, reportPath: string): string {
  const target = resolve(cwd, reportPath);
  const stablecoinDataRoot = resolve(REPO_ROOT, "shared/data/stablecoins");
  const pathFromStablecoinDataRoot = relative(stablecoinDataRoot, target);
  const isStablecoinDataPath =
    pathFromStablecoinDataRoot === "" ||
    (!!pathFromStablecoinDataRoot &&
      !pathFromStablecoinDataRoot.startsWith("..") &&
      !isAbsolute(pathFromStablecoinDataRoot));

  if (isStablecoinDataPath) {
    throw new Error("L2BEAT bridge-route reports are advisory; write them under agents/ or another scratch path.");
  }
  return target;
}

function writeReport(cwd: string, reportPath: string, contents: string): string {
  const target = assertSafeReportPath(cwd, reportPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
  return target;
}

export async function runCli(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  stdout: Pick<NodeJS.WriteStream, "write"> = process.stdout,
): Promise<number> {
  const options = parseArgs(argv);
  const stablecoins = resolveSelectedStablecoins(options);
  const generatedAt = resolveGeneratedAt({ generatedAt: options.generatedAt });
  const audit = limitAuditRows(buildL2BeatBridgeRouteReviewAudit({ stablecoins, generatedAt }), options);
  const output = options.format === "json"
    ? `${JSON.stringify(audit, null, 2)}\n`
    : renderL2BeatBridgeRouteReviewAuditMarkdown(audit);

  if (options.stdout || !options.reportPath) {
    stdout.write(output);
    return 0;
  }

  const target = writeReport(cwd, options.reportPath, output);
  if (!existsSync(target)) {
    throw new Error(`Failed to write L2BEAT bridge-route candidate report: ${target}`);
  }
  stdout.write(`wrote ${audit.reviewRows.length} L2BEAT bridge-route candidate row(s) to ${target}\n`);
  return 0;
}

if (process.argv[1]?.endsWith("build-l2beat-bridge-route-candidates.ts")) {
  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
