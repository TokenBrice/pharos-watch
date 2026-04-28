import type {
  EnvBindingDefinition,
  EnvRuntimeName,
  EnvRuntimeStatus,
} from "./types";

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

export function compareRuntimeOrder(
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
