#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  hasDeployImpact,
  hasPagesDeployImpact,
  hasWorkerDeployImpact,
  normalizeRepoPath,
} from "./lib/deploy-impact.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_BASE_DOCS = [
  "docs/agent-task-router.md",
  "docs/architecture.md",
  "docs/testing.md",
];

const CORE_RULES = [
  "Prefer the smallest root-cause fix; avoid unrelated refactors.",
  "Update matching docs for behavior, API, pipeline, methodology, or data-source changes.",
  "Do not add manual/on-chain/CMC/DEX supply overrides; primary supply remains DefiLlama with the existing fallback path.",
  "Keep Tailwind classes as static strings.",
  "Do not edit shadcn primitives in src/components/ui/ unless explicitly required.",
];

const PATH_FAMILIES = [
  {
    id: "stablecoin-registry",
    label: "Stablecoin metadata or registry",
    risk: "high",
    docsToRead: [
      "docs/stablecoin-data.md",
      "docs/classification.md",
      "docs/shadow-stablecoins.md",
      "shared/data/stablecoins/AGENTS.md",
    ],
    docsLikelyRequired: [
      "docs/about-page.md",
      "docs/classification.md",
      "feature methodology docs when behavior changes",
    ],
    checks: [
      "npm run check:stablecoin-data",
      "vitest run shared/lib/stablecoins shared/lib/__tests__/stablecoin-id-registry.test.ts",
    ],
    hardRules: [
      "Keep canonical order, generated data, and schemas aligned.",
      "Do not add manual supply overrides.",
    ],
    prefixes: [
      "shared/data/stablecoins/",
      "shared/lib/stablecoins/",
    ],
    exactPaths: [
      "shared/lib/stablecoin-id-registry.ts",
      "shared/lib/classification.ts",
    ],
  },
  {
    id: "pricing-pipeline",
    label: "Pricing pipeline or source roster",
    risk: "high",
    docsToRead: [
      "docs/pricing-pipeline.md",
      "docs/data-pipeline.md",
      "docs/pricing-pipeline-timeline.md",
    ],
    docsLikelyRequired: [
      "docs/pricing-pipeline.md",
      "docs/pricing-pipeline-timeline.md",
      "docs/data-pipeline.md",
      "docs/about-page.md when adding a data source",
    ],
    checks: [
      "npm run audit:pricing-providers",
      "focused pricing/depeg tests",
    ],
    hardRules: [
      "Consume or cancel failed fetch bodies before opening more Worker fetches.",
      "Do not multiply DefiLlama list-endpoint supply by price.",
    ],
    prefixes: [
      "worker/src/cron/sync-stablecoins/",
      "worker/src/lib/price",
      "worker/src/lib/address-price-providers/",
    ],
    exactPaths: [
      "shared/lib/pricing-provider-config.ts",
      "worker/src/lib/authoritative-price-sources.ts",
      "worker/src/lib/price-consensus.ts",
      "worker/src/lib/price-validation.ts",
    ],
  },
  {
    id: "api-endpoint",
    label: "Public or admin API endpoint",
    risk: "medium",
    docsToRead: [
      "docs/api-endpoint-authoring.md",
      "docs/api-reference.md",
      "docs/worker-infrastructure.md",
    ],
    docsLikelyRequired: [
      "docs/api-reference.md",
      "route/page contract doc",
      "docs/data-flow-map.md when pipeline-facing",
    ],
    checks: [
      "npm run test:critical-contracts when endpoint is critical",
      "focused handler/router tests",
    ],
    hardRules: [
      "Route flags, auth lane behavior, cache metadata, and site-data allowlists are centralized.",
    ],
    prefixes: [
      "shared/lib/api-endpoints/",
      "worker/src/routes/",
      "worker/src/api/",
    ],
    exactPaths: [
      "worker/src/router.ts",
      "src/hooks/api-hooks.ts",
    ],
  },
  {
    id: "worker-cron",
    label: "Worker cron or scheduled pipeline",
    risk: "high",
    docsToRead: [
      "docs/worker-infrastructure.md",
      "docs/worker-and-api-limits.md",
      "docs/data-flow-map.md",
    ],
    docsLikelyRequired: [
      "docs/worker-infrastructure.md",
      "docs/worker-and-api-limits.md",
      "feature methodology docs when behavior changes",
    ],
    checks: [
      "npm run check:cron-sync",
      "npm run check:cron-connections",
      "focused cron tests",
    ],
    hardRules: [
      "Pick the trigger slot before adding fetch-heavy work.",
      "Cron jobs share Cloudflare's per-trigger 6-connection pool.",
    ],
    prefixes: [
      "worker/src/handlers/scheduled/",
      "worker/src/cron/",
    ],
    exactPaths: [
      "shared/lib/cron-jobs.ts",
      "shared/lib/scheduled-runner-registry.ts",
      "scripts/check-cron-schedule-sync.ts",
      "scripts/check-cron-connection-budget.ts",
    ],
  },
  {
    id: "d1-migration",
    label: "D1 schema or migration",
    risk: "high",
    docsToRead: [
      "docs/deployment-process.md",
      "docs/worker-infrastructure.md",
      "worker/migrations/MANIFEST.md",
    ],
    docsLikelyRequired: [
      "docs/worker-infrastructure.md",
      "docs/api-reference.md when response shape changes",
    ],
    checks: [
      "npm run check:migrations",
      "focused API/cron tests for affected stores",
    ],
    hardRules: [
      "Migrations must be backward-compatible because CI applies D1 migrations before the new Worker is live.",
      "Destructive cleanup requires a separate coordinated rollout.",
    ],
    prefixes: [
      "worker/migrations/",
    ],
    regexes: [
      /^worker\/src\/lib\/db/i,
    ],
  },
  {
    id: "frontend-route",
    label: "Frontend page or route behavior",
    risk: "medium",
    docsToRead: [
      "route-specific doc from docs/README.md",
      "docs/architecture.md",
      "src/AGENTS.md",
    ],
    docsLikelyRequired: [
      "route contract doc",
      "docs/architecture.md",
      "docs/design-language.md when UI patterns change",
    ],
    checks: [
      "npm run build",
      "npm run seo:check for Pages-impacting route work",
      "relevant component/page tests",
    ],
    hardRules: [
      "Static export means route metadata, sitemap, and crawlability can matter even for simple UI changes.",
    ],
    prefixes: [
      "src/app/",
      "src/components/",
      "src/hooks/",
      "src/lib/",
    ],
    exactPaths: [
      "src/app/globals.css",
    ],
  },
  {
    id: "design-ui",
    label: "Design or UI polish",
    risk: "medium",
    docsToRead: [
      "docs/design-context.md",
      "docs/design-language.md",
      "docs/design-tokens.md",
    ],
    docsLikelyRequired: [
      "design docs when deployed token/class/component patterns change",
    ],
    checks: [
      "relevant component/page tests",
      "browser smoke or screenshot check when layout risk is meaningful",
    ],
    hardRules: [
      "Preserve the existing Pharos design language.",
      "Do not edit src/components/ui/ shadcn primitives unless explicitly required.",
    ],
    prefixes: [
      "src/styles/",
      "src/components/ui/",
    ],
    exactPaths: [
      "docs/design-context.md",
      "docs/design-language.md",
      "docs/design-tokens.md",
      "src/app/globals.css",
    ],
  },
  {
    id: "methodology-scoring",
    label: "Methodology or scoring change",
    risk: "high",
    docsToRead: [
      "docs/methodology-page.md",
      "specific methodology doc",
      "matching timeline doc",
    ],
    docsLikelyRequired: [
      "runtime methodology doc",
      "timeline doc",
      "src/app/methodology/sections/* when methodology UI changes",
    ],
    checks: [
      "focused scoring tests",
      "npm run check:doc-sync",
    ],
    hardRules: [
      "Methodology versions increase numerically: after v5.9 use v5.91 or v6.0, not v5.10.",
    ],
    prefixes: [
      "src/app/methodology/",
      "src/components/methodology/",
    ],
    regexes: [
      /^docs\/.*methodology/i,
      /^docs\/.*timeline\.md$/i,
      /^shared\/lib\/.*(score|scoring|dews|report-card|stability-index|liquidity|resilience|peg)/i,
      /^worker\/src\/.*(dews|report-card|stability-index|liquidity|mint-burn|yield|blacklist|reserve)/i,
    ],
  },
  {
    id: "pages-functions-host",
    label: "Pages Functions or host split",
    risk: "medium",
    docsToRead: [
      "docs/architecture.md",
      "docs/worker-infrastructure.md",
      "docs/operator-origin-access.md",
      "functions/AGENTS.md",
    ],
    docsLikelyRequired: [
      "docs/architecture.md",
      "docs/worker-infrastructure.md",
      "docs/deployment-process.md",
    ],
    checks: [
      "Pages Functions tests",
      "npm run test:smoke-transport when host routing changes",
    ],
    hardRules: [
      "Browser reads should use same-origin /_site-data/* unless explicitly exempt.",
    ],
    prefixes: [
      "functions/",
    ],
    exactPaths: [
      "shared/lib/site-data-lane.ts",
      "shared/lib/runtime-origins.ts",
      "src/lib/api.ts",
    ],
  },
  {
    id: "validation-ci-policy",
    label: "Validation, CI, or repo policy",
    risk: "medium",
    docsToRead: [
      "docs/testing.md",
      "docs/deployment-process.md",
      "docs/scripts.md",
    ],
    docsLikelyRequired: [
      "docs/testing.md",
      "docs/deployment-process.md",
      "docs/scripts.md",
    ],
    checks: [
      "changed script's focused test",
      "MERGE_GATE_DRY_RUN=1 npm run test:merge-gate when deploy classification changes",
    ],
    hardRules: [
      "Keep deploy-surface classification and local merge-gate behavior aligned.",
    ],
    prefixes: [
      ".github/",
      ".githooks/",
      "scripts/",
    ],
    exactPaths: [
      "package.json",
      "package-lock.json",
      ".gitignore",
    ],
  },
  {
    id: "agent-hooks-process",
    label: "Agent guidance or Codex hook process",
    risk: "medium",
    docsToRead: [
      "AGENTS.md",
      "CLAUDE.md",
      "docs/process/agent-artifacts.md",
      "docs/agent-task-router.md",
    ],
    docsLikelyRequired: [
      "docs/process/agent-artifacts.md for durable process rules",
      "AGENTS.md and CLAUDE.md together when top-level guidance changes",
    ],
    checks: [
      "npm run check:agent-doc-sync when AGENTS.md or CLAUDE.md changes",
      "focused hook/script tests",
    ],
    hardRules: [
      "Top-level AGENTS.md and CLAUDE.md are deliberately kept in sync.",
      "Temporary agent output belongs in ignored scratch locations, not committed docs.",
    ],
    prefixes: [
      ".codex/",
      "docs/process/",
    ],
    exactPaths: [
      "AGENTS.md",
      "CLAUDE.md",
      "docs/agent-task-router.md",
      "scripts/pharos-change-contract.mjs",
    ],
  },
  {
    id: "documentation",
    label: "Documentation-only change",
    risk: "low",
    docsToRead: [
      "docs/README.md",
      "docs/doc-ownership.json",
    ],
    docsLikelyRequired: [
      "nearest owning doc only",
    ],
    checks: [
      "npm run check:verified-doc-links",
      "npm run check:doc-source-paths",
      "npm run check:doc-sync when methodology or generated doc metadata is affected",
    ],
    hardRules: [
      "Treat docs/ and README.md as the verified documentation corpus.",
    ],
    prefixes: [
      "docs/",
    ],
    exactPaths: [
      "README.md",
    ],
  },
];

const RISK_RANK = new Map([
  ["high", 3],
  ["medium", 2],
  ["low", 1],
]);

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function fileMatchesRule(file, rule) {
  if (rule.exactPaths?.includes(file)) return true;
  if (rule.prefixes?.some((prefix) => file.startsWith(prefix))) return true;
  if (rule.regexes?.some((regex) => regex.test(file))) return true;
  return false;
}

function compareFamilyRisk(a, b) {
  const rankDelta = (RISK_RANK.get(b.risk) ?? 0) - (RISK_RANK.get(a.risk) ?? 0);
  if (rankDelta !== 0) return rankDelta;
  return a.label.localeCompare(b.label);
}

export function normalizeChangedFiles(files) {
  return unique(files.map((file) => normalizeRepoPath(file.trim())).filter(Boolean)).sort();
}

export function classifyChangedFiles(files) {
  const changedFiles = normalizeChangedFiles(files);
  const matchedFamilies = PATH_FAMILIES
    .map((family) => ({
      ...family,
      matchedFiles: changedFiles.filter((file) => fileMatchesRule(file, family)),
    }))
    .filter((family) => family.matchedFiles.length > 0)
    .sort(compareFamilyRisk);

  const docsToRead = unique([
    ...DEFAULT_BASE_DOCS,
    ...matchedFamilies.flatMap((family) => family.docsToRead),
  ]);
  const docsLikelyRequired = unique(matchedFamilies.flatMap((family) => family.docsLikelyRequired));
  const checks = unique(matchedFamilies.flatMap((family) => family.checks));
  const hardRules = unique([
    ...CORE_RULES,
    ...matchedFamilies.flatMap((family) => family.hardRules),
  ]);
  const warnings = buildWarnings(changedFiles);

  return {
    changedFiles,
    checks,
    deploy: {
      deployImpact: hasDeployImpact(changedFiles),
      pagesImpact: hasPagesDeployImpact(changedFiles),
      workerImpact: hasWorkerDeployImpact(changedFiles),
    },
    docsLikelyRequired,
    docsToRead,
    families: matchedFamilies.map((family) => ({
      id: family.id,
      label: family.label,
      matchedFiles: family.matchedFiles,
      risk: family.risk,
    })),
    hardRules,
    warnings,
  };
}

function buildWarnings(changedFiles) {
  const warnings = [];
  if (changedFiles.some((file) => file.startsWith("src/components/ui/"))) {
    warnings.push("src/components/ui contains shadcn primitives; edit only when explicitly required.");
  }
  if (changedFiles.some((file) => file.startsWith("worker/migrations/"))) {
    warnings.push("D1 migrations are applied before the new Worker is live; keep them backward-compatible.");
  }
  if (changedFiles.some((file) => file === "AGENTS.md" || file === "CLAUDE.md")) {
    warnings.push("AGENTS.md and CLAUDE.md must stay synchronized.");
  }
  if (changedFiles.some((file) => file.startsWith("shared/data/stablecoins/"))) {
    warnings.push("Stablecoin data changes must not introduce manual supply overrides.");
  }
  return warnings;
}

function getRepoChangedFiles({ baseRef, execFile = execFileSync, headRef, staged = false } = {}) {
  if (baseRef || headRef) {
    const base = baseRef || "origin/main";
    const head = headRef || "HEAD";
    const raw = execFile("git", ["diff", "--name-only", `${base}...${head}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    return raw.split(/\r?\n/g);
  }

  if (staged) {
    const raw = execFile("git", ["diff", "--name-only", "--cached"], { cwd: REPO_ROOT, encoding: "utf8" });
    return raw.split(/\r?\n/g);
  }

  const trackedRaw = execFile("git", ["diff", "--name-only", "HEAD", "--"], { cwd: REPO_ROOT, encoding: "utf8" });
  const untrackedRaw = execFile("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return [
    ...trackedRaw.split(/\r?\n/g),
    ...untrackedRaw.split(/\r?\n/g),
  ];
}

export function readChangedFiles(options = {}) {
  try {
    return normalizeChangedFiles(getRepoChangedFiles(options));
  } catch {
    return [];
  }
}

function formatBullets(values, { limit = 8 } = {}) {
  const shown = values.slice(0, limit);
  const lines = shown.map((value) => `- ${value}`);
  if (values.length > shown.length) {
    lines.push(`- ...and ${values.length - shown.length} more`);
  }
  return lines.join("\n");
}

function formatFamilies(families) {
  if (families.length === 0) return "- No specific task family matched yet.";
  return families
    .map((family) => `- ${family.label} (${family.risk}): ${family.matchedFiles.slice(0, 3).join(", ")}`)
    .join("\n");
}

export function formatContract(contract, { mode = "full" } = {}) {
  const changedSummary = contract.changedFiles.length > 0
    ? formatBullets(contract.changedFiles, { limit: mode === "stop" ? 6 : 12 })
    : "- No current changed files detected.";
  const sections = [
    "Pharos change contract:",
    "",
    "Matched task families:",
    formatFamilies(contract.families),
    "",
    "Changed files:",
    changedSummary,
    "",
    "Read first:",
    formatBullets(contract.docsToRead, { limit: mode === "stop" ? 8 : 12 }),
  ];

  if (contract.docsLikelyRequired.length > 0) {
    sections.push(
      "",
      "Docs likely required if behavior changed:",
      formatBullets(contract.docsLikelyRequired, { limit: mode === "stop" ? 6 : 10 }),
    );
  }

  if (contract.checks.length > 0) {
    sections.push(
      "",
      "Checks to consider before finalizing:",
      formatBullets(contract.checks, { limit: mode === "stop" ? 8 : 12 }),
    );
  }

  if (contract.warnings.length > 0) {
    sections.push(
      "",
      "Warnings:",
      formatBullets(contract.warnings, { limit: 6 }),
    );
  }

  sections.push(
    "",
    "Core rules:",
    formatBullets(contract.hardRules, { limit: mode === "stop" ? 6 : 10 }),
  );

  if (contract.deploy.deployImpact) {
    sections.push(
      "",
      `Deploy impact: pages=${contract.deploy.pagesImpact ? "yes" : "no"}, worker=${contract.deploy.workerImpact ? "yes" : "no"}.`,
    );
  }

  return sections.join("\n");
}

function formatInlineList(values, { limit = 6 } = {}) {
  if (values.length === 0) return "None";
  const shown = values.slice(0, limit).map((value) => `\`${value}\``);
  if (values.length > shown.length) {
    shown.push(`and ${values.length - shown.length} more`);
  }
  return shown.join(", ");
}

export function formatContractMarkdown(contract) {
  const familyRows = contract.families.length > 0
    ? contract.families
      .map((family) => `| ${family.label} | ${family.risk} | ${formatInlineList(family.matchedFiles, { limit: 4 })} |`)
      .join("\n")
    : "| No specific task family matched | low | No matched files |";
  const deploySummary = contract.deploy.deployImpact
    ? `Pages: **${contract.deploy.pagesImpact ? "yes" : "no"}**, Worker: **${contract.deploy.workerImpact ? "yes" : "no"}**`
    : "No deploy-impacting surface detected by the shared deploy classifier.";

  return [
    "<!-- pharos-change-contract -->",
    "### Pharos Change Contract",
    "",
    deploySummary,
    "",
    "| Task family | Risk | Matched files |",
    "| --- | --- | --- |",
    familyRows,
    "",
    "<details>",
    "<summary>Docs, checks, and guardrails</summary>",
    "",
    "#### Read First",
    formatBullets(contract.docsToRead, { limit: 12 }),
    "",
    "#### Docs Likely Required If Behavior Changed",
    contract.docsLikelyRequired.length > 0 ? formatBullets(contract.docsLikelyRequired, { limit: 12 }) : "- None",
    "",
    "#### Checks To Consider",
    contract.checks.length > 0 ? formatBullets(contract.checks, { limit: 12 }) : "- None",
    "",
    "#### Warnings",
    contract.warnings.length > 0 ? formatBullets(contract.warnings, { limit: 8 }) : "- None",
    "",
    "#### Core Rules",
    formatBullets(contract.hardRules, { limit: 12 }),
    "",
    "</details>",
    "",
    "_Generated by `scripts/pharos-change-contract.mjs`._",
  ].join("\n");
}

export function buildSessionStartContext(contract) {
  if (contract.changedFiles.length === 0) {
    return [
      "Pharos agent context:",
      "- No current changed files were detected.",
      "- Before editing, classify the task using docs/agent-task-router.md and read only the relevant docs.",
      "- Re-run `node scripts/pharos-change-contract.mjs` after meaningful file changes to refresh docs/check obligations.",
      "",
      "Always preserve these Pharos rules:",
      formatBullets(CORE_RULES, { limit: CORE_RULES.length }),
    ].join("\n");
  }
  return `${formatContract(contract)}\n\nUse this as a routing aid; still inspect the touched implementation before editing.`;
}

export function buildStopContinuationReason(contract) {
  return [
    "Before finalizing this Pharos turn, address the current change contract.",
    "Run the relevant checks/docs updates, or explicitly state why they were not needed or could not be run.",
    "",
    formatContract(contract, { mode: "stop" }),
  ].join("\n");
}

function hasStopObligations(contract) {
  return contract.changedFiles.length > 0 && (
    contract.families.length > 0
    || contract.checks.length > 0
    || contract.docsLikelyRequired.length > 0
    || contract.warnings.length > 0
  );
}

function readHookInput() {
  try {
    const raw = readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function buildSessionStartHookOutput(contract) {
  return {
    hookSpecificOutput: {
      additionalContext: buildSessionStartContext(contract),
      hookEventName: "SessionStart",
    },
  };
}

export function buildStopHookOutput(contract, hookInput = {}) {
  if (hookInput.stop_hook_active || !hasStopObligations(contract)) {
    return { continue: true };
  }

  return {
    decision: "block",
    reason: buildStopContinuationReason(contract),
  };
}

function parseArgs(argv) {
  const options = {
    baseRef: process.env.PHAROS_CHANGE_CONTRACT_BASE_REF,
    format: "text",
    headRef: process.env.PHAROS_CHANGE_CONTRACT_HEAD_REF,
    hook: null,
    staged: false,
  };
  const explicitFiles = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.format = "json";
    } else if (arg === "--markdown") {
      options.format = "markdown";
    } else if (arg === "--staged") {
      options.staged = true;
    } else if (arg === "--hook") {
      options.hook = argv[++i] ?? null;
    } else if (arg.startsWith("--hook=")) {
      options.hook = arg.slice("--hook=".length);
    } else if (arg === "--base-ref") {
      options.baseRef = argv[++i];
    } else if (arg.startsWith("--base-ref=")) {
      options.baseRef = arg.slice("--base-ref=".length);
    } else if (arg === "--head-ref") {
      options.headRef = argv[++i];
    } else if (arg.startsWith("--head-ref=")) {
      options.headRef = arg.slice("--head-ref=".length);
    } else if (arg === "--file") {
      explicitFiles.push(argv[++i] ?? "");
    } else if (arg.startsWith("--file=")) {
      explicitFiles.push(arg.slice("--file=".length));
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    }
  }

  return { explicitFiles, options };
}

function printHelp() {
  console.log(`Usage: node scripts/pharos-change-contract.mjs [options]

Classify the current Pharos diff into docs, checks, and agent guardrails.

Options:
  --json                  Emit the contract as JSON instead of text
  --markdown              Emit a GitHub-flavored Markdown PR comment body
  --staged                Classify staged files only
  --base-ref <ref>        Classify git diff base...head
  --head-ref <ref>        Classify git diff base...head
  --file <path>           Classify an explicit file path; repeatable
  --hook=session-start    Emit Codex SessionStart hook JSON
  --hook=stop             Emit Codex Stop hook JSON
`);
}

export function runCli(argv = process.argv.slice(2)) {
  const { explicitFiles, options } = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }

  const hookInput = options.hook ? readHookInput() : {};
  const changedFiles = explicitFiles.length > 0
    ? explicitFiles
    : readChangedFiles({
      baseRef: options.baseRef,
      headRef: options.headRef,
      staged: options.staged,
    });
  const contract = classifyChangedFiles(changedFiles);

  if (options.hook === "session-start") {
    console.log(JSON.stringify(buildSessionStartHookOutput(contract)));
    return;
  }

  if (options.hook === "stop") {
    console.log(JSON.stringify(buildStopHookOutput(contract, hookInput)));
    return;
  }

  if (options.format === "json") {
    console.log(JSON.stringify(contract, null, 2));
    return;
  }

  if (options.format === "markdown") {
    console.log(formatContractMarkdown(contract));
    return;
  }

  console.log(formatContract(contract));
}

const isCliEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliEntrypoint) {
  runCli();
}
