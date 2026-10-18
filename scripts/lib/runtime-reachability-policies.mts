export type EntrypointSelector =
  | { kind: "paths"; paths: readonly string[] }
  | { kind: "scheduled-loaders"; source: string; loaderSources: readonly string[] }
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
  id: "scheduled" | "mint-burn" | "memory-constrained-cron" | "pages-functions" | "client-registry" | "public-safety-projections";
  entrypoints: EntrypointSelector;
  forbidden: ForbiddenSelector;
  directImports?: DirectImportPolicy;
  /** Check initialization through static edges, excluding deferred invocation imports. */
  staticImportsOnly?: boolean;
  failureHeading: string;
  remediation: string;
  successLabel: string;
}

export const RUNTIME_REACHABILITY_POLICIES = [
  {
    id: "public-safety-projections",
    // Public HTTP initialization, not deferred scheduled/admin invocation graphs.
    entrypoints: { kind: "paths", paths: [
      "worker/src/index.ts",
      "worker/src/handlers/http/request-dispatch.ts",
      "worker/src/lib/report-cards-v9-cache.ts",
      "worker/src/lib/public-health-assessment.ts",
      "worker/src/lib/safety-score-v9/publication-store.ts",
      "worker/src/lib/safety-score-index.ts",
    ] },
    staticImportsOnly: true,
    forbidden: { kind: "paths", paths: [
      "worker/src/lib/safety-score-v9/accepted-projections.ts",
      "worker/src/lib/safety-score-v9/accepted-projection-readers.ts",
    ] },
    failureHeading: "Public Worker accepted-projection boundary failed",
    remediation: "Keep accepted-projection builders/readers out of public static initialization; inject builders from the heavy publication runner and retain deferred scheduled/admin imports.",
    successLabel: "Public Worker accepted-projection boundary",
  },
  {
    id: "scheduled",
    entrypoints: { kind: "scheduled-loaders", source: "worker/src/handlers/scheduled.ts", loaderSources: [
      "worker/src/handlers/scheduled/public-runners.ts",
      "worker/src/handlers/scheduled/heavy-runners.ts",
    ] },
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
        // ADR-24: alert lanes must use the thin envelope, not full V9 snapshot decoding.
        "worker/src/lib/safety-score-active-source.ts",
        "worker/src/lib/report-cards-v9-cache.ts",
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
      "Use the lightweight Worker runtime registry and thin alert safety envelope; ADR-24 excludes the full stablecoin registry and full V9 snapshot decoding from these lanes' isolate memory budget.",
    successLabel: "Worker runtime import boundary",
  },
  {
    id: "memory-constrained-cron",
    entrypoints: {
      kind: "paths",
      paths: [
        "worker/src/handlers/scheduled/hourly-blacklist.ts",
        "worker/src/handlers/scheduled/thirty-minute-dex-discovery.ts",
        "worker/src/handlers/scheduled/daily-0300.ts",
        "worker/src/handlers/scheduled/depeg-resolver.ts",
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
    failureHeading: "Memory-constrained cron runtime boundary failed",
    remediation:
      "Use the lightweight Worker runtime registry and mode-scoped imports; the full stablecoin registry exceeds these lanes' isolate memory budget.",
    successLabel: "Memory-constrained cron runtime boundary",
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
          importers: ["shared/lib/stablecoins/client-detail.ts"],
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
