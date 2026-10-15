export type EntrypointSelector =
  | { kind: "paths"; paths: readonly string[] }
  | { kind: "scheduled-loaders"; source: string }
  | { kind: "scheduled-owner-loaders"; source: string; role: "heavy"; additionalPaths: readonly string[] }
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
  id: "scheduled" | "mint-burn" | "memory-constrained-cron" | "pages-functions" | "client-registry" | "public-safety-projections" | "safety-score-v9-publication";
  entrypoints: EntrypointSelector;
  forbidden: ForbiddenSelector;
  directImports?: DirectImportPolicy;
  requiredReachable?: readonly string[];
  wranglerConfig?: string;
  failureHeading: string;
  remediation: string;
  successLabel: string;
}

export const RUNTIME_REACHABILITY_POLICIES = [
  {
    id: "safety-score-v9-publication",
    // Invocation closure, not the whole physical generic-dispatcher bundle.
    // Non-owner lazy edges are excluded only after proving role-before-loader.
    entrypoints: {
      kind: "scheduled-owner-loaders",
      source: "worker/src/handlers/scheduled.ts",
      role: "heavy",
      additionalPaths: [
        "worker/src/handlers/scheduled/context.ts",
        "worker/src/workflows/safety-score-v9-publication.entry.ts",
        "worker/src/cron/compute-safety-score-v9.ts",
        "worker/src/lib/safety-score-v9/candidate.ts",
      ],
    },
    wranglerConfig: "worker/wrangler.heavy.toml",
    forbidden: {
      kind: "paths",
      paths: [
        "shared/lib/stablecoins/registry.ts",
        "shared/lib/stablecoins/full-catalog.ts",
        "worker/src/lib/full-stablecoin-catalog.ts",
        "shared/data/stablecoins/coins.generated.json",
        "shared/data/stablecoins/coins.worker-full.generated.json",
        "shared/data/safety-score-v9/incident-reviews-v1.json",
        "shared/lib/safety-score-v9/contagion.ts",
      ],
    },
    requiredReachable: [
      "shared/data/safety-score-v9/shock-coverage-measurements-v1.json",
      "shared/data/safety-score-v9/incident-runtime-v1.generated.json",
    ],
    failureHeading: "Safety Score V9 publication invocation boundary failed",
    remediation: "Use scoring-only metadata for scoring and the Worker runtime projection for prep/DEX; preserve heavy role rejection before invoking any slot loader. This guard proves the owner-derived invocation closure, not absence of non-owner lazy code from the physical bundle.",
    successLabel: "Safety Score V9 publication invocation boundary",
  },
  {
    id: "public-safety-projections",
    // Public storage roots exclude the generic scheduler's lazy heavy-only imports.
    entrypoints: { kind: "paths", paths: [
      "worker/src/lib/safety-score-v9/publication-store.ts",
      "worker/src/lib/safety-score-index.ts",
    ] },
    forbidden: { kind: "paths", paths: ["worker/src/lib/safety-score-v9/accepted-projections.ts"] },
    failureHeading: "Public Worker accepted-projection boundary failed",
    remediation: "Inject accepted-projection builders from the heavy publication runner; public storage readers must not import them.",
    successLabel: "Public Worker accepted-projection boundary",
  },
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
