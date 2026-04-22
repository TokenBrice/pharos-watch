export type EnvRuntimeName = "worker" | "pagesOps" | "pagesSiteData" | "frontend";
export type EnvRuntimeStatus = "required" | "optional" | "reserved";
export type EnvBindingValueType = "string" | "D1Database";

export type EnvExampleSection =
  | "frontend"
  | "workerRequired"
  | "workerOptional"
  | "workerReserved"
  | "sharedSiteApiSecret"
  | "pagesOpsRequired"
  | "pagesOptional";

interface EnvRuntimeUsage {
  order: number;
  status: EnvRuntimeStatus;
}

interface EnvExampleEntry {
  section: EnvExampleSection;
  value: string;
}

interface EnvDocEntry {
  includeInOperatorOriginAccess?: boolean;
}

export interface EnvBindingDefinition {
  key: string;
  valueType: EnvBindingValueType;
  description: string;
  docs?: EnvDocEntry;
  example?: EnvExampleEntry;
  runtimes: Partial<Record<EnvRuntimeName, EnvRuntimeUsage>>;
}

const ENV_EXAMPLE_SECTION_ORDER: readonly {
  comments: readonly string[];
  key: EnvExampleSection;
}[] = [
  {
    key: "frontend",
    comments: [
      "# Generated from `shared/lib/env-contract.ts`; run `npm run check:env-contract` after manifest edits.",
      "# Secrets typically use `wrangler secret put`; plain worker vars usually live in",
      "# `worker/wrangler.toml [vars]` or are configured directly in Cloudflare.",
      "# `DB` is configured separately in `worker/wrangler.toml` under `[d1_databases]`",
      "# and as a Pages D1 binding on the site-data proxy project.",
      "",
      "# Frontend optional build/runtime bindings",
      "# `NEXT_PUBLIC_API_BASE` is mainly for local `next dev` or non-Pharos hosts.",
      "# When unset on Pharos/Pages browser hosts, public reads go through same-origin",
      "# `/_site-data/*`; direct `https://api.pharos.watch` is reserved for explicit",
      "# public API callsites and non-Pharos hosts.",
      "# `NEXT_PUBLIC_GA_ID` is optional; when unset, no analytics script or",
      "# custom-event telemetry is injected by `src/app/layout.tsx`.",
    ],
  },
  {
    key: "workerRequired",
    comments: ["# Worker required active bindings"],
  },
  {
    key: "workerOptional",
    comments: [
      "# Worker optional active bindings",
    ],
  },
  {
    key: "workerReserved",
    comments: [
      "# Worker reserved-only keys.",
      "# The worker keeps these names reserved for cross-runtime alignment, but it does",
      "# not currently consume them at runtime.",
    ],
  },
  {
    key: "sharedSiteApiSecret",
    comments: [
      "# Pages Functions + local dev proxy shared secret",
      "# Required for `npm run dev` to fetch authenticated API data locally.",
      "# Copy from the Pages Functions environment in the Cloudflare dashboard.",
    ],
  },
  {
    key: "pagesOpsRequired",
    comments: [
      "# Pages Functions required active bindings for the ops admin proxy.",
      "# Also configure the shared keys above: `CF_ACCESS_TEAM_DOMAIN` and",
      "# `CF_ACCESS_OPS_UI_AUD`. `CF_ACCESS_TEAM_DOMAIN` is active on both Worker",
      "# and Pages; `CF_ACCESS_OPS_UI_AUD` is active on Pages and reserved on Worker.",
    ],
  },
  {
    key: "pagesOptional",
    comments: [
      "# Pages Functions optional active bindings",
      "# `OPS_UI_ORIGIN` and `OPS_API_ORIGIN` are the same names listed above as",
      "# worker-reserved keys, but they are active on the Pages Functions runtime.",
    ],
  },
];

export const ENV_BINDINGS = [
  {
    key: "NEXT_PUBLIC_API_BASE",
    valueType: "string",
    description: "Optional frontend API-base override, mainly for local `next dev` against `wrangler dev`.",
    example: { section: "frontend", value: "" },
    runtimes: {
      frontend: { order: 1, status: "optional" },
    },
  },
  {
    key: "NEXT_PUBLIC_GA_ID",
    valueType: "string",
    description: "Optional GA4 measurement ID; when unset, the site renders without analytics injection.",
    example: { section: "frontend", value: "" },
    runtimes: {
      frontend: { order: 2, status: "optional" },
    },
  },
  {
    key: "DB",
    valueType: "D1Database",
    description: "Primary D1 binding for worker reads/writes; the Pages site-data lane also uses it for attribution telemetry.",
    docs: { includeInOperatorOriginAccess: true },
    runtimes: {
      worker: { order: 1, status: "required" },
      pagesSiteData: { order: 1, status: "optional" },
    },
  },
  {
    key: "CORS_ORIGIN",
    valueType: "string",
    description: "Comma-separated CORS allowlist; repo default is `https://pharos.watch,https://ops.pharos.watch`.",
    example: { section: "workerRequired", value: "https://pharos.watch,https://ops.pharos.watch" },
    runtimes: {
      worker: { order: 2, status: "required" },
    },
  },
  {
    key: "SELF_URL",
    valueType: "string",
    description: "Status self-check external probe base URL.",
    example: { section: "workerOptional", value: "https://api.pharos.watch" },
    runtimes: {
      worker: { order: 1, status: "optional" },
    },
  },
  {
    key: "SITE_API_SHARED_SECRET",
    valueType: "string",
    description: "Shared secret for Pages `/_site-data/*` -> Worker `site-api` authentication via `X-Pharos-Site-Proxy-Secret`.",
    docs: { includeInOperatorOriginAccess: true },
    example: { section: "sharedSiteApiSecret", value: "" },
    runtimes: {
      worker: { order: 2, status: "optional" },
      pagesSiteData: { order: 2, status: "required" },
    },
  },
  {
    key: "SITE_API_SHARED_SECRET_PREVIOUS",
    valueType: "string",
    description: "Optional overlap secret accepted alongside `SITE_API_SHARED_SECRET` during the site-data rotation window.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 3, status: "optional" },
    },
  },
  {
    key: "API_KEY_HASH_PEPPER",
    valueType: "string",
    description: "HMAC pepper used to hash the secret portion of public API keys.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 4, status: "optional" },
    },
  },
  {
    key: "API_KEY_HASH_PEPPER_PREVIOUS",
    valueType: "string",
    description: "Optional overlap pepper accepted alongside `API_KEY_HASH_PEPPER` during public API key rotation.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 5, status: "optional" },
    },
  },
  {
    key: "PUBLIC_API_AUTH_MODE",
    valueType: "string",
    description: "Public API auth mode: `off`, `report-only`, or `enforce`.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 6, status: "optional" },
    },
  },
  {
    key: "CF_ACCESS_TEAM_DOMAIN",
    valueType: "string",
    description: "Cloudflare Access team domain used to verify Access JWTs on worker admin requests and the Pages ops proxy.",
    docs: { includeInOperatorOriginAccess: true },
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 7, status: "optional" },
      pagesOps: { order: 3, status: "required" },
    },
  },
  {
    key: "CF_ACCESS_OPS_API_AUD",
    valueType: "string",
    description: "Cloudflare Access audience for worker-side `ops-api.pharos.watch` JWT verification.",
    docs: { includeInOperatorOriginAccess: true },
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 8, status: "optional" },
    },
  },
  {
    key: "ETHERSCAN_API_KEY",
    valueType: "string",
    description: "Etherscan API credential used by blacklist sync and USDS status reads.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 9, status: "optional" },
    },
  },
  {
    key: "TRONGRID_API_KEY",
    valueType: "string",
    description: "TronGrid API credential used by the Tron blacklist-sync lane.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 10, status: "optional" },
    },
  },
  {
    key: "DRPC_API_KEY",
    valueType: "string",
    description: "dRPC credential used for L2 archive-node balance lookups.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 11, status: "optional" },
    },
  },
  {
    key: "ALCHEMY_API_KEY",
    valueType: "string",
    description: "Alchemy credential used for primary chain RPC endpoints.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 12, status: "optional" },
    },
  },
  {
    key: "GRAPH_API_KEY",
    valueType: "string",
    description: "The Graph credential used by DEX liquidity subgraph reads.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 13, status: "optional" },
    },
  },
  {
    key: "ALERT_WEBHOOK_URL",
    valueType: "string",
    description: "Webhook URL used for Discord/Slack-style error alerts.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 14, status: "optional" },
    },
  },
  {
    key: "ANTHROPIC_API_KEY",
    valueType: "string",
    description: "Anthropic credential used for daily digest generation.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 15, status: "optional" },
    },
  },
  {
    key: "CMC_API_KEY",
    valueType: "string",
    description: "CoinMarketCap credential used by the price-fallback pass.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 16, status: "optional" },
    },
  },
  {
    key: "COINGECKO_API_KEY",
    valueType: "string",
    description: "CoinGecko credential used for price enrichment and depeg confirmation.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 17, status: "optional" },
    },
  },
  {
    key: "GITHUB_PAT",
    valueType: "string",
    description: "GitHub personal access token used by the feedback -> issue bridge.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 18, status: "optional" },
    },
  },
  {
    key: "FEEDBACK_IP_SALT",
    valueType: "string",
    description: "Dedicated salt for hashed-IP feedback submission throttling.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 19, status: "optional" },
    },
  },
  {
    key: "PUBLIC_API_RATE_LIMIT_SALT",
    valueType: "string",
    description: "Dedicated salt for hashed public API rate limiting; deployed public API traffic returns `503` until configured.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 20, status: "optional" },
    },
  },
  {
    key: "TWITTER_API_KEY",
    valueType: "string",
    description: "Twitter/X digest delivery credential.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 21, status: "optional" },
    },
  },
  {
    key: "TWITTER_API_SECRET",
    valueType: "string",
    description: "Twitter/X digest delivery credential.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 22, status: "optional" },
    },
  },
  {
    key: "TWITTER_ACCESS_TOKEN",
    valueType: "string",
    description: "Twitter/X digest delivery credential.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 23, status: "optional" },
    },
  },
  {
    key: "TWITTER_ACCESS_TOKEN_SECRET",
    valueType: "string",
    description: "Twitter/X digest delivery credential.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 24, status: "optional" },
    },
  },
  {
    key: "TELEGRAM_BOT_TOKEN",
    valueType: "string",
    description: "Telegram bot credential used for digest delivery and alert dispatch.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 25, status: "optional" },
    },
  },
  {
    key: "TELEGRAM_CHAT_ID",
    valueType: "string",
    description: "Telegram target chat/channel for digest posts and announcements.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 26, status: "optional" },
    },
  },
  {
    key: "TELEGRAM_WEBHOOK_SECRET",
    valueType: "string",
    description: "Telegram webhook secret used to authenticate the webhook lane.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 27, status: "optional" },
    },
  },
  {
    key: "TELEGRAM_WEBHOOK_SECRET_PREVIOUS",
    valueType: "string",
    description: "Optional overlap Telegram webhook secret accepted during secret rotation.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 28, status: "optional" },
    },
  },
  {
    key: "MINT_BURN_DISABLED_IDS",
    valueType: "string",
    description: "Mint/burn runtime disable list by stablecoin ID (CSV).",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 29, status: "optional" },
    },
  },
  {
    key: "MINT_BURN_DISABLED_SYMBOLS",
    valueType: "string",
    description: "Mint/burn runtime disable list by symbol (CSV).",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 30, status: "optional" },
    },
  },
  {
    key: "MINT_BURN_MAJOR_SYMBOLS",
    valueType: "string",
    description: "Mint/burn health-check major-symbols override (CSV).",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 31, status: "optional" },
    },
  },
  {
    key: "MINT_BURN_STALE_WARN_SEC",
    valueType: "string",
    description: "Mint/burn stale-warning threshold override (seconds).",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 32, status: "optional" },
    },
  },
  {
    key: "MINT_BURN_STALE_CRIT_SEC",
    valueType: "string",
    description: "Mint/burn stale-critical threshold override (seconds).",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 33, status: "optional" },
    },
  },
  {
    key: "MINT_BURN_ALERT_COOLDOWN_SEC",
    valueType: "string",
    description: "Mint/burn stale-alert dedupe cooldown override (seconds).",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 34, status: "optional" },
    },
  },
  {
    key: "OPENEXCHANGERATES_API_KEY",
    valueType: "string",
    description: "Open Exchange Rates credential used for FX cross-validation.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 35, status: "optional" },
    },
  },
  {
    key: "CLOUDFLARE_ACCOUNT_ID",
    valueType: "string",
    description: "Cloudflare account scope used by admin D1 status metrics.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 36, status: "optional" },
    },
  },
  {
    key: "CLOUDFLARE_D1_STATUS_API_TOKEN",
    valueType: "string",
    description: "Cloudflare API token with D1 status/analytics read access for admin metrics.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 37, status: "optional" },
    },
  },
  {
    key: "CLOUDFLARE_D1_DATABASE_ID",
    valueType: "string",
    description: "Target D1 database ID used by admin D1 status metrics.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 38, status: "optional" },
    },
  },
  {
    key: "MAINTENANCE_MODE",
    valueType: "string",
    description: "Global worker kill switch; when `true`, non-`OPTIONS` traffic returns `503` maintenance responses.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 39, status: "optional" },
    },
  },
  {
    key: "OPS_UI_ORIGIN",
    valueType: "string",
    description: "Ops UI origin override; reserved on the worker and active on Pages host-gating / same-origin checks.",
    docs: { includeInOperatorOriginAccess: true },
    example: { section: "workerReserved", value: "https://ops.pharos.watch" },
    runtimes: {
      worker: { order: 1, status: "reserved" },
      pagesOps: { order: 1, status: "optional" },
      pagesSiteData: { order: 3, status: "optional" },
    },
  },
  {
    key: "OPS_API_ORIGIN",
    valueType: "string",
    description: "Ops API origin override; reserved on the worker and active on the Pages admin proxy upstream hop.",
    docs: { includeInOperatorOriginAccess: true },
    example: { section: "workerReserved", value: "https://ops-api.pharos.watch" },
    runtimes: {
      worker: { order: 2, status: "reserved" },
      pagesOps: { order: 2, status: "optional" },
    },
  },
  {
    key: "CF_ACCESS_OPS_UI_AUD",
    valueType: "string",
    description: "Cloudflare Access audience used by the Pages ops proxy to verify the inbound UI JWT.",
    docs: { includeInOperatorOriginAccess: true },
    example: { section: "workerReserved", value: "" },
    runtimes: {
      worker: { order: 3, status: "reserved" },
      pagesOps: { order: 4, status: "required" },
    },
  },
  {
    key: "OPS_API_SERVICE_TOKEN_ID",
    valueType: "string",
    description: "Pages-managed Access service-token client ID used on the server-to-server hop to `ops-api.pharos.watch`.",
    docs: { includeInOperatorOriginAccess: true },
    example: { section: "pagesOpsRequired", value: "" },
    runtimes: {
      pagesOps: { order: 1, status: "required" },
    },
  },
  {
    key: "OPS_API_SERVICE_TOKEN_SECRET",
    valueType: "string",
    description: "Pages-managed Access service-token client secret used on the server-to-server hop to `ops-api.pharos.watch`.",
    docs: { includeInOperatorOriginAccess: true },
    example: { section: "pagesOpsRequired", value: "" },
    runtimes: {
      pagesOps: { order: 2, status: "required" },
    },
  },
  {
    key: "SITE_ORIGIN",
    valueType: "string",
    description: "Site origin override used by the Pages `/_site-data/*` proxy when classifying production hosts.",
    docs: { includeInOperatorOriginAccess: true },
    example: { section: "pagesOptional", value: "https://pharos.watch" },
    runtimes: {
      pagesSiteData: { order: 2, status: "optional" },
    },
  },
  {
    key: "SITE_API_ORIGIN",
    valueType: "string",
    description: "Site-data upstream origin; production Pages hosts require `https://site-api.pharos.watch`.",
    docs: { includeInOperatorOriginAccess: true },
    example: { section: "pagesOptional", value: "https://site-api.pharos.watch" },
    runtimes: {
      pagesSiteData: { order: 4, status: "optional" },
    },
  },
] satisfies readonly EnvBindingDefinition[];

export type EnvBindingKey = (typeof ENV_BINDINGS)[number]["key"];

function compareRuntimeOrder(
  left: EnvBindingDefinition,
  right: EnvBindingDefinition,
  runtime: EnvRuntimeName,
) {
  return (left.runtimes[runtime]?.order ?? Number.MAX_SAFE_INTEGER)
    - (right.runtimes[runtime]?.order ?? Number.MAX_SAFE_INTEGER);
}

function getBindingsForRuntime(
  runtime: EnvRuntimeName,
  status: EnvRuntimeStatus,
): EnvBindingDefinition[] {
  return ENV_BINDINGS
    .filter((binding) => binding.runtimes[runtime]?.status === status)
    .slice()
    .sort((left, right) => compareRuntimeOrder(left, right, runtime));
}

export function getRuntimeEnvKeys(
  runtime: EnvRuntimeName,
  status: EnvRuntimeStatus,
): string[] {
  return getBindingsForRuntime(runtime, status).map((binding) => binding.key);
}

export function getRuntimeActiveEnvKeys(runtime: EnvRuntimeName): string[] {
  return [
    ...getRuntimeEnvKeys(runtime, "required"),
    ...getRuntimeEnvKeys(runtime, "optional"),
  ];
}

export function getAllEnvBindingKeys(): string[] {
  return ENV_BINDINGS.map((binding) => binding.key);
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function renderMarkdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map((cell) => escapeMarkdownCell(cell)).join(" | ")} |`),
  ].join("\n");
}

function renderRuntimeStatus(
  binding: EnvBindingDefinition,
  runtime: Exclude<EnvRuntimeName, "frontend">,
): string {
  return binding.runtimes[runtime]?.status ?? "-";
}

function renderValueLine(key: string, value: string): string {
  return `${key}=${value}`;
}

export function renderEnvExample(): string {
  const lines: string[] = [];

  for (const section of ENV_EXAMPLE_SECTION_ORDER) {
    if (lines.length > 0) {
      lines.push("");
    }

    lines.push(...section.comments);

    const bindings = ENV_BINDINGS
      .filter((binding) => binding.example?.section === section.key)
      .slice()
      .sort((left, right) => left.key.localeCompare(right.key));

    if (section.key === "workerOptional") {
      const ordered = bindings.slice().sort((left, right) => compareRuntimeOrder(left, right, "worker"));
      for (const binding of ordered) {
        if (binding.key === "PUBLIC_API_RATE_LIMIT_SALT") {
          lines.push("# Required for deployed public API traffic. Public `/api/*` requests return 503");
          lines.push("# until this binding is configured.");
        }
        lines.push(renderValueLine(binding.key, binding.example?.value ?? ""));
      }
      continue;
    }

    if (section.key === "workerReserved") {
      const ordered = bindings.slice().sort((left, right) => compareRuntimeOrder(left, right, "worker"));
      for (const binding of ordered) {
        lines.push(renderValueLine(binding.key, binding.example?.value ?? ""));
      }
      continue;
    }

    if (section.key === "pagesOptional") {
      const ordered = bindings.slice().sort((left, right) => {
        const leftOrder = left.runtimes.pagesSiteData?.order ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = right.runtimes.pagesSiteData?.order ?? Number.MAX_SAFE_INTEGER;
        return leftOrder - rightOrder;
      });
      for (const binding of ordered) {
        lines.push(renderValueLine(binding.key, binding.example?.value ?? ""));
      }
      continue;
    }

    const ordered = bindings.slice().sort((left, right) => {
      const leftOrder = left.example?.section === "frontend"
        ? left.runtimes.frontend?.order ?? Number.MAX_SAFE_INTEGER
        : left.runtimes.worker?.status === "required"
          ? left.runtimes.worker.order
          : left.runtimes.pagesOps?.status === "required"
            ? left.runtimes.pagesOps.order
            : left.runtimes.pagesSiteData?.status === "required"
              ? left.runtimes.pagesSiteData.order
              : Number.MAX_SAFE_INTEGER;
      const rightOrder = right.example?.section === "frontend"
        ? right.runtimes.frontend?.order ?? Number.MAX_SAFE_INTEGER
        : right.runtimes.worker?.status === "required"
          ? right.runtimes.worker.order
          : right.runtimes.pagesOps?.status === "required"
            ? right.runtimes.pagesOps.order
            : right.runtimes.pagesSiteData?.status === "required"
              ? right.runtimes.pagesSiteData.order
              : Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder;
    });

    for (const binding of ordered) {
      lines.push(renderValueLine(binding.key, binding.example?.value ?? ""));
    }
  }

  return `${lines.join("\n")}\n`;
}

export function renderWorkerInfrastructureEnvBlock(): string {
  const rows = ENV_BINDINGS
    .filter((binding) => binding.runtimes.worker || binding.runtimes.pagesOps || binding.runtimes.pagesSiteData)
    .map((binding) => [
      `\`${binding.key}\``,
      `\`${binding.valueType}\``,
      renderRuntimeStatus(binding, "worker"),
      renderRuntimeStatus(binding, "pagesOps"),
      renderRuntimeStatus(binding, "pagesSiteData"),
      binding.description,
    ] as const);

  return [
    "Canonical binding ownership now lives in `shared/lib/env-contract.ts`; the worker and Pages env modules derive their `required` / `optional` / `reserved` views from that manifest.",
    "",
    renderMarkdownTable(
      ["Binding", "Type", "Worker", "Pages ops", "Pages site-data", "Description"],
      rows,
    ),
  ].join("\n");
}

export function renderOperatorOriginAccessEnvBlock(): string {
  const rows = ENV_BINDINGS
    .filter((binding) => binding.docs?.includeInOperatorOriginAccess)
    .map((binding) => [
      `\`${binding.key}\``,
      renderRuntimeStatus(binding, "worker"),
      renderRuntimeStatus(binding, "pagesOps"),
      renderRuntimeStatus(binding, "pagesSiteData"),
      binding.description,
    ] as const);

  return [
    "Current origin/access binding ownership derived from `shared/lib/env-contract.ts`:",
    "",
    renderMarkdownTable(
      ["Binding", "Worker", "Pages ops", "Pages site-data", "Purpose"],
      rows,
    ),
  ].join("\n");
}
