#!/usr/bin/env node

/**
 * One entrypoint for the curation coverage-backlog audits.
 *
 * These seven analyses drive real curation queues, but each used to carry its
 * own `check:*` npm alias even though none of them ran in CI. They are manual
 * audits, so they share one manual command:
 *
 *   npm run audit:coverage -- --domain=<domain> [audit args...]
 *   npm run audit:coverage -- --all
 *
 * Every argument after the domain selector is forwarded verbatim to the
 * underlying audit (for example `--enforce`, `--check`, `--json`,
 * `--report <path>`), so no analysis behaviour is lost.
 */

import {
  createExecutionUnit,
  createSpawnCommand,
  runExecutionUnit,
  runSpawnCommand,
  type CommandImplementation,
  type ExecutionResult,
  type SpawnCommand,
} from "../lib/command-runner.mts";
import { localBin } from "../lib/local-bin.mts";

export const DOMAIN_SCRIPTS = {
  "redemption-backstops": "scripts/ci/check-redemption-backstops.ts",
  "redemption-coverage": "scripts/maintenance/generate-redemption-coverage-audit.ts",
  "dependency-coverage": "scripts/maintenance/generate-dependency-coverage-audit.ts",
  "reserve-coverage": "scripts/maintenance/generate-reserve-coverage-audit.ts",
  "oracle-risk": "scripts/ci/check-oracle-risk-coverage.ts",
  "mechanism-archetype": "scripts/ci/check-mechanism-archetype-coverage.ts",
  "l2beat-snapshot": "scripts/maintenance/generate-l2beat-snapshot-coverage-audit.ts",
} as const;

type Domain = keyof typeof DOMAIN_SCRIPTS;
export interface ParsedCoverageAuditArgs {
  help: boolean;
  domains: Domain[];
  forwarded: string[];
}

const DOMAINS = Object.keys(DOMAIN_SCRIPTS) as Domain[];

function isDomain(value: string): value is Domain {
  return value in DOMAIN_SCRIPTS;
}

function usage(): string {
  return [
    "Usage: npm run audit:coverage -- --domain=<domain> [audit args...]",
    "       npm run audit:coverage -- --all",
    "",
    "Domains:",
    ...DOMAINS.map((domain) => `  ${domain.padEnd(21)} ${DOMAIN_SCRIPTS[domain]}`),
    "",
    "Arguments after the domain selector are forwarded to the audit script.",
  ].join("\n");
}

export function parseCoverageAuditArgs(argv: readonly string[]): ParsedCoverageAuditArgs {
  const domains: string[] = [];
  let all = false;
  const forwarded = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--all") {
      all = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { help: true, domains: [], forwarded: [] };
    }
    if (arg === "--domain") {
      const value = argv[index + 1];
      if (!value) throw new Error("--domain requires a domain name");
      domains.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--domain=")) {
      domains.push(arg.slice("--domain=".length));
      continue;
    }
    forwarded.push(arg);
  }

  if (all && domains.length > 0) {
    throw new Error("Choose either --all or --domain, not both.");
  }
  if (all && forwarded.length > 0) {
    throw new Error("--all runs every audit with its default arguments; drop the extra arguments.");
  }
  if (!all && domains.length === 0) {
    throw new Error(`Pass --domain=<${DOMAINS.join("|")}> or --all.`);
  }

  const selected = all ? [...DOMAINS] : domains;
  const unknown = selected.filter((domain) => !isDomain(domain));
  if (unknown.length > 0) {
    throw new Error(`Unknown coverage audit domain(s): ${unknown.join(", ")}. Known: ${DOMAINS.join(", ")}`);
  }

  return { help: false, domains: selected.filter(isDomain), forwarded };
}

export interface RunCoverageAuditOptions {
  runCommandImpl?: CommandImplementation<SpawnCommand>;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

async function runDomain(
  domain: Domain,
  forwarded: readonly string[],
  { runCommandImpl = runSpawnCommand, log = console.log, error = console.error }: RunCoverageAuditOptions = {},
): Promise<number> {
  const script = DOMAIN_SCRIPTS[domain];
  log(`\n[audit:coverage] ${domain} -> tsx ${script}${forwarded.length > 0 ? ` ${forwarded.join(" ")}` : ""}`);
  const command = createSpawnCommand(localBin("tsx"), [script, ...forwarded]);
  let result: ExecutionResult;
  try {
    result = await runExecutionUnit(createExecutionUnit([command]), {
      label: "audit:coverage",
      reporter: {},
      runCommandImpl,
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    error(`[audit:coverage] ${domain} failed to start: ${message}`);
    return 1;
  }
  return result.status;
}

export async function runCoverageAudit(
  argv: readonly string[] = process.argv.slice(2),
  options: RunCoverageAuditOptions = {},
): Promise<number> {
  let parsed: ParsedCoverageAuditArgs;
  try {
    parsed = parseCoverageAuditArgs(argv);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    (options.error ?? console.error)(message);
    (options.error ?? console.error)(`\n${usage()}`);
    return 1;
  }

  if (parsed.help) {
    (options.log ?? console.log)(usage());
    return 0;
  }

  let status = 0;
  for (const domain of parsed.domains) {
    const domainStatus = await runDomain(domain, parsed.forwarded, options);
    if (domainStatus !== 0) {
      (options.error ?? console.error)(`[audit:coverage] ${domain} exited with status ${domainStatus}`);
      status = domainStatus;
    }
  }
  return status;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runCoverageAudit().then((status) => {
    process.exitCode = status;
  });
}
