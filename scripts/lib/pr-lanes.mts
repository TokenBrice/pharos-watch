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

/** Shared by docs-only inline validation and mixed-PR static guards. */
export const PR_DOC_COMMANDS: readonly PrLaneCommandDefinition[] = [
  { id: "verified-doc-links", program: "npm", args: ["run", "check:verified-doc-links"] },
  { id: "doc-sync", program: "npm", args: ["run", "check:doc-sync"] },
  { id: "doc-ownership-invariants", program: "npm", args: ["exec", "--", "vitest", "run", "scripts/__tests__/doc-ownership-registry.test.ts", "scripts/__tests__/pharos-change-contract.test.ts"] },
];

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
    id: "v9-resource",
    selector: "v9-resource",
    // Faithful setup/live/natural/correctness smoke: 101s; contagion wall policy: 90s.
    // Eight minutes allows CI setup, bundling and scheduling headroom without a 35-minute hang.
    timeoutMinutes: 8,
    commands: [{ id: "v9-resource", program: "npm", args: ["run", "test:v9-resource"] }],
  },
  {
    id: "pages-artifact",
    selector: "pages-artifact",
    timeoutMinutes: 20,
    commands: [{ id: "pages-artifact", program: "npm", args: ["run", "check:pages-artifact"] }],
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
      if (context.base) args.push(`--base=${context.base}`);
      if (context.head) args.push(`--head=${context.head}`);
      break;
  }
  return args;
}
