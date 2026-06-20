#!/usr/bin/env tsx

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildL2BeatBridgeRouteReviewAudit,
  type L2BeatBridgeRouteReviewAudit,
  type L2BeatBridgeRouteReviewRow,
} from "../../shared/lib/chains/l2beat-audit";
import { ACTIVE_META_BY_ID, ACTIVE_STABLECOINS } from "../../shared/lib/stablecoins/registry";
import {
  markdownValue,
  resolveGeneratedAt,
  resolveSelectedStablecoins,
  runAsMain,
  toPositiveInt,
  writeAdvisoryReport,
} from "../lib/coverage-audit-cli";

const DEFAULT_OUTPUT_PATH = "agents/l2beat-bridge-route-candidates.md";
const DEFAULT_LIMIT = 75;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STABLECOIN_DATA_ROOT = resolve(REPO_ROOT, "shared/data/stablecoins");

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

export async function runCli(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  stdout: Pick<NodeJS.WriteStream, "write"> = process.stdout,
): Promise<number> {
  const options = parseArgs(argv);
  const stablecoins = resolveSelectedStablecoins(options.coinIds, ACTIVE_META_BY_ID, ACTIVE_STABLECOINS);
  const generatedAt = resolveGeneratedAt({ generatedAt: options.generatedAt });
  const audit = limitAuditRows(buildL2BeatBridgeRouteReviewAudit({ stablecoins, generatedAt }), options);
  const output = options.format === "json"
    ? `${JSON.stringify(audit, null, 2)}\n`
    : renderL2BeatBridgeRouteReviewAuditMarkdown(audit);

  if (options.stdout || !options.reportPath) {
    stdout.write(output);
    return 0;
  }

  const target = writeAdvisoryReport(cwd, options.reportPath, output, {
    protectedRoot: STABLECOIN_DATA_ROOT,
    message: "L2BEAT bridge-route reports are advisory; write them under agents/ or another scratch path.",
  });
  if (!existsSync(target)) {
    throw new Error(`Failed to write L2BEAT bridge-route candidate report: ${target}`);
  }
  stdout.write(`wrote ${audit.reviewRows.length} L2BEAT bridge-route candidate row(s) to ${target}\n`);
  return 0;
}

runAsMain(import.meta.url, runCli);
