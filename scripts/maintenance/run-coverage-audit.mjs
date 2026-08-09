#!/usr/bin/env node

/**
 * One entrypoint for the curation coverage-backlog audits.
 *
 * These five analyses drive real curation queues, but each used to carry its
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

import { spawnSync } from "node:child_process";
import { localBin } from "../lib/local-bin.mjs";

const DOMAIN_SCRIPTS = Object.freeze({
  "redemption-backstops": "scripts/ci/check-redemption-backstops.ts",
  "redemption-coverage": "scripts/maintenance/generate-redemption-coverage-audit.ts",
  "oracle-risk": "scripts/ci/check-oracle-risk-coverage.ts",
  "mechanism-archetype": "scripts/ci/check-mechanism-archetype-coverage.ts",
  "l2beat-snapshot": "scripts/maintenance/generate-l2beat-snapshot-coverage-audit.ts",
});

const DOMAINS = Object.keys(DOMAIN_SCRIPTS);

function usage() {
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

function parseArgs(argv) {
  const domains = [];
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
  const unknown = selected.filter((domain) => !(domain in DOMAIN_SCRIPTS));
  if (unknown.length > 0) {
    throw new Error(`Unknown coverage audit domain(s): ${unknown.join(", ")}. Known: ${DOMAINS.join(", ")}`);
  }

  return { help: false, domains: selected, forwarded };
}

function runDomain(domain, forwarded) {
  const script = DOMAIN_SCRIPTS[domain];
  console.log(`\n[audit:coverage] ${domain} -> tsx ${script}${forwarded.length > 0 ? ` ${forwarded.join(" ")}` : ""}`);
  const result = spawnSync(localBin("tsx"), [script, ...forwarded], { stdio: "inherit" });
  if (result.error) {
    console.error(`[audit:coverage] ${domain} failed to start: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`\n${usage()}`);
  process.exit(1);
}

if (options.help) {
  console.log(usage());
  process.exit(0);
}

let status = 0;
for (const domain of options.domains) {
  const domainStatus = runDomain(domain, options.forwarded);
  if (domainStatus !== 0) {
    console.error(`[audit:coverage] ${domain} exited with status ${domainStatus}`);
    status = domainStatus;
  }
}
process.exit(status);
