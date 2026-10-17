#!/usr/bin/env tsx

import {
  buildMintAuthorityReviewAudit,
  renderMintAuthorityReviewAuditMarkdown,
} from "../lib/mint-authority-review-audit";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { collectMintAuthoritySources } from "@shared/lib/mint-authority-sources";
import type { StablecoinMeta } from "@shared/types";
import { runDirectCli } from "../lib/cli-args.mjs";
import { parseCoverageAuditCliArgs, runCoverageAuditCli, toPositiveInt } from "../lib/coverage-audit-cli";

type AuditFormat = "markdown" | "json";

interface Options {
  generatedAt: string;
  format: AuditFormat;
  reportPath: string | null;
  live: boolean;
  liveLimit: number;
}

function usage(): string {
  return [
    "Usage: tsx scripts/maintenance/generate-mint-authority-review-audit.ts [options]",
    "",
    "Options:",
    "  --json                    Output JSON instead of Markdown",
    "  --markdown                Output Markdown (default)",
    "  --report <path>            Write output to a file instead of stdout",
    "  --generated-at <iso>      Override generatedAt timestamp",
    "  --live                    Probe source URLs after static audit generation",
    "  --live-limit <n>          Maximum URLs to probe when --live is set (default 50)",
    "  --help, -h                Show this help text",
  ].join("\n");
}

export function parseArgs(argv: string[], now = new Date()): Options {
  return parseCoverageAuditCliArgs(argv, {
    createOptions: (): Options => ({
      generatedAt: now.toISOString(),
      format: "markdown",
      reportPath: null,
      live: false,
      liveLimit: 50,
    }),
    includeGeneratedAt: true,
    usage,
    options: [
      { flag: "--live", kind: "boolean", apply: (options) => { options.live = true; } },
      {
        flag: "--live-limit",
        kind: "value",
        missingMessage: "--live-limit must be a positive integer",
        apply: (options, value) => { options.liveLimit = toPositiveInt(value!, "--live-limit"); },
      },
    ],
  });
}

export function uniqueMintAuthoritySourceUrls(coins: readonly StablecoinMeta[] = TRACKED_STABLECOINS): string[] {
  const urls = new Set<string>();
  for (const coin of coins) {
    const profile = coin.mintAuthority;
    if (!profile) continue;
    for (const source of collectMintAuthoritySources(profile)) urls.add(source.url);
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
  let liveAppendix = "";
  return runCoverageAuditCli(argv, {
    parse: parseArgs,
    build: async (options) => {
      const audit = buildMintAuthorityReviewAudit({
        coins: TRACKED_STABLECOINS,
        generatedAt: options.generatedAt,
      });
      if (options.live && options.format === "markdown") {
        liveAppendix = await buildLiveAppendix(options.liveLimit);
      }
      return audit;
    },
    renderMarkdown: (audit) => `${renderMintAuthorityReviewAuditMarkdown(audit)}\n${liveAppendix}`,
    stdout,
    writeMessage: (target) => `Wrote Mint Authority review audit to ${target}`,
  });
}

runDirectCli(import.meta.url, async () => {
  process.exitCode = await runCli();
});
