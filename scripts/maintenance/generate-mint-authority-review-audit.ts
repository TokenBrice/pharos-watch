#!/usr/bin/env tsx

import {
  buildMintAuthorityReviewAudit,
  renderMintAuthorityReviewAuditMarkdown,
} from "../lib/mint-authority-review-audit";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { runAsMain, toPositiveInt, writeOutputFile } from "../lib/coverage-audit-cli";

type AuditFormat = "markdown" | "json";

interface Options {
  generatedAt: string;
  format: AuditFormat;
  outputPath: string | null;
  live: boolean;
  liveLimit: number;
}

function usage(): string {
  return [
    "Usage: tsx scripts/maintenance/generate-mint-authority-review-audit.ts [options]",
    "",
    "Options:",
    "  --format <markdown|json>  Output format (default markdown)",
    "  --out <path>              Write output to a file instead of stdout",
    "  --generated-at <iso>      Override generatedAt timestamp",
    "  --live                    Probe source URLs after static audit generation",
    "  --live-limit <n>          Maximum URLs to probe when --live is set (default 50)",
    "  --help, -h                Show this help text",
  ].join("\n");
}

export function parseArgs(argv: string[], now = new Date()): Options {
  const options: Options = {
    generatedAt: now.toISOString(),
    format: "markdown",
    outputPath: null,
    live: false,
    liveLimit: 50,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--format") {
      const format = argv[++index] as AuditFormat | undefined;
      if (format !== "markdown" && format !== "json") {
        throw new Error("--format must be markdown or json");
      }
      options.format = format;
    } else if (arg === "--out") {
      const outputPath = argv[++index];
      if (!outputPath) throw new Error("--out requires a path");
      options.outputPath = outputPath;
    } else if (arg === "--generated-at") {
      const generatedAt = argv[++index];
      if (!generatedAt) throw new Error("--generated-at requires an ISO timestamp");
      options.generatedAt = generatedAt;
    } else if (arg === "--live") {
      options.live = true;
    } else if (arg === "--live-limit") {
      options.liveLimit = toPositiveInt(argv[++index] ?? "", "--live-limit");
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function uniqueMintAuthoritySourceUrls(): string[] {
  const urls = new Set<string>();
  for (const coin of TRACKED_STABLECOINS) {
    const profile = coin.mintAuthority;
    if (!profile) continue;
    for (const source of profile.review.sources ?? []) urls.add(source.url);
    for (const incident of profile.mintIncidents ?? []) {
      for (const source of incident.sources) urls.add(source.url);
    }
    for (const control of profile.controls ?? []) {
      for (const source of control.sources ?? []) urls.add(source.url);
      for (const source of control.keyCustodyAttestation?.sources ?? []) urls.add(source.url);
    }
  }
  return [...urls].sort();
}

async function probeUrl(url: string): Promise<{ url: string; ok: boolean; status: number | null; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    let response = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
    if (response.status === 405 || response.status === 403) {
      response = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal });
    }
    return { url, ok: response.ok, status: response.status };
  } catch (error) {
    return { url, ok: false, status: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function buildLiveAppendix(limit: number): Promise<string> {
  const urls = uniqueMintAuthoritySourceUrls().slice(0, limit);
  const checks = await Promise.all(urls.map(probeUrl));
  const failed = checks.filter((check) => !check.ok);
  return [
    "",
    "## Live Source Probe",
    "",
    `Checked ${checks.length} source URL(s). Live probes are advisory and non-blocking.`,
    "",
    failed.length === 0
      ? "- No failed probes in the checked sample."
      : failed
          .map((check) => `- ${check.status ?? "ERR"} ${check.url}${check.error ? ` (${check.error})` : ""}`)
          .join("\n"),
    "",
  ].join("\n");
}

export async function runCli(
  argv = process.argv.slice(2),
  stdout: Pick<NodeJS.WriteStream, "write"> = process.stdout,
): Promise<number> {
  const options = parseArgs(argv);
  const audit = buildMintAuthorityReviewAudit({
    coins: TRACKED_STABLECOINS,
    generatedAt: options.generatedAt,
  });
  let output =
    options.format === "json"
      ? `${JSON.stringify(audit, null, 2)}\n`
      : `${renderMintAuthorityReviewAuditMarkdown(audit)}\n`;

  if (options.live && options.format === "markdown") {
    output += await buildLiveAppendix(options.liveLimit);
  }

  if (options.outputPath) {
    const target = writeOutputFile(options.outputPath, output);
    stdout.write(`Wrote Mint Authority review audit to ${target}\n`);
    return 0;
  }

  stdout.write(output);
  return 0;
}

runAsMain(import.meta.url, runCli);
