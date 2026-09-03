export type EntrypointSelector =
  | { kind: "paths"; paths: readonly string[] }
  | { kind: "scheduled-loaders"; source: string }
  | { kind: "source-files"; root: string }
  | { kind: "use-client"; root: string };

export type ForbiddenSelector =
  | {
      kind: "paths";
      paths: readonly string[];
      prefixes?: readonly string[];
      allowedImporters?: readonly { prefix: string; importers: readonly string[] }[];
    }
  | { kind: "prefixes"; prefixes: readonly string[] }
  | { kind: "react-dom-shared"; root: string };

export interface DirectImportPolicy {
  entrypoints: readonly string[];
  forbiddenSpecifiers: readonly string[];
}

export interface RuntimeReachabilityPolicy {
  id: "scheduled" | "mint-burn" | "pages-functions" | "client-registry";
  entrypoints: EntrypointSelector;
  forbidden: ForbiddenSelector;
  directImports?: DirectImportPolicy;
  failureHeading: string;
  remediation: string;
  successLabel: string;
}

export const RUNTIME_REACHABILITY_POLICIES = [
  {
    id: "scheduled",
    entrypoints: { kind: "scheduled-loaders", source: "worker/src/handlers/scheduled.ts" },
    forbidden: { kind: "react-dom-shared", root: "shared/lib" },
    failureHeading: "Scheduled Worker runtime reachability failed",
    remediation: "Move browser-only code out of the shared runtime graph used by scheduled handlers.",
    successLabel: "Scheduled Worker runtime reachability",
  },
  {
    id: "mint-burn",
    entrypoints: {
      kind: "paths",
      paths: [
        "worker/src/handlers/scheduled/twenty-minute-mint-burn-extended.ts",
        "worker/src/handlers/scheduled/five-minute-telegram.ts",
      ],
    },
    forbidden: {
      kind: "paths",
      paths: [
        "shared/data/stablecoins/coins.generated.json",
        "shared/lib/stablecoins/registry.ts",
        "shared/lib/tracked-stablecoin-utils.ts",
      ],
    },
    directImports: {
      entrypoints: [
        "worker/src/cron/prune-detail-cache.ts",
        "worker/src/cron/snapshot-supply.ts",
      ],
      forbiddenSpecifiers: ["@shared/lib/psi-eligible", "@shared/lib/stablecoins/registry"],
    },
    failureHeading: "Worker runtime import boundary failed",
    remediation:
      "Use the lightweight Worker runtime registry; the full stablecoin registry exceeds the lane's isolate memory budget.",
    successLabel: "Worker runtime import boundary",
  },
  {
    id: "pages-functions",
    entrypoints: { kind: "source-files", root: "functions" },
    forbidden: { kind: "prefixes", prefixes: ["worker/src/"] },
    failureHeading: "Pages Functions runtime reachability failed",
    remediation: "Keep Pages Functions independent from the Worker implementation boundary.",
    successLabel: "Pages Functions runtime reachability",
  },
  {
    id: "client-registry",
    entrypoints: { kind: "use-client", root: "src" },
    forbidden: {
      kind: "paths",
      paths: [
        "shared/lib/stablecoins/index.ts",
        "shared/lib/stablecoins/registry.ts",
        "shared/data/stablecoins/coins.generated.json",
        "shared/data/stablecoins/coins.client.generated.json",
      ],
      prefixes: ["shared/data/stablecoins/coins.client.detail/"],
      allowedImporters: [
        {
          prefix: "shared/data/stablecoins/coins.client.detail/",
          importers: ["shared/lib/stablecoins/client-registry.ts"],
        },
      ],
    },
    failureHeading: "Client stablecoin registry reachability failed",
    remediation: "Use the compact client registry and load detail projections through loadClientStablecoinDetail(id).",
    successLabel: "Client stablecoin registry reachability",
  },
] as const satisfies readonly RuntimeReachabilityPolicy[];

export function getRuntimeReachabilityPolicy(id: string): RuntimeReachabilityPolicy | undefined {
  return RUNTIME_REACHABILITY_POLICIES.find((policy) => policy.id === id);
}
