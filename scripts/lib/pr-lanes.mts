export type PrLaneSelector = "always" | "code" | "critical-coverage" | "docs" | "pages-artifact";

export type PrLaneId =
  | "preflight"
  | "static-compile"
  | "static-guards"
  | "tests"
  | "critical-coverage-shards"
  | "critical-coverage"
  | "pages-artifact"
  | "docs"
  | "gate";

export interface PrLaneDefinition {
  commands: readonly PrLaneCommandDefinition[];
  id: PrLaneId;
  selector: PrLaneSelector;
  /** Maximum fan-out; the tests lane takes its count from the prepared test plan. */
  shards?: number;
  timeoutMinutes: number;
}

export interface PrLaneCommandDefinition {
  args: readonly string[];
  id: string;
  program: "node" | "npm";
}

export interface PrLaneSelection {
  criticalCoverageChanged: boolean;
  criticalCoverageShards: number;
  docsChanged: boolean;
  docsOnly: boolean;
  pagesArtifactRequired?: boolean;
  testShards?: number;
}

export interface PrLaneCommandContext {
  base?: string;
  forwardedTestArgs?: readonly string[];
  head?: string;
  shard?: number;
  shardCount?: number;
  /**
   * When docs owns doc-sync in the same composed plan, guards (or the local
   * ungrouped static command) skips its duplicate. Compile never runs doc-sync.
   */
  skipDocSync?: boolean;
}

export const PR_LANES: readonly PrLaneDefinition[] = [
  {
    id: "preflight",
    selector: "always",
    timeoutMinutes: 15,
    commands: [
      { id: "classifier-smoke", program: "node", args: ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/ci/classify-deploy-changes.ts"] },
      { id: "gitleaks", program: "node", args: ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/ci/run-gitleaks.ts", "--range"] },
    ],
  },
  {
    id: "static-compile",
    selector: "code",
    timeoutMinutes: 20,
    commands: [{ id: "pr-static-compile", program: "npm", args: ["run", "check:pr:static", "--", "--group=compile"] }],
  },
  {
    id: "static-guards",
    selector: "code",
    timeoutMinutes: 20,
    commands: [{ id: "pr-static-guards", program: "npm", args: ["run", "check:pr:static", "--", "--group=guards"] }],
  },
  {
    id: "tests",
    selector: "code",
    shards: 8,
    timeoutMinutes: 15,
    commands: [{ id: "pr-tests", program: "npm", args: ["run", "test:pr", "--"] }],
  },
  {
    id: "critical-coverage-shards",
    selector: "critical-coverage",
    shards: 8,
    timeoutMinutes: 15,
    commands: [{ id: "critical-coverage-shard", program: "npm", args: ["run", "coverage:critical:shard", "--"] }],
  },
  {
    id: "critical-coverage",
    selector: "critical-coverage",
    timeoutMinutes: 15,
    commands: [
      { id: "critical-coverage", program: "npm", args: ["run", "coverage:critical"] },
      { id: "critical-coverage-merge", program: "npm", args: ["run", "coverage:critical:merge"] },
    ],
  },
  {
    id: "pages-artifact",
    selector: "pages-artifact",
    timeoutMinutes: 20,
    commands: [{ id: "pages-artifact", program: "npm", args: ["run", "check:pages-artifact"] }],
  },
  {
    id: "docs",
    selector: "docs",
    timeoutMinutes: 15,
    commands: [
      { id: "verified-doc-links", program: "npm", args: ["run", "check:verified-doc-links"] },
      { id: "doc-source-paths", program: "npm", args: ["run", "check:doc-source-paths"] },
      { id: "doc-sync", program: "npm", args: ["run", "check:doc-sync"] },
      { id: "doc-ownership-invariants", program: "npm", args: ["exec", "--", "vitest", "run", "scripts/__tests__/doc-ownership-registry.test.ts"] },
      { id: "agents-doc-artifact", program: "npm", args: ["run", "check:generated-artifacts", "--", "--only=agents-doc"] },
      { id: "docs-generated-artifacts", program: "node", args: ["--import", "tsx", "scripts/ci/check-docs-generated-artifacts.mts"] },
    ],
  },
  { id: "gate", selector: "always", timeoutMinutes: 5, commands: [] },
] as const;

export function getPrLane(id: PrLaneId): PrLaneDefinition {
  const lane = PR_LANES.find((candidate) => candidate.id === id);
  if (!lane) throw new Error(`Unknown PR lane: ${id}`);
  return lane;
}

export function isPrLaneSelected(lane: PrLaneDefinition, selection: PrLaneSelection): boolean {
  switch (lane.selector) {
    case "always": return true;
    case "code": return !selection.docsOnly;
    case "critical-coverage": return selection.criticalCoverageChanged;
    case "docs": return selection.docsChanged;
    case "pages-artifact": return selection.pagesArtifactRequired === true;
  }
}

export function buildPrLaneCommandArgs(
  command: PrLaneCommandDefinition,
  context: PrLaneCommandContext = {},
): string[] {
  const args = [...command.args];
  const sharded = command.id === "critical-coverage-shard"
    || (command.id === "pr-tests" && (context.shard !== undefined || context.shardCount !== undefined));
  if (sharded && (
    !Number.isInteger(context.shard) || !Number.isInteger(context.shardCount)
    || context.shard! < 1 || context.shardCount! < 1 || context.shard! > context.shardCount!
  )) throw new Error("Invalid shard coordinates: require 1 <= shard <= shardCount");
  switch (command.id) {
    case "pr-tests":
      if (context.base) args.push(`--base=${context.base}`);
      if (sharded) args.push(`--shard=${context.shard}/${context.shardCount}`);
      args.push(...(context.forwardedTestArgs ?? []));
      break;
    case "critical-coverage-shard":
      args.push(`--shard=${context.shard}/${context.shardCount}`);
      break;
    case "pr-static":
    case "pr-static-compile":
    case "pr-static-guards":
      if (context.base) args.push(`--base=${context.base}`);
      if (context.head) args.push(`--head=${context.head}`);
      if (context.skipDocSync && command.id !== "pr-static-compile") args.push("--skip-doc-sync");
      break;
  }
  return args;
}
