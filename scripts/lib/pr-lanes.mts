export type PrLaneSelector = "always" | "code" | "critical-coverage" | "docs";

export type PrLaneId =
  | "preflight"
  | "static"
  | "tests"
  | "critical-coverage-shards"
  | "critical-coverage"
  | "docs"
  | "gate";

export interface PrLaneDefinition {
  commands: readonly PrLaneCommandDefinition[];
  id: PrLaneId;
  selector: PrLaneSelector;
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
  docsChanged: boolean;
  docsOnly: boolean;
}

export interface PrLaneCommandContext {
  base?: string;
  forwardedTestArgs?: readonly string[];
  head?: string;
  shard?: number;
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
    id: "static",
    selector: "code",
    timeoutMinutes: 20,
    commands: [{ id: "pr-static", program: "npm", args: ["run", "check:pr:static", "--"] }],
  },
  {
    id: "tests",
    selector: "code",
    shards: 4,
    timeoutMinutes: 15,
    commands: [{ id: "pr-tests", program: "npm", args: ["run", "test:pr", "--"] }],
  },
  {
    id: "critical-coverage-shards",
    selector: "critical-coverage",
    shards: 4,
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
    id: "docs",
    selector: "docs",
    timeoutMinutes: 15,
    commands: [
      { id: "verified-doc-links", program: "npm", args: ["run", "check:verified-doc-links"] },
      { id: "doc-source-paths", program: "npm", args: ["run", "check:doc-source-paths"] },
      { id: "doc-sync", program: "npm", args: ["run", "check:doc-sync"] },
      { id: "agents-doc-artifact", program: "npm", args: ["run", "check:generated-artifacts", "--", "--only=agents-doc"] },
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
  }
}

export function buildPrLaneCommandArgs(
  command: PrLaneCommandDefinition,
  context: PrLaneCommandContext = {},
): string[] {
  const args = [...command.args];
  switch (command.id) {
    case "pr-tests":
      if (context.base) args.push(`--base=${context.base}`);
      if (context.shard) args.push(`--shard=${context.shard}/4`);
      args.push(...(context.forwardedTestArgs ?? []));
      break;
    case "critical-coverage-shard":
      if (!context.shard) throw new Error("Critical coverage shards require a shard number");
      args.push(`--shard=${context.shard}/4`);
      break;
    case "pr-static":
      if (context.base) args.push(`--base=${context.base}`);
      if (context.head) args.push(`--head=${context.head}`);
      break;
  }
  return args;
}
