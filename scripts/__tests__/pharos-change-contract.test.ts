import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildPermissionRequestHookOutput,
  buildPreToolUseHookOutput,
  buildRouteContext,
  classifyChangedFiles,
  classifyRouteContext,
  findShellCommandViolation,
  formatContract,
  ROUTE_CONTEXT_CEILINGS,
} from "../ci/pharos-change-contract.ts";
import type { ChangeContract, RouteContextDocumentCache } from "../ci/pharos-change-contract.ts";
import { analyzeShellCommand } from "../lib/shell-command-analysis.ts";
import type * as RoutingRegistry from "../lib/doc-ownership-registry.mts";
import { buildFocusedCheckPlan } from "../maintenance/run-focused-checks.ts";
// Match the router's lazy module boundary when extending the routing fixture.
const { PATH_FAMILIES, DECLARED_TEST_OWNERSHIP } = createRequire(import.meta.url)("../lib/doc-ownership-registry.mts") as typeof RoutingRegistry;

function requireBlockingReason(output: unknown): string {
  if (typeof output !== "object" || output === null || !("reason" in output) || typeof output.reason !== "string") {
    throw new Error("Expected a blocking hook output with a reason");
  }

  return output.reason;
}

type HookMode = "pre-tool-use" | "permission-request" | "session-start";

function runHookCliProcess(
  hook: HookMode,
  input = "",
  env: NodeJS.ProcessEnv = process.env,
  extraArgs: readonly string[] = [],
) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", resolve(process.cwd(), "scripts/ci/pharos-change-contract.ts"), `--hook=${hook}`, ...extraArgs],
    { cwd: process.cwd(), encoding: "utf8", env, input, timeout: 15_000 },
  );
  return {
    ...result,
    stderr: String(result.stderr ?? ""),
    stdout: String(result.stdout ?? ""),
  };
}

function docKeys(contract: { docs: Array<{ anchor?: string; path: string }> }): string[] {
  return contract.docs.map((doc) => doc.anchor ? `${doc.path}#${doc.anchor}` : doc.path);
}

function expectIntegrityObligations(contract: Pick<ChangeContract, "docs">, methodology: boolean) {
  const keys = Array.from({ length: 8 }, (_, index) => `docs/architecture.md#adr-${index + 28}`);
  if (methodology) keys.push("docs/architecture.md#adr-3");
  expect(docKeys(contract)).toEqual(expect.arrayContaining(keys));
}

// Exact measured byte ceilings, not rounded class allowances. Lower these when
// reading shrinks; never regenerate them automatically or trade away obligations.
// Manually ratcheted after moving implementation inventories/details into linked appendices.
const ROUTE_FIXTURES = [
  ["src/components/stablecoin-table.tsx", 20_684, 20_684],
  ["src/app/yield/page.tsx", 49_506, 49_506],
  ["worker/src/cron/dex-liquidity/orchestrator.ts", 42_303, 42_303],
  ["worker/src/api/yield-history.ts", 71_063, 71_063],
  ["shared/lib/safety-score-v9/evaluate-asset.ts", 59_880, 59_880],
  ["shared/lib/classification.ts", 46_444, 46_444],
  ["functions/safety-scores/map.json.ts", 24_468, 29_549],
  ["shared/data/stablecoins/coins/usdt-tether.json", 46_444, 46_444],
  ["worker/src/telegram/webhook/telegram-webhook.ts", 46_593, 46_593],
  ["worker/migrations/0268_telegram_planning_lookup_indexes.sql", 26_618, 26_618],
] as const;

interface ReadingSignature {
  file: string;
  mode: "auto" | "contract";
  contract: ChangeContract;
  signature: Array<{ id: string; selectors: number[] }>;
}

function enumerateReadingSignatures() {
  const { createOwnershipGlobMatcher } = createRequire(import.meta.url)("../lib/doc-ownership-registry.mts") as typeof RoutingRegistry;
  const matchers = PATH_FAMILIES.map((family) => ({
    family,
    sources: family.sourceGlobs.map(createOwnershipGlobMatcher),
    selectors: (family.reading ?? []).map((selector) => selector.sources.map(createOwnershipGlobMatcher)),
  }));
  const trackedFiles = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const representatives = new Map<string, ReadingSignature>();
  for (const file of trackedFiles) {
    const matched = matchers.filter(({ sources }) => sources.some((match) => match(file)));
    if (matched.length === 0) continue;
    const signature = matched.map(({ family, selectors }) => ({
      id: family.id,
      selectors: selectors.flatMap((sources, index) => sources.some((match) => match(file)) ? [index] : []),
    }));
    for (const mode of ["auto", "contract"] as const) {
      const contract = classifyChangedFiles([file], mode);
      const key = JSON.stringify([mode, signature, contract.scopedContext, contract.contextMode.effective, classifyRouteContext(contract)]);
      if (!representatives.has(key)) representatives.set(key, { file, mode, contract, signature });
    }
  }
  return [...representatives.values()];
}

// Classification stays cheap; only one representative of each complete
// family/selector/scoped-guide/mode/class signature opens Markdown documents.
let readingSignatures: ReadingSignature[] | undefined;

function withSqlFixture<T>(sql: string, callback: (path: string) => T): T {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "pharos-change-contract-sql-"));
  const sqlPath = join(fixtureRoot, "query.sql");
  writeFileSync(sqlPath, sql);
  try {
    return callback(sqlPath);
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

describe("route context accounting", () => {
  function withContextFixture(callback: (repoRoot: string) => void) {
    const repoRoot = mkdtempSync(join(tmpdir(), "pharos-route-context-"));
    writeFileSync(join(repoRoot, "AGENTS.md"), "# Root\né😀\n");
    writeFileSync(join(repoRoot, "CLAUDE.md"), "@AGENTS.md\n");
    writeFileSync(join(repoRoot, "scope.md"), "# Scope\n");
    writeFileSync(join(repoRoot, "guide.md"), "# Guide\n\n## One\né😀\n### Child\nnested\n## Two\nlast\n");
    try {
      callback(repoRoot);
    } finally {
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }

  it("counts UTF-8 bytes, physical lines and character-based tokens over the range union", () => {
    withContextFixture((repoRoot) => {
      const context = buildRouteContext({
        docs: [
          { path: "guide.md", anchor: "one" },
          { path: "guide.md", anchor: "child" },
          { path: "guide.md", anchor: "two" },
          { path: "./guide.md", anchor: "one" },
        ],
        scopedContext: ["scope.md"],
        // Conditional references must not be opened or charged.
        background: [{ path: "not-preloaded.md", anchor: "conditional" }],
      }, { repoRoot });
      expect(context.total).toEqual({ bytes: 65, characters: 59, lines: 9, approximateTokens: 15 });
      expect(context.files.find((file) => file.path === "guide.md")).toEqual({
        path: "guide.md", bytes: 43, characters: 40, lines: 6, approximateTokens: 10,
        ranges: [{ startLine: 3, endLine: 8, bytes: 43, characters: 40, lines: 6, approximateTokens: 10 }],
      });
      expect(context.references.find((ref) => ref.anchor === "one")).toEqual({
        path: "guide.md", anchor: "one", kind: "primary", requiredReason: "Selected primary ownership reference",
        startLine: 3, endLine: 6, bytes: 31, characters: 28, lines: 4, approximateTokens: 7,
      });
      expect(context.references.filter((ref) => ref.anchor === "one")).toHaveLength(1);
      expect(context.background).toEqual([{ path: "not-preloaded.md", anchor: "conditional" }]);
    });
  });

  it("counts the authored root once through scoped, primary, canonical-path and Claude aliases", () => {
    withContextFixture((repoRoot) => {
      symlinkSync(join(repoRoot, "AGENTS.md"), join(repoRoot, "root-link.md"));
      const context = buildRouteContext({
        docs: [{ path: "AGENTS.md" }, { path: "./AGENTS.md" }, { path: "CLAUDE.md" }, { path: "root-link.md" }],
        scopedContext: ["AGENTS.md"],
        background: [],
      }, { repoRoot });
      expect(context.total).toEqual({ bytes: 14, characters: 11, lines: 2, approximateTokens: 3 });
      expect(context.references).toEqual([{
        path: "AGENTS.md", kind: "root", requiredReason: "Root repository instructions",
        startLine: 1, endLine: 2, bytes: 14, characters: 11, lines: 2, approximateTokens: 3,
      }]);
      expect(context.files).toHaveLength(1);
    });
  });

  it("lets whole-file reads subsume sections and merges adjacent selected ranges", () => {
    withContextFixture((repoRoot) => {
      const contract = {
        docs: [{ path: "guide.md", anchor: "child" }, { path: "guide.md", anchor: "two" }],
        scopedContext: [], background: [],
      };
      const adjacent = buildRouteContext(contract, { repoRoot });
      expect(adjacent.files.find((file) => file.path === "guide.md")?.ranges).toHaveLength(1);
      // Child and Two are adjacent. One omitted preceding section is not charged.
      expect(adjacent.total).toEqual({ bytes: 43, characters: 40, lines: 6, approximateTokens: 10 });
      const whole = buildRouteContext({ ...contract, docs: [...contract.docs, { path: "guide.md" }] }, { repoRoot });
      expect(whole.total).toEqual({ bytes: 66, characters: 60, lines: 10, approximateTokens: 15 });
      expect(whole.files.find((file) => file.path === "guide.md")?.ranges).toEqual([
        { startLine: 1, endLine: 8, bytes: 52, characters: 49, lines: 8, approximateTokens: 13 },
      ]);
    });
  });

  it("does not charge gaps and counts the final physical line without a trailing newline", () => {
    withContextFixture((repoRoot) => {
      writeFileSync(join(repoRoot, "guide.md"), "# Guide\n## One\none\n## Gap\nskip\n## Two\ntwo");
      const context = buildRouteContext({
        docs: [{ path: "guide.md", anchor: "one" }, { path: "guide.md", anchor: "two" }],
        scopedContext: [], background: [],
      }, { repoRoot });
      expect(context.total).toEqual({ bytes: 35, characters: 32, lines: 6, approximateTokens: 8 });
      expect(context.files.find((file) => file.path === "guide.md")?.ranges).toEqual([
        { startLine: 2, endLine: 3, bytes: 11, characters: 11, lines: 2, approximateTokens: 3 },
        { startLine: 6, endLine: 7, bytes: 10, characters: 10, lines: 2, approximateTokens: 3 },
      ]);
    });
  });

  it("shares parsed document snapshots without sharing selected ranges between routes", () => {
    withContextFixture((repoRoot) => {
      const documents: RouteContextDocumentCache = new Map();
      const first = { docs: [{ path: "guide.md", anchor: "one" }], scopedContext: [], background: [] };
      const second = { docs: [{ path: "guide.md", anchor: "two" }], scopedContext: [], background: [] };
      const firstContext = buildRouteContext(first, { repoRoot, documents });
      const parsed = documents.get(join(repoRoot, "guide.md"))?.document;
      expect(parsed).toBeDefined();
      const secondContext = buildRouteContext(second, { repoRoot, documents });
      expect(documents.get(join(repoRoot, "guide.md"))?.document).toBe(parsed);
      expect(documents.size).toBe(2);
      expect(firstContext).toEqual(buildRouteContext(first, { repoRoot }));
      expect(secondContext).toEqual(buildRouteContext(second, { repoRoot }));
      expect(secondContext.references.some((reference) => reference.anchor === "one")).toBe(false);
    });
  });

  it("fails on missing required files and anchors without changing classification", () => {
    withContextFixture((repoRoot) => {
      expect(() => buildRouteContext({
        docs: [{ path: "missing.md" }], scopedContext: [], background: [],
      }, { repoRoot })).toThrow("Cannot account for missing.md");
      expect(() => buildRouteContext({
        docs: [{ path: "guide.md", anchor: "missing" }], scopedContext: [], background: [],
      }, { repoRoot })).toThrow("Cannot account for guide.md#missing: Missing Markdown anchor: #missing");
      expect(() => buildRouteContext({
        docs: [], scopedContext: ["missing/AGENTS.md"], background: [],
      }, { repoRoot })).toThrow("Cannot account for missing/AGENTS.md");
    });
  });

  it("prints the same measured payload in text and keeps accounting outside check selection", () => {
    const contract = classifyChangedFiles(["shared/lib/safety-score-v9/evaluate-asset.ts"]);
    const original = JSON.stringify(contract);
    const context = buildRouteContext(contract);
    expect(JSON.stringify(contract)).toBe(original);
    const text = formatContract(contract, { context });
    expect(text).toContain(`Total initial routed context: ${context.total.bytes} B, ${context.total.lines} lines, ~${context.total.approximateTokens} tokens (merged per file).`);
    for (const reference of context.references) {
      expect(text).toContain(`${reference.bytes} B, ${reference.lines} lines, ~${reference.approximateTokens} tokens`);
    }
    expect(text).toContain("Background references are not counted.");
    expect(text).toContain("Required ownership reference (not subject to the reading cap)");
  });
});

describe("reading selectors and context modes", () => {
  it.each([
    ["shared/lib/classification.ts", false],
    ["shared/data/stablecoins/coins/usdt-tether.json", false],
    ["shared/lib/safety-score-v9/evaluate-asset.ts", true],
    ["worker/src/cron/dex-liquidity/orchestrator.ts", true],
    ["worker/src/api/yield-history.ts", true],
    ["worker/src/telegram/webhook/telegram-webhook.ts", false],
    ["worker/migrations/0268_telegram_planning_lookup_indexes.sql", false],
    ["functions/safety-scores/map.json.ts", true],
  ] as const)("keeps integrity ADRs primary and undemoted for %s", (file, methodology) => {
    const contract = classifyChangedFiles([file]);
    expectIntegrityObligations(contract, methodology);
    const keys = Array.from({ length: 8 }, (_, index) => `docs/architecture.md#adr-${index + 28}`);
    if (methodology) keys.push("docs/architecture.md#adr-3");
    expect(docKeys({ docs: contract.background }).filter((key) => keys.includes(key))).toEqual([]);
  });

  function withReadingFamily(callback: () => void) {
    const originalLength = PATH_FAMILIES.length;
    PATH_FAMILIES.push({
      id: "reading-fixture", label: "Reading fixture", risk: "high", tier: "specific",
      sourceGlobs: ["reading-fixture/**"], checks: ["fixture-check"], hardRules: [], scopedContext: [], background: [],
      docs: [{ path: "default.md" }],
      required: [{ path: "required.md" }],
      reading: [{ sources: ["reading-fixture/selected.ts"],
        local: [{ path: "local.md" }], contract: [{ path: "contract.md" }],
        required: [{ path: "selector-required.md" }] }],
    });
    try {
      callback();
    } finally {
      PATH_FAMILIES.splice(originalLength);
    }
  }

  it("falls back per input file in a mixed batch and contract augments local", () => {
    withReadingFamily(() => {
      const files = ["reading-fixture/selected.ts", "reading-fixture/unselected.ts"];
      const local = classifyChangedFiles(files);
      expect(docKeys(local)).toEqual(["local.md", "default.md", "required.md", "selector-required.md"]);
      expect(docKeys(classifyChangedFiles(files, "contract")))
        .toEqual(["local.md", "contract.md", "default.md", "required.md", "selector-required.md"]);
      expect(docKeys(classifyChangedFiles(["reading-fixture/selected.ts"])))
        .toEqual(["local.md", "required.md", "selector-required.md"]);
      expect(docKeys(classifyChangedFiles(["reading-fixture/unselected.ts"]))).toEqual(["default.md", "required.md"]);
    });
  });

  it("never demotes required refs, even when authored after six ordinary refs or repeated as background", () => {
    withReadingFamily(() => {
      const family = PATH_FAMILIES[PATH_FAMILIES.length - 1];
      family.docs = Array.from({ length: 7 }, (_, index) => ({ path: `ordinary-${index + 1}.md` }));
      family.background = [{ path: "required.md" }];
      const contract = classifyChangedFiles(["reading-fixture/unselected.ts"]);
      expect(docKeys(contract)).toEqual([
        "ordinary-1.md", "ordinary-2.md", "ordinary-3.md", "ordinary-4.md", "ordinary-5.md", "ordinary-6.md", "required.md",
      ]);
      expect(contract.background).toEqual([{ path: "ordinary-7.md" }]);
    });
  });

  it("orders selector-owned reading separately without changing mappings or check order", () => {
    withReadingFamily(() => {
      PATH_FAMILIES.push({
        id: "generic-reading-fixture", label: "A generic fixture", risk: "high", tier: "specific",
        sourceGlobs: ["reading-fixture/**"], checks: ["generic-check"], docs: [{ path: "generic.md" }],
        hardRules: [], scopedContext: [], background: [],
      });
      const local = classifyChangedFiles(["reading-fixture/selected.ts"]);
      const contract = classifyChangedFiles(["reading-fixture/selected.ts"], "contract");
      expect(local.mappings.map((mapping) => mapping.id)).toEqual(["generic-reading-fixture", "reading-fixture"]);
      expect(docKeys(local).slice(0, 2)).toEqual(["local.md", "generic.md"]);
      expect(contract.checks).toEqual(local.checks);
      expect(contract.checks).toEqual(["generic-check", "fixture-check"]);
    });
  });

  it("uses contract reading for implementation inputs on two surfaces but not tests or doc companions", () => {
    const implementation = "src/components/stablecoin-table.tsx";
    expect(classifyChangedFiles([implementation]).contextMode.effective).toBe("local");
    const contract = classifyChangedFiles([implementation, "worker/src/lib/db.ts"]);
    expect(contract.contextMode.effective).toBe("contract");
    expect(contract.contextMode.reasons).toContain("Implementation inputs span surfaces: src, worker");
    expect(classifyChangedFiles([implementation, "worker/src/lib/__tests__/db.test.ts"]).contextMode.effective).toBe("local");
    expect(classifyChangedFiles([implementation, "shared/AGENTS.md"]).contextMode.effective).toBe("local");
  });

  it.each([
    "shared/types/api.ts", "shared/lib/api-endpoints/catalog.ts", "shared/lib/example-contract.ts",
    "shared/lib/classification.ts", "shared/lib/methodology-versions/constants.ts",
    "shared/data/methodology-changelogs/example.json", "shared/data/stablecoins/coins/usdt-tether.json",
    "shared/lib/safety-score-v9/evaluate-asset.ts", "shared/data/safety-score-v9/inputs.json",
    "worker/migrations/0268_telegram_planning_lookup_indexes.sql", "shared/contracts/api-meta.ts",
  ])("upgrades contract-sensitive input %s using ownership glob semantics", (file) => {
    const contract = classifyChangedFiles([file]);
    expect(contract.contextMode.effective).toBe("contract");
    expect(contract.contextMode.reasons.some((reason) => reason.startsWith("Contract-sensitive input:"))).toBe(true);
  });

  it.each(["local", "invalid", "AUTO", ""])("rejects invalid --context=%s", (context) => {
    const result = spawnSync(process.execPath,
      ["--import", "tsx", "scripts/ci/pharos-change-contract.ts", `--context=${context}`, "--file", "src/components/stablecoin-table.tsx", "--json"],
      { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(context === "" ? "--context requires a non-empty value" : "Invalid --context");
    expect(result.stdout).toBe("");
  });

  it.each(["auto", "contract"] as const)("fails unmapped CLI routing without a runnable plan in %s mode", (context) => {
    const result = spawnSync(process.execPath,
      ["--import", "tsx", "scripts/ci/pharos-change-contract.ts", `--context=${context}`, "--new-file",
        "--file", "unmapped.fixture", "--file", "src/components/stablecoin-table.tsx", "--json"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.unmappedPaths).toEqual(["unmapped.fixture"]);
    expect(output.checks).toEqual([]);
    expect(output.warnings).toEqual(expect.arrayContaining([expect.stringContaining("Missing documentation owner")]));
  });

  it.each([
    "src/components/stablecoin-table.tsx", "src/app/yield/page.tsx",
    "worker/src/cron/dex-liquidity/orchestrator.ts", "worker/src/api/yield-history.ts",
    "shared/lib/safety-score-v9/evaluate-asset.ts", "shared/lib/classification.ts",
    "functions/safety-scores/map.json.ts", "shared/data/stablecoins/coins/usdt-tether.json",
    "worker/src/telegram/webhook/telegram-webhook.ts", "worker/migrations/0268_telegram_planning_lookup_indexes.sql",
    "scripts/maintenance/worker-evidence-report.mjs",
  ])("keeps the emitted check plan byte-identical across modes for %s", (file) => {
    const outputs = (["auto", "contract"] as const).map((context) => {
      const result = spawnSync(process.execPath,
        ["--import", "tsx", "scripts/ci/pharos-change-contract.ts", `--context=${context}`, "--file", file, "--json"],
        { encoding: "utf8" });
      expect(result.status).toBe(0);
      return JSON.parse(result.stdout);
    });
    expect(JSON.stringify(outputs[0].checks)).toBe(JSON.stringify(outputs[1].checks));
    expect(outputs[0].checks).toEqual(buildFocusedCheckPlan([file]).checks.map((check) => check.command));
    expect(outputs[0].mappings).toEqual(outputs[1].mappings);
    expect(outputs[0].contextMode.requested).toBe("auto");
    expect(outputs[1].contextMode).toEqual({ requested: "contract", effective: "contract", reasons: ["Explicit contract context"] });
  });

  it.each(["auto", "contract"] as const)("keeps evaluator %s reading at the scoring seam, not consumer implementations", (mode) => {
    const contract = classifyChangedFiles(["shared/lib/safety-score-v9/evaluate-asset.ts"], mode);
    expect(contract.contextMode.effective).toBe("contract");
    expect(docKeys(contract)).toEqual(expect.arrayContaining([
      "docs/report-cards.md#v10-model",
      "docs/process/report-cards-appendix.md#scoped-evidence-and-exit-evaluation",
      "docs/report-cards.md#api", "docs/report-cards.md#consumers",
    ]));
    expect(docKeys({ docs: [...contract.docs, ...contract.background] }))
      .not.toContain("docs/digest-pipeline.md#generation");
    expect([...contract.docs, ...contract.background].some((doc) => doc.path === "docs/safety-score-map.md")).toBe(false);
    expect(buildRouteContext(contract).total.bytes).toBeLessThanOrEqual(80_000);
  });

  it.each([
    "worker/src/cron/compute-safety-score-v9.ts",
    "worker/src/cron/prepare-safety-score-v9-input.ts",
    "worker/src/lib/safety-score-v9/publication-journal.ts",
    "worker/src/lib/safety-score-v9/publication-replay-capture.ts",
    "worker/src/lib/safety-score-v9/publication-runner.ts",
  ])("routes a lone scoring publication path %s through the contract seam", (file) => {
    const contract = classifyChangedFiles([file]);
    expect(contract.contextMode.effective).toBe("contract");
    expect(docKeys(contract)).toEqual(expect.arrayContaining(["docs/report-cards.md#api", "docs/report-cards.md#consumers"]));
  });

  it("routes AI-summary data to editorial authoring and the actual-file claim validator", () => {
    const file = "data/ai-summaries.json";
    const contract = classifyChangedFiles([file]);
    expect(contract.unmappedPaths).toEqual([]);
    expect(contract.mappings.map((mapping) => mapping.id)).toContain("stablecoin-registry");
    expect(docKeys(contract)).toEqual(expect.arrayContaining([
      "docs/process/adding-a-stablecoin.md#6b-editorial-summary",
      "docs/editorial-style.md#registers-by-surface",
    ]));
    expectIntegrityObligations(contract, false);
    const commands = buildFocusedCheckPlan([file]).checks.map((check) => check.command);
    expect(commands.join("\n")).toContain("shared/lib/__tests__/ai-summary-claims.test.ts");
  });

  it("routes the browser CSS loader to its build contract and runtime tests", () => {
    const file = "public/critical-css-loader.js";
    const contract = classifyChangedFiles([file]);
    expect(contract.unmappedPaths).toEqual([]);
    expect(docKeys(contract)).toContain("docs/scripts.md#build-and-generated-artifacts");
    expect(DECLARED_TEST_OWNERSHIP.find((entry) => entry.sources.includes(file))?.tests)
      .toContain("scripts/__tests__/inline-homepage-critical-css.test.ts");
  });

  it("routes the generated llms index to bounded frontend discovery docs", () => {
    const file = "public/llms.txt";
    const contract = classifyChangedFiles([file]);
    expect(contract.unmappedPaths).toEqual([]);
    expect(contract.mappings.map((mapping) => mapping.id)).toEqual(["frontend-routes"]);
    expect(docKeys(contract)).toEqual([
      "docs/architecture.md#frontend-runtime-and-seo-surface",
      "docs/stablecoin-detail-page.md#route-shape",
    ]);
    expect(buildRouteContext(contract).status).toBe("within-budget");
  });

  it("routes the DexScreener parser to DEX discovery docs and its parser/census tests", () => {
    const file = "worker/src/lib/dexscreener.ts";
    const contract = classifyChangedFiles([file]);
    expect(contract.unmappedPaths).toEqual([]);
    expect(contract.mappings.map((mapping) => mapping.id)).toContain("methodology-scoring");
    expect(docKeys(contract)).toEqual(expect.arrayContaining([
      "docs/dex-liquidity.md#discovery-cron",
      "docs/process/dex-liquidity-appendix.md#methodology-versioning",
    ]));
    expect(DECLARED_TEST_OWNERSHIP.find((entry) => entry.sources.includes(file))?.tests).toEqual(expect.arrayContaining([
      "worker/src/lib/__tests__/dexscreener.test.ts",
      "worker/src/cron/dex-discovery/__tests__/dexscreener-census.test.ts",
    ]));
  });

  it.each([
    ["worker/src/lib/safety-score-v9/supply-attribution.ts", "supply-attribution-and-in-flight-accounting"],
    ["worker/src/cron/sync-v9-supply-attribution.ts", "supply-attribution-and-in-flight-accounting"],
    ["worker/src/lib/safety-score-v9/extension-bridge.ts", "bridge-in-flight-accounting"],
    ["shared/lib/safety-score-v9/control-bridge-join.ts", "bridge-in-flight-accounting"],
    ["shared/lib/safety-score-v9/__tests__/control-bridge-join.test.ts", "bridge-in-flight-accounting"],
  ])("retains the accounting contract for %s", (file, anchor) => {
    const contract = classifyChangedFiles([file]);
    expect(docKeys(contract)).toContain(`docs/process/report-cards-appendix.md#${anchor}`);
    expect(contract.requiredDocs).toContainEqual({ path: "docs/process/report-cards-appendix.md", anchor });
  });

  it.each(["json", "png"])("starts Functions map.%s with runtime serving and retains its feature owner", (extension) => {
    const file = `functions/safety-scores/map.${extension}.ts`;
    const contract = classifyChangedFiles([file]);
    expect(docKeys(contract).slice(0, 3)).toEqual([
      "docs/architecture.md#pages-function-endpoints-not-worker-api",
      "docs/worker-infrastructure.md#http-request-handling-entry",
      "docs/safety-score-map.md#serving",
    ]);
    expect(contract.mappings.map((mapping) => mapping.id)).toEqual(["validation-ci-policy", "safety-score-v9"]);
    expect(docKeys(contract)).toEqual(expect.arrayContaining(
      Array.from({ length: 8 }, (_, index) => `docs/architecture.md#adr-${index + 28}`),
    ));
    expect(docKeys(contract)).not.toContain("docs/testing.md#ci-pipeline");
    expect(docKeys({ docs: contract.background })).toContain("docs/deployment-process.md#ci-deploy-sequence");
    expect(buildRouteContext(contract).total.bytes).toBeLessThanOrEqual(40_000);
  });

  it.each([
    ["scripts/maintenance/build-safety-score-map.ts", "generator"],
    ["scripts/maintenance/publish-safety-score-map.ts", "publication"],
    [".github/workflows/safety-map-refresh.yml", "publication"],
  ])("keeps the map implementation owner bounded for %s", (file, anchor) => {
    const contract = classifyChangedFiles([file]);
    expect(docKeys(contract)[0]).toBe(`docs/safety-score-map.md#${anchor}`);
    expect(docKeys(contract)).not.toContain("docs/safety-score-map.md");
    if (anchor === "publication") expect(docKeys(contract)).toContain("docs/testing.md#ci-pipeline");
  });

  it.each([
    "scripts/maintenance/probe-page-performance.mjs",
    "scripts/maintenance/__tests__/probe-page-performance.test.ts",
    "scripts/maintenance/report-build-size.mjs",
    "scripts/maintenance/__tests__/report-build-size.test.ts",
    "scripts/maintenance/lighthouse-static-export.ts",
    "scripts/maintenance/analyze-web-vitals.mjs",
    "scripts/ci/check-live-api-cache-policy.mjs",
  ])("routes performance tooling %s to its guardrail contract and focused suites", (file) => {
    const contract = classifyChangedFiles([file]);
    expect(docKeys(contract)).toContain("docs/testing.md#performance-guardrails");
    expect(contract.checks.join("\n")).toContain("scripts/maintenance/__tests__/probe-page-performance.test.ts");
    expect(contract.checks.join("\n")).toContain("scripts/maintenance/__tests__/report-build-size.test.ts");
  });

  it.each(["worker/src/cron/daily-digest.ts", "worker/src/cron/digest-publication-watchdog.ts"])(
    "retains generation for digest producer %s", (file) => {
      expect(docKeys(classifyChangedFiles([file]))).toContain("docs/digest-pipeline.md#generation");
    },
  );

  it.each([
    ["docs/safety-score-map.md", "docs/safety-score-map.md#serving"],
    ["docs/process/report-cards-appendix.md", "docs/process/report-cards-appendix.md#scoped-evidence-and-exit-evaluation"],
    ["docs/report-cards.md", "docs/report-cards.md#v10-model"],
    ["docs/process/report-cards-evidence-log.md", "docs/process/report-cards-appendix.md#scoped-evidence-and-exit-evaluation"],
  ])("selects scoring documentation %s without the broad family fallback", (file, owner) => {
    const contract = classifyChangedFiles([file]);
    expect(docKeys(contract)).toContain(owner);
    expect(docKeys(contract)).not.toContain("docs/digest-pipeline.md#generation");
    expect(docKeys(contract)).not.toContain("docs/process/report-cards-appendix.md#supply-attribution-and-in-flight-accounting");
  });

  it.each(["worker/src/cron/dex-liquidity/orchestrator.ts", "worker/src/api/yield-history.ts"])(
    "accounts for unconditional bounded Worker obligations on %s", (file) => {
      const contract = classifyChangedFiles([file]);
      expect(docKeys(contract)).toEqual(expect.arrayContaining([
        "docs/worker-infrastructure.md#module-initialization",
        "docs/worker-and-api-limits.md#connection-budget-operating-assumption",
      ]));
      if (file.includes("/cron/")) {
        expect(docKeys(contract)).toEqual(expect.arrayContaining([
          "docs/process/cron-trigger-policy.md#source-of-truth",
          "docs/process/cron-trigger-policy.md#target",
          "docs/worker-infrastructure.md#event-entry-lifecycle-and-admission",
          "docs/dex-liquidity.md#discovery-cron",
        ]));
        expect(docKeys(contract)).not.toContain("docs/process/cron-trigger-policy.md");
      } else {
        expect(docKeys(contract)).toContain("docs/worker-infrastructure.md#http-request-handling-entry");
        expect(docKeys(contract)).toContain("docs/api-reference.md#get-apiyield-history");
        expect(docKeys(contract)).not.toContain("docs/api-reference.md#public-endpoints");
      }
    },
  );

  it("preserves check-planner inputs for every distinct matched-family and reading-selector signature", () => {
    const ids: Record<string, true> = {
      "safety-score-v9": true, "validation-ci-policy": true, "methodology-scoring": true,
      "worker-cron": true, "worker-runtime": true, "worker-api-auth": true,
    };
    const families = PATH_FAMILIES.filter((family) => ids[family.id]);
    readingSignatures ??= enumerateReadingSignatures();
    const files = readingSignatures.filter((entry) => entry.mode === "auto" &&
      entry.signature.some((family) => ids[family.id] && family.selectors.length > 0)).map((entry) => entry.file);
    expect(files.length).toBeGreaterThan(0);
    // The focused planner consumes changed paths and ordered mapping IDs, then
    // reads source globs/checks/tier from the unchanged families. Baseline,
    // deploy and lint selectors use those same paths, never reading refs.
    function plannerInputs(file: string) {
      const { changedFiles, mappings, checks, unmappedPaths, deploy } = classifyChangedFiles([file]);
      return { changedFiles, mappings, checks, unmappedPaths, deploy };
    }
    const selectedInputs = files.map(plannerInputs);
    const selectors = families.map((family) => family.reading);
    try {
      for (const family of families) family.reading = undefined;
      files.forEach((file, index) => {
        expect(JSON.stringify(plannerInputs(file)), file).toBe(JSON.stringify(selectedInputs[index]));
      });
    } finally {
      families.forEach((family, index) => { family.reading = selectors[index]; });
    }
  });
});

/** Labelled byte-budget failures (measured, ceiling, excess) for one route. */
function routeBudgetFailures(label: string, bytes: number, ceiling: number): string[] {
  return bytes > ceiling ? [`${label}: ${bytes} bytes > ${ceiling} (excess ${bytes - ceiling})`] : [];
}

describe("route context enforcement and fixture ratchets", () => {
  it.each(ROUTE_FIXTURES)("keeps %s within its exact auto/contract fixture ceilings", (file, autoCeiling, contractCeiling) => {
    // Visit both modes before asserting so one breach cannot hide the other.
    const failures: string[] = [];
    for (const [mode, ceiling] of [["auto", autoCeiling], ["contract", contractCeiling]] as const) {
      try {
        const context = buildRouteContext(classifyChangedFiles([file], mode));
        failures.push(...routeBudgetFailures(`${file} (${mode})`, context.total.bytes, ceiling));
        if (ceiling > context.ceiling) failures.push(`${file} (${mode}): fixture ${ceiling} exceeds class ceiling ${context.ceiling}`);
        if (context.status !== "within-budget") failures.push(`${file} (${mode}): status ${context.status}`);
        if (context.ceiling !== ROUTE_CONTEXT_CEILINGS[context.class]) failures.push(`${file} (${mode}): ceiling ${context.ceiling} is not the ${context.class} class ceiling`);
      } catch (error) {
        failures.push(`${file} (${mode}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("bounds every tracked mapped reading signature in both modes", () => {
    readingSignatures ??= enumerateReadingSignatures();
    const documents: RouteContextDocumentCache = new Map();
    const measuredBytes = new Map<string, number>();
    const failures: string[] = [];
    expect(new Set(readingSignatures.map((entry) => entry.mode))).toEqual(new Set(["auto", "contract"]));
    for (const { file, mode, contract } of readingSignatures) {
      // Selector signatures can select identical reading sets. Measure their
      // union once, but compare every signature against its own class ceiling.
      // An unreadable document or anchor is reported and enumeration continues;
      // it is never treated as zero bytes or as a pass.
      try {
        const key = JSON.stringify([
          [...contract.scopedContext].sort(),
          contract.docs.map((doc) => `${doc.path}#${doc.anchor ?? ""}`).sort(),
        ]);
        let bytes = measuredBytes.get(key);
        if (bytes === undefined) {
          bytes = buildRouteContext(contract, { documents }).total.bytes;
          measuredBytes.set(key, bytes);
        }
        const routeClass = classifyRouteContext(contract);
        failures.push(...routeBudgetFailures(`${file} (${mode}, ${routeClass})`, bytes, ROUTE_CONTEXT_CEILINGS[routeClass]));
      } catch (error) {
        failures.push(`${file} (${mode}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("labels every budget breach so one enumeration reports all of them", () => {
    expect([
      ...routeBudgetFailures("a (auto)", 120, 100),
      ...routeBudgetFailures("b (contract)", 100, 100),
      ...routeBudgetFailures("c (contract)", 131, 100),
    ]).toEqual(["a (auto): 120 bytes > 100 (excess 20)", "c (contract): 131 bytes > 100 (excess 31)"]);
  });

  it("retains the evaluator and Functions map acceptance limits in both modes", () => {
    for (const mode of ["auto", "contract"] as const) {
      expect(buildRouteContext(classifyChangedFiles(["shared/lib/safety-score-v9/evaluate-asset.ts"], mode)).total.bytes).toBeLessThanOrEqual(80_000);
      expect(buildRouteContext(classifyChangedFiles(["functions/safety-scores/map.json.ts"], mode)).total.bytes).toBeLessThanOrEqual(40_000);
    }
  });

  it("charges every multi-file route to the 160 KB union without double-counting common guides", () => {
    const files = ["shared/lib/safety-score-v9/evaluate-asset.ts", "functions/safety-scores/map.json.ts"];
    const contract = classifyChangedFiles(files);
    const context = buildRouteContext(contract);
    expect(context.class).toBe("multi-domain-batch");
    expect(context.ceiling).toBe(160_000);
    expect(context.status).toBe("within-budget");
    expect(context.files.filter((file) => file.path === "AGENTS.md")).toHaveLength(1);
    expect(context.total.bytes).toBeLessThan(files.reduce((sum, file) =>
      sum + buildRouteContext(classifyChangedFiles([file], "contract")).total.bytes, 0));
    // Even two paths in the same family use the batch guard, not a sum of caps.
    expect(buildRouteContext(classifyChangedFiles([
      "src/components/stablecoin-table.tsx", "src/app/yield/page.tsx",
    ])).class).toBe("multi-domain-batch");
  });

  it.each(["text", "json"] as const)("fails oversized batch CLI %s with the complete plan and contributions", (format) => {
    const files = ROUTE_FIXTURES.map(([file]) => file);
    const result = spawnSync(process.execPath, [
      "--import", "tsx", "scripts/ci/pharos-change-contract.ts",
      ...files.flatMap((file) => ["--file", file]), ...(format === "json" ? ["--json"] : []),
    ], { encoding: "utf8" });
    expect(result.status).toBe(1);
    const contract = classifyChangedFiles(files);
    const context = buildRouteContext(contract);
    expect(context.status).toBe("over-budget");
    if (format === "json") {
      const output = JSON.parse(result.stdout);
      expect(output.context).toEqual(context);
      expect(output.requiredDocs).toEqual(contract.requiredDocs);
      expect(output.hardRules).toEqual(contract.hardRules);
      expect(output.checks).toEqual(buildFocusedCheckPlan(files).checks.map((check) => check.command));
      expect(output.context.remediation).toContain("smaller explicit path groups");
    } else {
      expect(result.stdout).toContain("multi-domain-batch — over-budget (ceiling 160000 B)");
      expect(result.stdout).toContain("smaller explicit path groups");
      for (const reference of context.references) {
        expect(result.stdout).toContain(reference.anchor ? `${reference.path}#${reference.anchor}` : reference.path);
      }
      for (const file of context.files) expect(result.stdout).toContain(`${file.path}: ${file.bytes} B`);
      for (const rule of contract.hardRules) expect(result.stdout).toContain(rule);
      for (const check of buildFocusedCheckPlan(files).checks) expect(result.stdout).toContain(check.command);
    }
  });

  it("fails an enlarged required section without removing its reference or coupling hooks/checks to size", () => {
    // Patch reads only in the child: no repository files or authored obligations
    // change, and the real CLI exit path still sees the enlarged ADR-28 section.
    const script = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import * as router from "./scripts/ci/pharos-change-contract.ts";
      import { buildFocusedCheckPlan } from "./scripts/maintenance/run-focused-checks.ts";
      const original = fs.readFileSync;
      let reads = 0;
      fs.readFileSync = function(path, ...args) {
        const value = original.call(this, path, ...args);
        if (String(path).endsWith("/docs/architecture.md") && typeof value === "string") {
          reads++;
          return value.replace("#### ADR-28\\n", "#### ADR-28\\n" + "x".repeat(200_000) + "\\n");
        }
        return value;
      };
      syncBuiltinESMExports();
      const files = ["shared/lib/safety-score-v9/evaluate-asset.ts"];
      const contract = router.classifyChangedFiles(files);
      buildFocusedCheckPlan(files);
      router.buildSessionStartHookOutput(contract);
      router.buildPreToolUseHookOutput({ tool_name: "Read", tool_input: { file_path: "AGENTS.md" } });
      router.buildPermissionRequestHookOutput({ tool_name: "Read", tool_input: { file_path: "AGENTS.md" } });
      if (reads !== 0) throw new Error("Hooks/check planner opened routed Markdown");
      router.runCli(["--file", files[0], "--json"]);
      if (reads === 0) throw new Error("CLI did not account for the mutated required section");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.context.status).toBe("over-budget");
    expect(output.context.total.bytes).toBeGreaterThan(output.context.ceiling);
    expectIntegrityObligations(output, true);
    expect(output.context.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "docs/architecture.md", anchor: "adr-28", requiredReason: expect.stringContaining("Required") }),
    ]));
    expect(output.checks).toEqual(buildFocusedCheckPlan(output.changedFiles).checks.map((check) => check.command));
  });

  it("catches a removed required obligation independently of its smaller byte total", () => {
    const file = "shared/lib/classification.ts";
    const baseline = classifyChangedFiles([file]);
    const before = buildRouteContext(baseline);
    const families = PATH_FAMILIES.filter((family) => baseline.mappings.some((mapping) => mapping.id === family.id));
    const originals = families.map((family) => family.required);
    try {
      for (const family of families) {
        family.required = family.required?.filter((doc) => !(doc.path === "docs/architecture.md" && doc.anchor === "adr-28"));
      }
      const contract = classifyChangedFiles([file]);
      const context = buildRouteContext(contract);
      expect(context.total.bytes).toBeLessThan(before.total.bytes);
      expect(context.status).toBe("within-budget");
      expect(() => expectIntegrityObligations(contract, false)).toThrow();
    } finally {
      families.forEach((family, index) => { family.required = originals[index]; });
    }
  });

  it("does not accept a budget-bypass flag", () => {
    const result = spawnSync(process.execPath, [
      "--import", "tsx", "scripts/ci/pharos-change-contract.ts", "--ignore-budget",
      "--file", "shared/lib/safety-score-v9/evaluate-asset.ts",
    ], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--ignore-budget");
  });
});

describe("representative --file routing", () => {
  function route(file: string) {
    return classifyChangedFiles([file]);
  }

  it("reports evaluator JSON accounting without changing references or synthesized checks", () => {
    const file = "shared/lib/safety-score-v9/evaluate-asset.ts";
    const result = spawnSync(process.execPath,
      ["--import", "tsx", "scripts/ci/pharos-change-contract.ts", "--file", file, "--json"],
      { encoding: "utf8" });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    const contract = route(file);
    expect(output.docs).toEqual(contract.docs);
    expect(output.background).toEqual(contract.background);
    expect(output.scopedContext).toEqual(contract.scopedContext);
    expect(output.context).toEqual(buildRouteContext(contract));
    expect(output.checks).toEqual(buildFocusedCheckPlan([file]).checks.map((check) => check.command));
  });

  it("caps single-path guidance while preserving ranked overflow in background", () => {
    const originalLength = PATH_FAMILIES.length;
    const family = {
      background: [], checks: [], hardRules: [], scopedContext: [],
      sourceGlobs: ["audit-overflow.fixture"], tier: "specific" as const,
    };
    PATH_FAMILIES.push(
      { ...family, id: "low", label: "A low", risk: "low", docs: [{ path: "low.md" }] },
      { ...family, id: "high", label: "Z high", risk: "high",
        docs: ["one.md", "two.md", "three.md", "four.md", "five.md", "six.md", "seven.md"].map((path) => ({ path })) },
    );
    try {
      const contract = route("audit-overflow.fixture");
      expect(docKeys(contract)).toEqual(["one.md", "two.md", "three.md", "four.md", "five.md", "six.md"]);
      expect(contract.background.slice(0, 2)).toEqual([{ path: "seven.md" }, { path: "low.md" }]);
      expect(contract.background.some((doc) => docKeys(contract).includes(doc.path))).toBe(false);
    } finally {
      PATH_FAMILIES.splice(originalLength);
    }
  });

  it("prints the same synthesized plan as focused checks", () => {
    const file = "worker/src/cron/sync-yield-data.ts";
    const result = spawnSync(process.execPath,
      ["--import", "tsx", "scripts/ci/pharos-change-contract.ts", "--file", file, "--json"],
      { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).checks).toEqual(buildFocusedCheckPlan([file]).checks.map((check) => check.command));
    expect(JSON.parse(result.stdout).checks).not.toContain("npm run check:structural");
    const contract = classifyChangedFiles([file]);
    expect(JSON.parse(result.stdout).context).toEqual(buildRouteContext(contract));
  });

  it.each([
    ["worker/src/cron/dex-liquidity/orchestrator.ts", "docs/dex-liquidity.md"],
    ["worker/src/cron/dex-liquidity/lifecycle/source-slot.ts", "docs/process/dex-liquidity-appendix.md"],
    ["worker/src/cron/mint-burn/run.ts", "docs/mint-burn-flows.md"],
    ["worker/src/cron/sync-mint-burn.ts", "docs/mint-burn-flows.md"],
  ])("routes %s to its domain contract", (file, ownerDoc) => {
    const contract = route(file);

    expect(contract.unmappedPaths).toEqual([]);
    expect(contract.mappings.map((mapping) => mapping.id)).toContain("methodology-scoring");
    expect([...contract.docs, ...contract.background].map((doc) => doc.path)).toContain(ownerDoc);
  });

  it("returns only routed docs and rules without unconditional onboarding or hints", () => {
    const contract = route("functions/social-posts/example.ts");
    expect(docKeys(contract)).not.toContain("docs/process/agent-start-here.md");
    expect(contract.hardRules).toContain("Keep the dated manifest immutable.");
    expect(contract.hardRules).not.toContain("Keep Tailwind classes as static strings.");
    expect(contract).not.toHaveProperty("hints");
    expect(formatContract(contract)).not.toContain("Hints:");
  });

  it("loads one authored root through the Claude import without mirror warnings", () => {
    expect(readFileSync("CLAUDE.md", "utf8")).toBe("@AGENTS.md\n");
    const root = readFileSync("AGENTS.md", "utf8");
    expect(root).toContain("<!-- BEGIN:nextjs-agent-rules -->");
    expect(root).toContain("<!-- END:nextjs-agent-rules -->");
    const contract = route("AGENTS.md");
    expect(contract.hardRules).toContain("Root AGENTS.md is the single authored instruction file; CLAUDE.md imports it.");
    expect(contract.warnings).toEqual([]);
  });

  it.each([
    ["--base", "--head"], ["--base", "--head-ref"],
    ["--base-ref", "--head"], ["--base-ref", "--head-ref"],
  ])("accepts range aliases %s and %s", (baseFlag, headFlag) => {
    const result = spawnSync(process.execPath,
      ["--import", "tsx", "scripts/ci/pharos-change-contract.ts", baseFlag, "HEAD", headFlag, "HEAD", "--json"],
      { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ changedFiles: [], source: "base/head range" });
  });
});

describe("Codex hook outputs", () => {
  it("emits no decision for an allowed PermissionRequest", () => {
    expect(
      buildPermissionRequestHookOutput({
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "git status" },
      }),
    ).toEqual({});
  });
});

describe("shell command analysis", () => {
  it("provides one immutable command view to ordered policies", () => {
    const analysis = analyzeShellCommand(
      "git reset --hard HEAD && npx wrangler pages deploy out",
      process.cwd(),
    );

    expect(Object.isFrozen(analysis)).toBe(true);
    expect(Object.isFrozen(analysis.invocations)).toBe(true);
    expect(analysis.invocations.map((invocation) => invocation.name)).toEqual([
      "git",
      "wrangler",
    ]);
    expect(findShellCommandViolation(analysis)?.rule).toBe("git-destructive");
  });

  it("preserves literal heredoc bytes, expansion mode and receiving command", () => {
    const body = "\tg\\\nit status";
    const analysis = analyzeShellCommand(`cat <<DATA; env CI=1 sh <<-'SCRIPT'\nexample\nDATA\n${body}\n\tSCRIPT`, process.cwd());
    expect(analysis.hereDocs.map(({ body, quoted, stripTabs, receiver, feedsStdin }) =>
      ({ body, quoted, stripTabs, receiver, feedsStdin }))).toEqual([
      { body: "example", quoted: false, stripTabs: false, receiver: ["cat", "<<", "DATA"], feedsStdin: true },
      { body, quoted: true, stripTabs: true, receiver: ["env", "CI=1", "sh", "<<-", "SCRIPT"], feedsStdin: true },
    ]);
    expect(Object.isFrozen(analysis.hereDocs[1].receiver)).toBe(true);
  });

  it("keeps single-quoted continuation bytes in arguments", () => {
    const literal = "g\\\nit reset --hard HEAD";
    const analysis = analyzeShellCommand(`printf '%s' '${literal}'`, process.cwd());
    expect(analysis.invocations[0].tokens).toEqual(["printf", "%s", literal]);
  });
});

describe("hard-block hook outputs", () => {
  it.each([
    { tool_name: "Bash", tool_input: { command: "git reset --hard HEAD" } },
    { tool_name: "exec_command", tool_input: { cmd: "git reset --hard HEAD" } },
    { toolName: "exec_command", toolInput: { cmd: "git reset --hard HEAD" } },
    { tool: "exec_command", arguments: { cmd: "git reset --hard HEAD" } },
    { cmd: "git reset --hard HEAD" },
  ])("inspects shell command fields across supported hook payloads: %j", (input) => {
    expect(buildPreToolUseHookOutput(input)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(buildPermissionRequestHookOutput(input)).toMatchObject({
      hookSpecificOutput: { decision: { behavior: "deny" } },
    });
  });

  it("allows a read-only exec_command cmd payload", () => {
    const input = { tool_name: "exec_command", tool_input: { cmd: "git status --short" } };
    expect(buildPreToolUseHookOutput(input)).toEqual({});
    expect(buildPermissionRequestHookOutput(input)).toEqual({});
  });

  it.each([
    ["continued executable", "g\\\nit reset --hard HEAD"],
    ["continued argument boundary", "git reset \\\n--hard HEAD"],
    ["continued subcommand", "git re\\\nset --hard HEAD"],
    ["continued flag", "git reset --ha\\\nrd HEAD"],
    ["double-quoted continuation", '"g\\\nit" "re\\\nset" "--ha\\\nrd" HEAD'],
    ["continued deploy", "wrang\\\nler pages de\\\nploy out"],
    ["continued D1", "wrangler d1 \\\nexecute stablecoin-db --re\\\nmote --command 'DELETE FROM cache'"],
    ["nested continuation", "echo $(g\\\nit reset --hard HEAD)"],
    ["quoted shell heredoc", "bash <<'EOF'\ngit reset --hard HEAD\nEOF"],
    ["unquoted shell heredoc", "sh <<EOF\nwrangler deploy\nEOF"],
    ["tab-stripped heredoc", "bash <<-'EOF'\n\twrangler pages deploy out\n\tEOF"],
    ["wrapped shell heredoc", "env CI=1 command sh <<'EOF'\nwrangler d1 execute stablecoin-db --remote --command 'DELETE FROM cache'\nEOF"],
    ["assignment-prefixed shell heredoc", "CI=1 sh <<'EOF'\ngit reset --hard HEAD\nEOF"],
    ["continued heredoc header", 'ba\\\nsh <<"EO\\\nF"\ngit reset --hard HEAD\nEOF'],
    ["continued heredoc script", "sh <<'EOF'\ng\\\nit reset --ha\\\nrd HEAD\nEOF"],
    ["explicit stdin script with args", "sh -s -- example <<'EOF'\ngit reset --hard HEAD\nEOF"],
    ["leading heredoc redirection", "<<'EOF' sh\ngit reset --hard HEAD\nEOF"],
    ["explicit stdin descriptor", "sh 0<<'EOF'\ngit reset --hard HEAD\nEOF"],
    ["heredoc with output redirection", "sh <<'EOF' > ./report.txt\ngit reset --hard HEAD\nEOF"],
    ["escaped heredoc delimiter", "sh <<\\EOF\ngit reset --hard HEAD\nEOF"],
    ["stdin script with unterminated delimiter", "sh <<'EOF'\ng\\\nit reset --hard HEAD"],
    ["last stdin heredoc wins", "sh <<SAFE <<'SCRIPT'\ngit status\nSAFE\ngit reset --hard HEAD\nSCRIPT"],
    ["separate command receivers", "cat <<DATA; sh <<'SCRIPT'\nexample\nDATA\nwrangler deploy\nSCRIPT"],
    ["nested shell heredoc", 'bash -c "sh <<\'EOF\'\ngit reset --hard HEAD\nEOF"'],
    ["continued unquoted delimiter", "cat <<EOF\nexample\nEO\\\nF\ngit reset --hard HEAD"],
    ["continued expansion in data heredoc", "cat <<EOF\n$(g\\\nit reset --hard HEAD)\nEOF"],
  ])("denies %s in both hook modes", (_label, command) => {
    const input = { tool_input: { command } };
    expect(buildPreToolUseHookOutput(input)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(buildPermissionRequestHookOutput(input)).toMatchObject({
      hookSpecificOutput: { decision: { behavior: "deny" } },
    });
  });

  it.each([
    ["single-quoted literal", "echo 'g\\\nit reset --hard HEAD'"],
    ["read-only continuation", "g\\\nit sta\\\ntus --short"],
    ["read-only double-quoted continuation", '"g\\\nit" "sta\\\ntus" --short'],
    ["read-only D1 continuation", "wrangler d1 \\\nexecute stablecoin-db --local --command 'SELECT 1'"],
    ["read-only shell heredoc", "sh <<EOF\ng\\\nit status --short\nEOF"],
    ["quoted read-only shell heredoc", "env CI=1 bash <<'EOF'\ngit status --short\nEOF"],
    ["literal shell example", "sh <<'EOF'\necho 'git reset --hard HEAD'\nEOF"],
    ["quoted Node example", "node - <<'EOF'\nconsole.log('git reset --hard HEAD');\nEOF"],
    ["unquoted Node example without expansion", "node - <<EOF\nconsole.log('wrangler deploy');\nEOF"],
    ["script filename consumes data", "sh ./report.sh <<'EOF'\ngit reset --hard HEAD\nEOF"],
    ["wrapped script filename consumes data", "env CI=1 command bash --noprofile ./report.sh <<EOF\nwrangler deploy\nEOF"],
    ["command argument consumes data", "sh -c 'cat' <<'EOF'\ngit reset --hard HEAD\nEOF"],
    ["pipeline into a script filename", "printf '%s\\n' 'git reset --hard HEAD' | sh ./report.sh"],
    ["overridden stdin heredoc", "sh <<'DATA' <<'SCRIPT'\ngit reset --hard HEAD\nDATA\ngit status --short\nSCRIPT"],
    ["non-stdin heredoc", "sh 3<<'EOF'\ngit reset --hard HEAD\nEOF"],
    ["file replaces heredoc stdin", "sh <<'EOF' < ./input.sh\ngit reset --hard HEAD\nEOF"],
    ["quoted expansion stays inert", "cat <<'EOF'\n$(g\\\nit reset --hard HEAD)\nEOF"],
    ["quoted input operator argument", "printf '%s' '<' 'git reset --hard HEAD'"],
  ])("allows %s in both hook modes", (_label, command) => {
    const input = { tool_input: { command } };
    expect(buildPreToolUseHookOutput(input)).toEqual({});
    expect(buildPermissionRequestHookOutput(input)).toEqual({});
  });

  function patchHeredocThen(mention: string, command: string): string {
    return [
      "apply_patch <<'PATCH'",
      "*** Begin Patch",
      "*** Update File: docs/example.md",
      "@@",
      `+${mention}`,
      "*** End Patch",
      "PATCH",
      command,
    ].join("\n");
  }

  it.each([
    ["destructive git reset", "git reset --hard HEAD", "git reset --hard"],
    ["git global flags", "git --no-pager reset --hard HEAD", "git reset --hard"],
    ["production deploy", "cd worker && npx --no-install wrangler versions deploy 00000000-0000-0000-0000-000000000000@100", "Raw production deploy commands"],
    ["heavy production deploy", "cd worker && npx --no-install wrangler deploy --config wrangler.heavy.toml", "Raw production deploy commands"],
    ["shell eval wrapper", 'bash -lc "cd worker && npx --no-install wrangler pages deploy out"', "opaque shell construct"],
    ["remote D1 mutation", "cd worker && npx --no-install wrangler d1 migrations apply stablecoin-db --remote", "Remote D1 mutation commands"],
    [
      "a deploy appended after an apply_patch heredoc",
      patchHeredocThen(
        "Do not run `wrangler deploy`; use the release workflow.",
        "npx --no-install wrangler pages deploy out",
      ),
      "Raw production deploy commands",
    ],
    [
      "a remote D1 mutation appended after an apply_patch heredoc",
      patchHeredocThen(
        "Mention wrangler d1 execute stablecoin-db --remote without executing it.",
        "npx --no-install wrangler d1 execute stablecoin-db --remote --command 'delete from cache'",
      ),
      "Remote D1 mutation commands",
    ],
    [
      "a protected redirection appended after an apply_patch heredoc",
      patchHeredocThen("Document .env.local without writing it.", "echo TOKEN=value > .env.local"),
      "environment files",
    ],
    [
      "a patch payload that adds a protected path",
      ["*** Begin Patch", "*** Add File: .env.local", "+TOKEN=value", "*** End Patch"].join("\n"),
      "environment files",
    ],
    [
      "a guarded substitution hidden in a heredoc body",
      ["cat <<EOF", "$(npx wrangler d1 execute stablecoin-db --remote --command 'DELETE FROM cache')", "EOF"].join("\n"),
      "opaque shell construct",
    ],
    [
      "a guarded substitution in the first of two heredocs opened on one line",
      [
        "cat <<FIRST <<SECOND",
        "$(npx wrangler d1 execute stablecoin-db --remote --command 'DELETE FROM cache')",
        "FIRST",
        "benign",
        "SECOND",
      ].join("\n"),
      "opaque shell construct",
    ],
    [
      "a remote D1 mutation hidden behind a comment fake heredoc marker",
      [
        "cat <<EOF # <<FAKE",
        "benign",
        "EOF",
        "npx --no-install wrangler d1 execute stablecoin-db --remote --command 'delete from cache'",
      ].join("\n"),
      "Remote D1 mutation commands",
    ],
    [
      "a remote D1 mutation hidden behind a quoted fake heredoc marker",
      [
        "cat <<EOF '<<FAKE'",
        "benign",
        "EOF",
        "npx --no-install wrangler d1 execute stablecoin-db --remote --command 'delete from cache'",
      ].join("\n"),
      "Remote D1 mutation commands",
    ],
    [
      "a deploy hidden behind a comment fake heredoc marker",
      ["cat <<EOF # <<FAKE", "benign", "EOF", "npx --no-install wrangler pages deploy out"].join("\n"),
      "Raw production deploy commands",
    ],
    [
      "a guarded command hidden in an unterminated heredoc",
      [
        "cat <<EOF",
        "npx --no-install wrangler d1 execute stablecoin-db --remote --command 'delete from cache'",
      ].join("\n"),
      "opaque shell construct",
    ],
  ])("blocks %s with its denial category", (_name, command, reason) => {
    const output = buildPreToolUseHookOutput({ tool_input: { command } });
    expect(output).toMatchObject({
      decision: "block",
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(requireBlockingReason(output)).toContain(reason);
  });

  it("denies fake-heredoc-marker-hidden mutations in both hook modes", () => {
    const command = [
      "cat <<EOF # <<FAKE",
      "benign",
      "EOF",
      "npx --no-install wrangler d1 execute stablecoin-db --remote --command 'delete from cache'",
    ].join("\n");

    const preToolUse = buildPreToolUseHookOutput({ tool_input: { command } });
    expect(preToolUse).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(requireBlockingReason(preToolUse)).toContain("Remote D1 mutation commands");
    expect(buildPermissionRequestHookOutput({ tool_input: { command } })).toMatchObject({
      hookSpecificOutput: { decision: { behavior: "deny" } },
    });
  });

  it.each([
    ["bypassing only the advisory local gate", "git push --no-verify origin main"],
    ["bypassing the advisory local gate behind -C flags", "git -C /tmp -C /repo push --no-verify origin main"],
    [
      "a search that mentions deploy and remote D1 commands",
      'rg -n "wrangler deploy|wrangler pages deploy|wrangler d1 migrations apply stablecoin-db --remote" docs scripts',
    ],
    [
      "a patch payload that only mentions deploy commands",
      [
        "*** Begin Patch",
        "*** Update File: docs/example.md",
        "@@",
        "+Do not run `wrangler deploy`; use the release workflow.",
        "*** End Patch",
      ].join("\n"),
    ],
    [
      "a heredoc script that only quotes blocked commands",
      [
        "node - <<'NODE'",
        "console.log('wrangler pages deploy');",
        "console.log('wrangler d1 execute stablecoin-db --remote --command \"delete from cache\"');",
        "NODE",
      ].join("\n"),
    ],
    ["help output for a deploy-shaped command", "npx --no-install wrangler pages deploy --help"],
  ])("allows %s", (_name, command) => {
    expect(buildPreToolUseHookOutput({ tool_input: { command } })).toEqual({});
  });

  it.each([
    {
      name: "a direct env file write",
      tool_input: { content: "TOKEN=value", file_path: ".env.local" },
      reason: "environment files",
    },
    {
      name: "destructive migration SQL",
      tool_input: {
        patch: [
          "*** Begin Patch",
          "*** Update File: worker/migrations/9999_example.sql",
          "@@",
          "+DROP TABLE stablecoin_snapshots;",
          "*** End Patch",
        ].join("\n"),
      },
      reason: "destructive migration SQL",
    },
  ])("blocks $name arriving without a command", ({ tool_input, reason }) => {
    const output = buildPreToolUseHookOutput({ tool_input });
    expect(output).toMatchObject({
      decision: "block",
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(requireBlockingReason(output)).toContain(reason);
  });

  it.each([
    ["production deploys", "npx wrangler versions deploy", "Production deploy permission is denied"],
    [
      "remote D1 mutations",
      "npx wrangler d1 execute stablecoin-db --remote --command 'update prices set value = 1'",
      "Remote D1 mutation permission is denied",
    ],
  ])("denies %s as permission requests", (_name, command, message) => {
    expect(buildPermissionRequestHookOutput({ tool_input: { command } })).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: expect.stringContaining(message),
        },
      },
    });
  });
});

describe("W2.7 opaque shell guards", () => {
  const blockedOpaqueCommands = [
    ["command substitution", "echo $(git reset --hard HEAD)"],
    ["backticks", "echo `git clean -fd`"],
    ["eval", "eval 'wrangler d1 execute stablecoin-db --remote --command \"delete from cache\"'"],
    ["sh -c", "sh -c 'git reset --hard HEAD'"],
    ["bash -c", "bash -c 'wrangler deploy'"],
    ["zsh -c", "zsh -c 'worker/migrations/0240_guard.sql'"],
    ["pipe to sh", "printf guarded | sh -c 'git clean -fd'"],
    ["stdin-fed reset", "printf '%s\\n' 'git reset --hard HEAD' | sh"],
    ["stdin-fed deploy", "printf '%s\\n' 'wrangler pages deploy out' | sh"],
    ["stdin-fed remote D1 mutation", "printf '%s\\n' 'wrangler d1 execute stablecoin-db --remote --command \"DELETE FROM cache\"' | sh"],
    ["wrapped stdin shell", "printf '%s\\n' 'git reset --hard HEAD' | env CI=1 command sh"],
    ["wrapped stdin producer", "env CI=1 printf '%s\\n' 'git reset --hard HEAD' | nice -n 2 bash"],
    ["dash stdin shell", "echo 'git reset --hard HEAD' | /bin/dash"],
    ["multi-stage stdin pipeline", "printf '%s\\n' 'git reset --hard HEAD' | cat | exec sh"],
    ["opaque guarded stdin producer", "cat 'git reset --hard HEAD' | sh"],
    ["split printf script", "printf '%s %s\\n' git 'reset --hard HEAD' | sh"],
    ["nested stdin pipeline", "sh -c \"printf '%s\\\\n' 'git reset --hard HEAD' | env sh\""],
    ["background separator", "echo ready & wrangler deploy"],
    ["xargs sh", "printf guarded | xargs sh -c 'git reset --hard HEAD'"],
  ] as const;

  it.each(blockedOpaqueCommands)("blocks a guarded %s construct", (_label, command) => {
    const output = buildPreToolUseHookOutput({ tool_input: { command } });

    expect(requireBlockingReason(output)).toContain("opaque shell construct around a guarded command; run it directly");
  });

  it.each([
    "printf '%s\\n' 'git reset --hard HEAD' | sh",
    "printf '%s\\n' 'wrangler pages deploy out' | sh",
    "printf '%s\\n' 'wrangler d1 execute stablecoin-db --remote --command \"DELETE FROM cache\"' | env sh",
  ])("denies guarded stdin scripts in permission requests: %s", (command) => {
    expect(buildPermissionRequestHookOutput({ tool_input: { command } })).toMatchObject({
      hookSpecificOutput: {
        decision: { behavior: "deny", message: expect.stringContaining("opaque shell construct around a guarded command") },
      },
    });
  });

  const allowedOpaqueCommands = [
    ["command substitution", "echo $(git rev-parse HEAD)"],
    ["backticks", "echo `git status --short`"],
    ["eval", "eval 'git status --short'"],
    ["sh -c", "sh -c 'git status --short'"],
    ["bash -c", "bash -c 'git status --short'"],
    ["zsh -c", "zsh -c 'git status --short'"],
    ["pipe to sh", "printf status | sh"],
    ["wrapped stdin shell", "printf status | env CI=1 command sh"],
    ["stdin-fed read-only git", "printf '%s\\n' 'git status --short' | sh"],
    ["stdin-fed deployment help", "printf '%s\\n' 'wrangler deploy --help' | sh"],
    ["stdin-fed literal example", "printf '%s\\n' \"echo 'git reset --hard HEAD'\" | sh"],
    ["unrelated pipeline keyword", "echo 'git reset --hard HEAD'; printf status | sh"],
    ["background separator", "git status --short & echo done"],
    ["xargs sh", "printf status | xargs sh"],
    ["background keyword argument", "echo ready & echo deploy"],
    ["URL keyword argument", "curl https://x/deploy &"],
    ["quoted keyword argument", "echo \"git reset --hard\" > notes.txt"],
    ["unrelated git subcommand", "git log --oneline & sleep 1"],
  ] as const;

  it.each(allowedOpaqueCommands)("allows an unguarded %s construct", (_label, command) => {
    expect(buildPreToolUseHookOutput({ tool_input: { command } })).toEqual({});
  });
});

describe("W2.7 shell indirection guards", () => {
  const blockedIndirectionCommands = [
    "sh -c 'git \"$@\"' sh reset --hard",
    "g=git; $g reset --hard",
    "${GIT:-git} reset --hard",
    "command git reset --hard",
    "env git reset --hard",
    "exec git reset --hard",
    "nice git reset --hard",
    "nohup git reset --hard",
    "time git reset --hard",
  ] as const;

  it.each(blockedIndirectionCommands)("blocks %s", (command) => {
    const output = buildPreToolUseHookOutput({ tool_input: { command } });

    expect(requireBlockingReason(output)).toMatch(/(?:git reset --hard|unresolved shell indirection|opaque shell construct)/);
  });

  const allowedIndirectionCommands = [
    "g=git; $g status --short",
    "${GIT:-git} status --short",
    "command git status --short",
    "env GIT=git git status --short",
    "exec git status --short",
    "nice git status --short",
    "nohup git status --short",
    "time git status --short",
    "sh -c 'git \"$@\"' sh status --short",
  ] as const;

  it.each(allowedIndirectionCommands)("allows an unguarded %s", (command) => {
    expect(buildPreToolUseHookOutput({ tool_input: { command } })).toEqual({});
  });
});

describe("W2.7 deploy wrappers and previews", () => {
  const blockedDeployWrappers = [
    "pnpm run deploy",
    "pnpm deploy",
    "yarn deploy",
    "bun run deploy",
    "bunx wrangler deploy",
    "npm exec wrangler deploy",
    "npx wrangler versions deploy",
    "pnpm exec wrangler deploy",
    "pnpm dlx wrangler deploy",
    "npm --silent run deploy",
    "npm run --silent deploy",
    "npm -w worker run deploy",
    "yarn workspace worker deploy",
  ] as const;

  it.each(blockedDeployWrappers)("blocks %s", (command) => {
    const output = buildPreToolUseHookOutput({ tool_input: { command } });

    expect(requireBlockingReason(output)).toContain("Raw production deploy commands");
  });

  it.each([
    "pnpm run test",
    "yarn test",
    "bun run test",
    "npm exec eslint .",
    "pnpm -w worker run test",
    "npm -w worker run test",
    "yarn workspace worker test",
    "bun -C worker run test",
    "pnpm exec wrangler --help",
    "npm x wrangler --help",
  ] as const)(
    "allows a non-deploy package wrapper: %s",
    (command) => {
      expect(buildPreToolUseHookOutput({ tool_input: { command } })).toEqual({});
    },
  );

  const allowedPreviewCommands = [
    "git clean -fd --dry-run",
    "git clean -fd -n",
    "git clean -fdx --dry-run",
    "wrangler deploy --dry-run",
    "wrangler pages deploy --dry-run",
    "wrangler pages deploy --branch preview --dry-run",
    "wrangler deploy --help",
    "wrangler pages deploy -h",
  ] as const;

  it.each(allowedPreviewCommands)("allows the safe preview %s", (command) => {
    expect(buildPreToolUseHookOutput({ tool_input: { command } })).toEqual({});
  });

  it("keeps Pages branch deployment blocked without a dry-run", () => {
    const output = buildPreToolUseHookOutput({
      tool_input: { command: "wrangler pages deploy --branch preview" },
    });

    expect(requireBlockingReason(output)).toContain("Raw production deploy commands");
  });

  const blockedVersionQualifiedDeploys = [
    "npx wrangler@4 deploy",
    "npx --yes wrangler@latest pages deploy out",
    "npx wrangler@^4.0.0 versions deploy 00000000-0000-0000-0000-000000000000@100",
    "bunx wrangler@4.20.0 deploy",
    "pnpm dlx wrangler@4 deploy",
    "pnpm exec wrangler@4 deploy",
    "npm exec wrangler@4 deploy",
    "npm x wrangler@4 pages deploy out",
    "pnpm dlx cf-tools@npm:wrangler deploy",
  ] as const;

  it.each(blockedVersionQualifiedDeploys)("blocks the version-qualified deploy %s", (command) => {
    expect(requireBlockingReason(buildPreToolUseHookOutput({ tool_input: { command } }))).toContain(
      "Raw production deploy commands",
    );
  });

  const blockedVersionQualifiedRemoteD1 = [
    "npx wrangler@4 d1 execute stablecoin-db --remote --command 'delete from cache'",
    "bunx wrangler@4 d1 migrations apply stablecoin-db --remote",
    "pnpm dlx cf-tools@npm:wrangler d1 execute stablecoin-db --remote --command 'update prices set value = 1'",
  ] as const;

  it.each(blockedVersionQualifiedRemoteD1)("blocks the version-qualified remote D1 mutation %s", (command) => {
    expect(requireBlockingReason(buildPreToolUseHookOutput({ tool_input: { command } }))).toContain(
      "Remote D1 mutation commands",
    );
  });

  it.each([
    "npx wrangler@4 d1 execute stablecoin-db --remote --command 'select 1'",
    "npx wrangler@4 deploy --dry-run",
    "npx wrangler@4 deploy --help",
    "npx wrangler@4 --version",
  ] as const)("allows the safe version-qualified invocation %s", (command) => {
    expect(buildPreToolUseHookOutput({ tool_input: { command } })).toEqual({});
  });
});

describe("W2.7 remote D1 SQL policy", () => {
  const allowedReadOnlyCommands = [
    "npx wrangler d1 execute stablecoin-db --remote --command \"select 1\"",
    "npx wrangler d1 execute stablecoin-db --remote --command \"select 'update delete drop' from prices\"",
    `npx wrangler d1 execute stablecoin-db --remote --command "-- update
SELECT 1"`,
    `npx wrangler d1 execute stablecoin-db --remote --command "/* delete; drop */
SELECT 1"`,
    "npx wrangler d1 execute stablecoin-db --remote --command \"EXPLAIN UPDATE prices SET value = 1\"",
    "npx wrangler d1 execute stablecoin-db --remote --command \"PRAGMA table_info('prices')\"",
    "npx wrangler d1 execute stablecoin-db --remote --command \"WITH rows AS (SELECT 1) SELECT * FROM rows\"",
    "npx wrangler d1 execute stablecoin-db --remote --command \"SELECT 1; EXPLAIN QUERY PLAN SELECT 1\"",
  ] as const;

  it.each(allowedReadOnlyCommands)("allows read-only remote D1 SQL: %s", (command) => {
    expect(buildPreToolUseHookOutput({ tool_input: { command } })).toEqual({});
  });

  const blockedMutationCommands = [
    "INSERT INTO prices (value) VALUES (1)",
    "UPDATE prices SET value = 1",
    "DELETE FROM prices",
    "DROP TABLE prices",
    "ALTER TABLE prices ADD COLUMN note TEXT",
    "CREATE TABLE prices_copy (value INTEGER)",
    "TRUNCATE prices",
    "REPLACE INTO prices (id, value) VALUES (1, 1)",
    "PRAGMA foreign_keys = ON",
    "SELECT 1; DELETE FROM prices",
    "WITH rows AS (SELECT 1) DELETE FROM prices WHERE id IN (SELECT * FROM rows)",
    "WITH d AS (DELETE FROM t RETURNING *) SELECT count(*) FROM d",
    "-- comment mentioning SELECT\nUPDATE prices SET value = 1",
  ] as const;

  it.each(blockedMutationCommands)("blocks mutating remote D1 SQL: %s", (sql) => {
    const command = `npx wrangler d1 execute stablecoin-db --remote --command ${JSON.stringify(sql)}`;
    expect(requireBlockingReason(buildPreToolUseHookOutput({ tool_input: { command } }))).toContain(
      "Remote D1 mutation commands",
    );
  });

  it("parses an existing remote D1 SQL file statement by statement", () => {
    withSqlFixture("-- delete\nSELECT 'update';", (sqlPath) => {
      const command = `npx wrangler d1 execute stablecoin-db --remote --file ${JSON.stringify(sqlPath)}`;
      expect(buildPreToolUseHookOutput({ tool_input: { command } })).toEqual({});
    });

    withSqlFixture("SELECT 1; DROP TABLE prices;", (sqlPath) => {
      const command = `npx wrangler d1 execute stablecoin-db --remote --file ${JSON.stringify(sqlPath)}`;
      expect(requireBlockingReason(buildPreToolUseHookOutput({ tool_input: { command } }))).toContain(
        "Remote D1 mutation commands",
      );
    });
  });

  it("blocks a remote D1 SQL file that cannot be inspected locally", () => {
    const missingRoot = mkdtempSync(join(tmpdir(), "pharos-change-contract-missing-sql-"));
    const missingPath = join(missingRoot, "missing.sql");
    rmSync(missingRoot, { force: true, recursive: true });
    const command = `npx wrangler d1 execute stablecoin-db --remote --file ${JSON.stringify(missingPath)}`;

    expect(requireBlockingReason(buildPreToolUseHookOutput({ tool_input: { command } }))).toContain(
      "Remote D1 mutation commands",
    );
  });
});

describe("W2.7 protected command writes", () => {
  it.each([
    { cwd: "worker", tool_input: { command: "touch dist/missing.js" }, denied: true },
    { cwd: "worker", tool_input: { command: "touch dist/missing.js", workdir: "../agents" }, denied: false },
    { cwd: "agents", tool_input: { command: "touch dist/missing.js", workdir: "../worker" }, denied: true },
  ])("resolves write policy using session cwd and tool override: %j", ({ denied, ...input }) => {
    const output = buildPreToolUseHookOutput(input);
    if (denied) {
      expect(output).toMatchObject({ decision: "block", hookSpecificOutput: { permissionDecision: "deny" } });
      expect(requireBlockingReason(output)).toContain("build outputs");
    } else {
      expect(output).toEqual({});
    }
  });

  it("canonicalizes an innocuous symlink before checking a missing child write", () => {
    const root = mkdtempSync(join(process.cwd(), ".pharos-policy-"));
    try {
      // The alias reaches the repository root, whose missing build child is protected.
      symlinkSync(process.cwd(), join(root, "innocuous"), "dir");
      const input = { cwd: root, tool_input: { command: "touch innocuous/build/audit-missing/file.js" } };
      expect(buildPreToolUseHookOutput(input)).toMatchObject({
        decision: "block", hookSpecificOutput: { permissionDecision: "deny" },
      });
      expect(buildPreToolUseHookOutput({
        cwd: root, tool_input: { command: "touch innocuous/agents/audit-missing/file.js" },
      })).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  const blockedWrites = [
    ["rm", "rm -rf out/"],
    ["mv", "mv source .env.local"],
    ["cp destination", "cp source worker/dist/index.js"],
    ["touch", "touch worker/.dev.vars"],
    ["sed -i", "sed -i 's/x/y/' .git/config"],
    ["perl -i", "perl -i -pe 's/x/y/' .envrc"],
    ["truncate", "truncate -s 0 out/cache.bin"],
    [">|", "printf value >| .env.local"],
  ] as const;

  it.each(blockedWrites)("blocks protected %s writes", (_label, command) => {
    const output = buildPreToolUseHookOutput({ tool_input: { command } });

    expect(output).toMatchObject({
      decision: "block",
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(requireBlockingReason(output)).toMatch(/Direct writes to/);
  });

  const allowedWrites = [
    ["rm", "rm -rf agents/tmp"],
    ["mv", "mv source agents/tmp"],
    ["cp source", "cp .env.local agents/env-copy"],
    ["touch", "touch agents/marker"],
    ["sed -i", "sed -i 's/x/y/' agents/file.txt"],
    ["perl -i", "perl -i -pe 's/x/y/' agents/file.txt"],
    ["truncate", "truncate -s 0 agents/file.bin"],
    [">|", "printf value >| agents/file.txt"],
  ] as const;

  it.each(allowedWrites)("allows non-protected %s writes", (_label, command) => {
    expect(buildPreToolUseHookOutput({ tool_input: { command } })).toEqual({});
  });
});

describe("W2.7 Python and Node one-line writes", () => {
  const blockedInlineWrites = [
    "python -c 'open(\".env.local\", \"w\").write(\"x\")'",
    "python3 -c 'open(\"worker/dist/index.js\", \"wb\").write(b\"x\")'",
    "node -e 'fs.writeFileSync(\"out/index.html\", data)'",
    "node --eval 'writeFile(\"worker/.dev.vars\", data)'",
  ] as const;

  it.each(blockedInlineWrites)("blocks an inline write to a protected path: %s", (command) => {
    expect(requireBlockingReason(buildPreToolUseHookOutput({ tool_input: { command } }))).toMatch(
      /Direct writes to/,
    );
  });

  const allowedInlineCommands = [
    "python -c 'open(\".env.local\", \"r\").read()'",
    "python -c 'print(\".env.local\")'",
    "node -e 'console.log(\"out/index.html\")'",
    "node -e 'fs.writeFileSync(\"agents/index.html\", data)'",
  ] as const;

  it.each(allowedInlineCommands)("allows a non-writing or non-protected inline command: %s", (command) => {
    expect(buildPreToolUseHookOutput({ tool_input: { command } })).toEqual({});
  });
});

describe("W2.7 malformed hook payloads", () => {
  it.each(["pre-tool-use", "permission-request"])("keeps %s denials independent of malformed ownership JSON", (hook) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const originalRead = fs.readFileSync;
      fs.readFileSync = (path, ...args) => String(path).endsWith("/docs/doc-ownership.json") ? "{" : originalRead(path, ...args);
      syncBuiltinESMExports();
      // Exercise lazy loading after the malformed-registry read boundary is installed.
      const { runCli } = await import("./scripts/ci/pharos-change-contract.ts");
      runCli(["--hook=${hook}"]);
    `], { encoding: "utf8", input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git reset --hard HEAD" } }) });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    if (hook === "pre-tool-use") expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    else expect(output.hookSpecificOutput.decision.behavior).toBe("deny");
  });

  it.each([
    ["empty", ""],
    ["truncated", '{"tool_name": "Bash", "tool_inp'],
    ["non-object", '"text"'],
    ["array", "[]"],
  ])("denies a %s payload in both enforcement modes", (_label, payload) => {
    const preToolUse = runHookCliProcess("pre-tool-use", payload);
    expect(preToolUse.status).toBe(2);
    expect(JSON.parse(preToolUse.stdout)).toMatchObject({
      decision: "block",
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });
    expect(preToolUse.stderr).toContain("[rule:malformed-hook-input]");

    const permissionRequest = runHookCliProcess("permission-request", payload);
    expect(permissionRequest.status).toBe(2);
    expect(JSON.parse(permissionRequest.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny" },
      },
    });
  });

});

describe("hook diagnostics", () => {
  it.each(["symlink", "hardlink", "fifo"])("does not write or block on a diagnostic %s", (kind) => {
    const directory = mkdtempSync(join(tmpdir(), "pharos-hook-diagnostics-link-"));
    const target = join(directory, "target");
    const diagnosticsPath = join(directory, "diagnostics");
    writeFileSync(target, "unchanged");
    try {
      if (kind === "symlink") symlinkSync(target, diagnosticsPath);
      else if (kind === "hardlink") linkSync(target, diagnosticsPath);
      else execFileSync("mkfifo", [diagnosticsPath]);
      const result = runHookCliProcess("pre-tool-use", "{}", {
        ...process.env, PHAROS_HOOK_DIAGNOSTICS: "1", PHAROS_HOOK_DIAGNOSTICS_FILE: diagnosticsPath,
      });
      expect(result.status).toBe(0);
      expect(readFileSync(target, "utf8")).toBe("unchanged");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("writes one secret-free record per hook invocation", () => {
    const directory = mkdtempSync(join(tmpdir(), "pharos-hook-diagnostics-on-"));
    const diagnosticsPath = join(directory, "hook-diagnostics.jsonl");
    const env = {
      ...process.env,
      PHAROS_HOOK_DIAGNOSTICS: "1",
      PHAROS_HOOK_DIAGNOSTICS_FILE: diagnosticsPath,
    };
    const secrets = ["SECRET_ARGUMENT_91", "SECRET_CONTENT_52", "SECRET_SESSION_73"];
    const command = `git reset --hard HEAD ${secrets[0]}`;

    try {
      const results = [
        runHookCliProcess(
          "pre-tool-use",
          JSON.stringify({
            hook_event_name: "PreToolUse",
            session_id: secrets[2],
            tool_name: "Bash",
            tool_input: { command },
          }),
          env,
        ),
        runHookCliProcess(
          "permission-request",
          JSON.stringify({
            session_id: secrets[2],
            cwd: process.cwd(),
            model: "codex",
            hookEventName: "PermissionRequest",
            toolName: "Bash",
            toolInput: { command },
          }),
          env,
        ),
        runHookCliProcess("pre-tool-use", JSON.stringify({
          hook_event_name: "PreToolUse", tool_name: "Write",
          tool_input: { file_path: ".env.local", content: secrets[1] },
          session_id: secrets[2],
        }), env),
        // Exercise diagnostics independently of mutable/unmapped working-tree paths.
        runHookCliProcess("session-start", JSON.stringify({ hook_event_name: "SessionStart", session_id: secrets[2] }),
          env, ["--base", "HEAD", "--head", "HEAD"]),
      ];
      const contents = readFileSync(diagnosticsPath, "utf8");
      const records = contents
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      expect(results.every((result) => result.status === 0)).toBe(true);
      expect(records).toHaveLength(4);
      expect(records[0]).toMatchObject({
        harness: "claude",
        event: "PreToolUse",
        tool: "Bash",
        decision: "deny",
        rule: "git-destructive",
        pathsProtected: 0,
      });
      expect(records[1]).toMatchObject({
        harness: "codex",
        event: "PermissionRequest",
        tool: "Bash",
        decision: "deny",
        rule: "git-destructive",
      });
      expect(records[2]).toMatchObject({
        event: "PreToolUse", tool: "Write", decision: "deny", rule: "protected-write",
      });
      expect(records[3]).toMatchObject({
        harness: "unknown",
        event: "SessionStart",
        tool: null,
        decision: "none",
        rule: null,
      });
      expect(records[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(records[0].commandDigest).toMatch(/^[0-9a-f]{12}$/);
      expect(contents).not.toContain(command);
      for (const secret of secrets) expect(contents).not.toContain(secret);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("keeps the hook decision and exit status when diagnostics cannot be written", () => {
    const directory = mkdtempSync(join(tmpdir(), "pharos-hook-diagnostics-failure-"));

    try {
      const result = runHookCliProcess(
        "pre-tool-use",
        JSON.stringify({ tool_name: "Bash", tool_input: { command: "git reset --hard HEAD" } }),
        {
          ...process.env,
          PHAROS_HOOK_DIAGNOSTICS: "1",
          PHAROS_HOOK_DIAGNOSTICS_FILE: directory,
        },
      );

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        decision: "block",
        hookSpecificOutput: { permissionDecision: "deny" },
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

});

describe("W2.7 PermissionRequest parity", () => {
  it.each([
    ["git reset", "git reset --hard HEAD"],
    ["git clean", "git clean -fd"],
    ["protected command write", "rm .env.local"],
  ] as const)("denies %s through the full PreToolUse policy", (_label, command) => {
    const output = buildPermissionRequestHookOutput({ tool_input: { command } });

    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny" },
      },
    });
  });

  it("denies unsafe migration SQL through PermissionRequest", () => {
    const output = buildPermissionRequestHookOutput({
      tool_input: {
        file_path: "worker/migrations/9999_permission.sql",
        content: "DROP TABLE stablecoin_snapshots;",
      },
    });

    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny" },
      },
    });
  });

  it("denies opaque guarded commands through PermissionRequest", () => {
    const output = buildPermissionRequestHookOutput({
      tool_input: { command: "echo $(git reset --hard HEAD)" },
    });

    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: expect.stringContaining("opaque shell construct around a guarded command; run it directly"),
        },
      },
    });
  });

  it("keeps safe previews and read-only D1 requests allowed", () => {
    expect(
      buildPermissionRequestHookOutput({
        tool_input: { command: "git clean -fd --dry-run" },
      }),
    ).toEqual({});
    expect(
      buildPermissionRequestHookOutput({
        tool_input: { command: "npx wrangler d1 execute stablecoin-db --remote --command 'select 1'" },
      }),
    ).toEqual({});
  });
});

describe("repo Claude hook config", () => {
  it("wires only SessionStart and the PreToolUse guards", () => {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), ".claude/settings.json"), "utf8"));

    expect(config.hooks.SessionStart[0].matcher).toBe("startup|resume|clear|compact|fork");
    expect(config.hooks.SessionStart[0].hooks[0].command).toContain("--hook=session-start");
    expect(config.hooks.PreToolUse[0].hooks[0].command).toContain("--hook=pre-tool-use");
    expect(config.hooks.PreToolUse[0].hooks).toHaveLength(1);
    expect(config.hooks.PreToolUse).toHaveLength(1);
    expect(config.hooks.PreToolUse[0].matcher).toBe("Bash|Edit|MultiEdit|Write");

    expect(config.hooks.UserPromptSubmit).toBeUndefined();
    expect(config.hooks.PostToolUse).toBeUndefined();
    expect(config.hooks.PostToolBatch).toBeUndefined();
  });
});
