import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";

function hostedTimeoutMinutes(job: string): number {
  const workflow = parseDocument(readFileSync(new URL("../../.github/workflows/pull-request-checks.yml", import.meta.url), "utf8"));
  if (workflow.errors.length) throw workflow.errors[0];
  const value = workflow.getIn(["jobs", job, "timeout-minutes"]);
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Missing or invalid hosted timeout for ${job}`);
  }
  return value;
}

export type PrLaneSelector = "always" | "code" | "pages-artifact" | "v9-resource";

export type PrLaneId =
  | "preflight"
  | "static-compile"
  | "static-guards"
  | "tests"
  | "v9-resource"
  | "pages-artifact"
  | "gate";

export interface PrLaneDefinition {
  /**
   * Reporting threshold in seconds for the weekly lane-budget report. Never a
   * timeout: the job keeps its `timeoutMinutes` ceiling, so an over-budget lane
   * still finishes and the weekly report names it instead of killing it.
   * Only moves down without an owner-approved record.
   */
  budgetSeconds?: number;
  commands: readonly PrLaneCommandDefinition[];
  id: PrLaneId;
  selector: PrLaneSelector;
  /** Maximum fan-out; the tests lane takes its count from the prepared test plan. */
  shards?: number;
  timeoutMinutes: number;
}

/**
 * `prepare` is the PR workflow's first job rather than a manifest lane, so its
 * report-only budget lives outside `PR_LANES` (the matrix generator iterates it).
 */
export const PR_PREPARE_BUDGET_SECONDS = 90;

export interface PrLaneCommandDefinition {
  args: readonly string[];
  id: string;
  program: "node" | "npm";
}

export interface PrLaneSelection {
  docsOnly: boolean;
  pagesArtifactRequired?: boolean;
  testShards?: number;
  /** Missing classification selects the resource lane conservatively. */
  v9ResourceRequired?: boolean;
}

export interface PrLaneCommandContext {
  base?: string;
  forwardedTestArgs?: readonly string[];
  head?: string;
  shard?: number;
  shardCount?: number;
}

/** Local read-only prepare feedback; hosted prepare keeps its workflow wiring. */
export const PR_PREPARE_COMMANDS = [
  { id: "test-corpus-budget", program: "npm", args: ["run", "check:test-corpus-budget", "--"] },
  { id: "incident-review-keys", program: "npm", args: ["run", "check:incident-review-keys"] },
  { id: "new-asset-evidence-packet", program: "npm", args: ["run", "check:new-asset-evidence-packet", "--"] },
  { id: "safety-score-v9-evaluation-build", program: "npm", args: ["run", "check:generated-artifacts", "--", "--only=safety-score-v9-evaluation-build"] },
] as const satisfies readonly PrLaneCommandDefinition[];

/** Shared by docs-only inline validation and mixed-PR static guards. */
export const PR_DOC_COMMANDS: readonly PrLaneCommandDefinition[] = [
  { id: "verified-doc-links", program: "npm", args: ["run", "check:verified-doc-links"] },
  { id: "doc-sync", program: "npm", args: ["run", "check:doc-sync"] },
  { id: "doc-ownership-invariants", program: "npm", args: ["exec", "--", "vitest", "run", "scripts/__tests__/doc-ownership-registry.test.ts", "scripts/__tests__/pharos-change-contract.test.ts"] },
];

/**
 * Lane budgets are the owner's measured PR targets (test shard 200 s, Pages
 * 250 s, V9 220 s, guards 120 s, compile 150 s), not timeouts. `preflight` and
 * `gate` are seconds-long bookkeeping jobs and carry none.
 */
export const PR_LANES: readonly PrLaneDefinition[] = [
  {
    id: "preflight",
    selector: "always",
    timeoutMinutes: hostedTimeoutMinutes("secrets"),
    commands: [
      { id: "classifier-smoke", program: "node", args: ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/ci/classify-deploy-changes.ts"] },
      { id: "gitleaks", program: "node", args: ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/ci/run-gitleaks.ts", "--range"] },
    ],
  },
  // buildPrWorkflowMatrix emits lanes in declaration order and the workflow
  // caps validation concurrency. Keep v9-resource ahead of the test shards and
  // static-compile last, so a queued job is the shortest lane rather than the
  // slow resource lane.
  {
    id: "v9-resource",
    selector: "v9-resource",
    budgetSeconds: 220,
    // Faithful setup/live/natural/correctness smoke with one PR publication cycle;
    // contagion (90s wall policy) runs only when the PR diff reaches a contagion input.
    // Eight minutes allows CI setup, bundling and scheduling headroom without a 35-minute hang.
    timeoutMinutes: 8,
    commands: [{ id: "v9-resource", program: "npm", args: ["run", "test:v9-resource"] }],
  },
  {
    id: "static-guards",
    selector: "code",
    budgetSeconds: 120,
    timeoutMinutes: 20,
    commands: [{ id: "pr-static-guards", program: "npm", args: ["run", "check:pr:static", "--", "--group=guards"] }],
  },
  {
    id: "tests",
    selector: "code",
    budgetSeconds: 200,
    shards: 10,
    timeoutMinutes: 15,
    commands: [{ id: "pr-tests", program: "npm", args: ["run", "test:pr", "--"] }],
  },
  {
    id: "static-compile",
    selector: "code",
    budgetSeconds: 150,
    timeoutMinutes: 20,
    commands: [{ id: "pr-static-compile", program: "npm", args: ["run", "check:pr:static", "--", "--group=compile"] }],
  },
  {
    id: "pages-artifact",
    selector: "pages-artifact",
    budgetSeconds: 250,
    timeoutMinutes: hostedTimeoutMinutes("pages-artifact"),
    commands: [{ id: "pages-artifact", program: "npm", args: ["run", "check:pages-artifact"] }],
  },
  { id: "gate", selector: "always", timeoutMinutes: hostedTimeoutMinutes("pr-gate"), commands: [] },
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
    case "pages-artifact": return selection.pagesArtifactRequired === true;
    case "v9-resource": return selection.v9ResourceRequired !== false;
  }
}

export function buildPrLaneCommandArgs(
  command: PrLaneCommandDefinition,
  context: PrLaneCommandContext = {},
): string[] {
  const args = [...command.args];
  const sharded = command.id === "pr-tests" && (context.shard !== undefined || context.shardCount !== undefined);
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
    case "pr-static":
    case "pr-static-compile":
    case "pr-static-guards":
    case "test-corpus-budget":
    case "new-asset-evidence-packet":
      if (context.base) args.push(`--base=${context.base}`);
      if (context.head) args.push(`--head=${context.head}`);
      break;
  }
  return args;
}
