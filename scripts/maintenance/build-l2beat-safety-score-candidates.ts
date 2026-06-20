#!/usr/bin/env tsx

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildL2BeatStablecoinSafetyAudit,
  type L2BeatStablecoinReviewRow,
  type L2BeatStablecoinSafetyAudit,
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

const DEFAULT_OUTPUT_PATH = "agents/l2beat-safety-score-candidates.md";
const DEFAULT_LIMIT = 50;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STABLECOIN_DATA_ROOT = resolve(REPO_ROOT, "shared/data/stablecoins");

interface CliOptions {
  coinIds: string[];
  chainIds: string[];
  limit: number;
  all: boolean;
  format: "markdown" | "json";
  reportPath: string | null;
  stdout: boolean;
  generatedAt: string | null;
}

function usage(): string {
  return [
    "Usage: tsx scripts/maintenance/build-l2beat-safety-score-candidates.ts [options]",
    "",
    "Options:",
    "  --coin <id>           Include one active stablecoin. Repeat for multiple coins.",
    "  --chain <id>          Keep candidate rows for one Pharos chain. Repeat for multiple chains.",
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
    chainIds: [],
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
    } else if (arg === "--chain") {
      const value = argv[++index];
      if (!value) throw new Error("--chain requires a Pharos chain ID");
      options.chainIds.push(value);
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

function filterAuditRows(audit: L2BeatStablecoinSafetyAudit, options: CliOptions): L2BeatStablecoinSafetyAudit {
  const allowedChains = new Set(options.chainIds);
  const filteredRows = audit.reviewRows.filter((row) => (
    allowedChains.size === 0 || allowedChains.has(row.chainId)
  ));
  const limitedRows = options.all ? filteredRows : filteredRows.slice(0, options.limit);

  return {
    ...audit,
    summary: {
      ...audit.summary,
      reviewRowCount: filteredRows.length,
    },
    reviewRows: limitedRows,
  };
}

function renderReviewRows(rows: readonly L2BeatStablecoinReviewRow[]): string[] {
  if (rows.length === 0) return ["_None._"];
  return [
    "coin | chain | current chainTier | current deploymentModel | L2BEAT project | stage | env score | reasons | notes",
    "--- | --- | --- | --- | --- | --- | ---: | --- | ---",
    ...rows.map((row) => [
      `${row.symbol} (${row.coinId})`,
      row.chainId,
      row.chainTier,
      row.deploymentModel,
      `${row.l2beatName} (${row.projectId})`,
      row.stage,
      row.chainEnvironmentScore,
      row.reasons.join(", "),
      row.notes.join("; "),
    ].map(markdownValue).join(" | ")),
  ];
}

export function renderL2BeatStablecoinSafetyAuditMarkdown(audit: L2BeatStablecoinSafetyAudit): string {
  const lines = [
    "# L2BEAT Safety Score Candidates",
    "",
    `Generated: ${audit.generatedAt}`,
    "",
    "## Summary",
    "",
    `- Active stablecoins reviewed: ${audit.summary.stablecoinCount}`,
    `- Stablecoins with contract metadata: ${audit.summary.stablecoinsWithContracts}`,
    `- Stablecoins with L2BEAT-matched deployments: ${audit.summary.stablecoinsWithL2BeatDeployments}`,
    `- L2BEAT-matched deployments: ${audit.summary.matchedDeploymentCount}`,
    `- Candidate rows: ${audit.summary.reviewRowCount}`,
    "",
    "## Review Queue",
    "",
    ...renderReviewRows(audit.reviewRows),
    "",
    "## Operator Notes",
    "",
    "- This report is advisory. It does not mutate Safety Score inputs.",
    "- `chainTier` can use L2BEAT stage as audit evidence; `deploymentModel` remains a token-route review.",
    "- Layer 3 or non-Ethereum-hosted rows need extra host-chain dependency review before changing metadata.",
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
  const audit = filterAuditRows(
    buildL2BeatStablecoinSafetyAudit({ stablecoins, generatedAt }),
    options,
  );
  const output = options.format === "json"
    ? `${JSON.stringify(audit, null, 2)}\n`
    : renderL2BeatStablecoinSafetyAuditMarkdown(audit);

  if (options.stdout || !options.reportPath) {
    stdout.write(output);
    return 0;
  }

  const target = writeAdvisoryReport(cwd, options.reportPath, output, {
    protectedRoot: STABLECOIN_DATA_ROOT,
    message: "L2BEAT candidate reports are advisory; write them under agents/ or another scratch path.",
  });
  if (!existsSync(target)) {
    throw new Error(`Failed to write L2BEAT candidate report: ${target}`);
  }
  stdout.write(`wrote ${audit.reviewRows.length} L2BEAT Safety Score candidate row(s) to ${target}\n`);
  return 0;
}

runAsMain(import.meta.url, runCli);
