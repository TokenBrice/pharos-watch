import type {
  EnvBindingDefinition,
  EnvRuntimeName,
  EnvRuntimeStatus,
} from "./types.ts";

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
    key: "NEXT_PUBLIC_FORCE_SITE_DATA_PROXY",
    valueType: "string",
    description: "Optional CI/local-smoke frontend override; when `true`, browser reads use same-origin `/_site-data/*` even on local hosts.",
    example: { section: "frontend", value: "" },
    runtimes: {
      frontend: { order: 3, status: "optional" },
    },
  },
  {
    key: "DB",
    valueType: "D1Database",
    description: "Primary D1 binding for worker reads/writes; Pages uses it for optional site-data attribution telemetry and required atomic selector-snapshot write quotas.",
    docs: { includeInOperatorOriginAccess: true },
    runtimes: {
      worker: { order: 50, status: "required" },
      pagesSiteData: { order: 1, status: "required" },
    },
  },
  {
    key: "CORS_ORIGIN",
    valueType: "string",
    description: "Comma-separated CORS allowlist; repo default is `https://pharos.watch,https://ops.pharos.watch`.",
    example: { section: "workerRequired", value: "https://pharos.watch,https://ops.pharos.watch" },
    runtimes: {
      worker: { order: 51, status: "required" },
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
    description: "Alchemy credential used for primary chain RPC endpoints and, when enabled, Alchemy Prices API address-price augmentation.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 12, status: "optional" },
    },
  },
  {
    key: "MORALIS_API_KEY",
    valueType: "string",
    description: "Moralis credential used for optional exact-address token-price augmentation.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 13, status: "optional" },
    },
  },
  {
    key: "BIRDEYE_API_KEY",
    valueType: "string",
    description: "Birdeye credential used for optional targeted Solana exact-address token-price augmentation.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 14, status: "optional" },
    },
  },
  {
    key: "ADDRESS_PRICE_PROVIDERS_ENABLED",
    valueType: "string",
    description: "Optional comma-separated allowlist for exact-address price providers; unset auto-enables DexPaprika plus configured key-backed providers. Use `none` to disable, or include `dexscreener-address` only for explicit opt-in to that Cloudflare/WAF-protected public lane.",
    example: { section: "workerOptional", value: "dexpaprika-address,moralis-address,birdeye-address" },
    runtimes: {
      worker: { order: 15, status: "optional" },
    },
  },
  {
    key: "GRAPH_API_KEY",
    valueType: "string",
    description: "The Graph credential used by DEX liquidity subgraph reads.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 16, status: "optional" },
    },
  },
  {
    key: "ALERT_WEBHOOK_URL",
    valueType: "string",
    description: "Webhook URL used for Discord/Slack-style error alerts.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 17, status: "optional" },
    },
  },
  {
    key: "ANTHROPIC_API_KEY",
    valueType: "string",
    description: "Anthropic credential used for daily digest generation.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 18, status: "optional" },
    },
  },
  {
    key: "CMC_API_KEY",
    valueType: "string",
    description: "CoinMarketCap credential used by the price-fallback pass.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 19, status: "optional" },
    },
  },
  {
    key: "JUPITER_API_KEY",
    valueType: "string",
    description: "Jupiter credential used by the Solana price-fallback pass against `api.jup.ag`.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 20, status: "optional" },
    },
  },
  {
    key: "COINGECKO_API_KEY",
    valueType: "string",
    description: "CoinGecko credential used for price enrichment and depeg confirmation.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 21, status: "optional" },
    },
  },
  {
    key: "VAULTS_FYI_API_KEY",
    valueType: "string",
    description: "Optional vaults.fyi credential for the disabled-by-default supplemental yield integration.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 49, status: "optional" },
    },
  },
  {
    key: "VAULTS_FYI_ENABLED",
    valueType: "string",
    description: "Optional vaults.fyi supplemental yield integration flag; unset, false, or malformed values keep the integration disabled.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 50, status: "optional" },
    },
  },
  {
    key: "VAULTS_FYI_RANKABLE_VAULTS",
    valueType: "string",
    description: "Optional CSV allowlist of vaults.fyi `network:vaultId` entries allowed to publish rankable supplemental yield rows.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 51, status: "optional" },
    },
  },
  {
    key: "VAULTS_FYI_MAX_CREDITS_PER_RUN",
    valueType: "string",
    description: "Optional positive integer local cap for estimated vaults.fyi credit units consumed by one supplemental yield run.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 52, status: "optional" },
    },
  },
  {
    key: "VAULTS_FYI_MAX_CREDITS_PER_MONTH",
    valueType: "string",
    description: "Optional positive integer local cap for estimated vaults.fyi credit units consumed during one UTC month.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 53, status: "optional" },
    },
  },
  {
    key: "VAULTS_FYI_MAX_PAGES_PER_RUN",
    valueType: "string",
    description: "Optional positive integer page cap for the audit-only vaults.fyi inventory probe.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 54, status: "optional" },
    },
  },
  {
    key: "GITHUB_PAT",
    valueType: "string",
    description: "GitHub personal access token used by the feedback -> issue bridge; required to keep `POST /api/feedback` available.",
    example: { section: "workerRequired", value: "" },
    runtimes: {
      worker: { order: 52, status: "required" },
    },
  },
  {
    key: "FEEDBACK_IP_SALT",
    valueType: "string",
    description: "Dedicated salt for hashed-IP feedback submission throttling; required to keep `POST /api/feedback` available.",
    example: { section: "workerRequired", value: "" },
    runtimes: {
      worker: { order: 53, status: "required" },
    },
  },
  {
    key: "API_KEY_SELF_SERVE_IP_SALT",
    valueType: "string",
    description: "Dedicated salt for hashed-IP self-serve API key request throttling.",
    example: { section: "workerRequired", value: "" },
    runtimes: {
      worker: { order: 54, status: "required" },
    },
  },
  {
    key: "API_KEY_SELF_SERVE_EMAIL_HASH_PEPPER",
    valueType: "string",
    description: "HMAC pepper used for private self-serve API request email lookup and duplicate-claim keys.",
    example: { section: "workerRequired", value: "" },
    runtimes: {
      worker: { order: 55, status: "required" },
    },
  },
  {
    key: "API_KEY_SELF_SERVE_REQUEST_PEPPER",
    valueType: "string",
    description: "HMAC pepper used to hash one-time self-serve API email verification tokens.",
    example: { section: "workerRequired", value: "" },
    runtimes: {
      worker: { order: 56, status: "required" },
    },
  },
  {
    key: "RESEND_API_KEY",
    valueType: "string",
    description: "Resend API key used to send self-serve API verification emails.",
    example: { section: "workerRequired", value: "" },
    runtimes: {
      worker: { order: 57, status: "required" },
    },
  },
  {
    key: "API_KEY_SELF_SERVE_EMAIL_FROM",
    valueType: "string",
    description: "Configured sender for self-serve API verification emails, e.g. `Pharos API <api@mail.pharos.watch>`.",
    example: { section: "workerRequired", value: "Pharos API <api@mail.pharos.watch>" },
    runtimes: {
      worker: { order: 58, status: "required" },
    },
  },
  {
    key: "API_KEY_SELF_SERVE_EMAIL_REPLY_TO",
    valueType: "string",
    description: "Reply-to address for self-serve API verification emails.",
    example: { section: "workerRequired", value: "api@mail.pharos.watch" },
    runtimes: {
      worker: { order: 59, status: "required" },
    },
  },
  {
    key: "API_KEY_SELF_SERVE_PUBLIC_BASE_URL",
    valueType: "string",
    description: "Public website URL used to build self-serve API verification links; production value is `https://pharos.watch/api`.",
    example: { section: "workerRequired", value: "https://pharos.watch/api" },
    runtimes: {
      worker: { order: 60, status: "required" },
    },
  },
  {
    key: "TWITTER_API_KEY",
    valueType: "string",
    description: "Twitter/X digest delivery credential.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 22, status: "optional" },
    },
  },
  {
    key: "TWITTER_API_SECRET",
    valueType: "string",
    description: "Twitter/X digest delivery credential.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 23, status: "optional" },
    },
  },
  {
    key: "TWITTER_ACCESS_TOKEN",
    valueType: "string",
    description: "Twitter/X digest delivery credential.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 24, status: "optional" },
    },
  },
  {
    key: "TWITTER_ACCESS_TOKEN_SECRET",
    valueType: "string",
    description: "Twitter/X digest delivery credential.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 25, status: "optional" },
    },
  },
  {
    key: "TELEGRAM_BOT_TOKEN",
    valueType: "string",
    description: "Telegram bot credential used for digest delivery and alert dispatch.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 26, status: "optional" },
    },
  },
  {
    key: "TELEGRAM_BOT_TOKEN_PREVIOUS",
    valueType: "string",
    description: "Optional previous Telegram bot token marker used for rotation consistency checks.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 27, status: "optional" },
    },
  },
  {
    key: "TELEGRAM_CHAT_ID",
    valueType: "string",
    description: "Telegram target chat/channel for digest posts and announcements.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 28, status: "optional" },
    },
  },
  {
    key: "TELEGRAM_WEBHOOK_SECRET",
    valueType: "string",
    description: "Telegram webhook secret used to authenticate the webhook lane.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 29, status: "optional" },
    },
  },
  {
    key: "TELEGRAM_WEBHOOK_SECRET_PREVIOUS",
    valueType: "string",
    description: "Optional overlap Telegram webhook secret accepted during secret rotation.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 30, status: "optional" },
    },
  },
  {
    key: "MINT_BURN_DISABLED_IDS",
    valueType: "string",
    description: "Mint/burn runtime disable list by stablecoin ID (CSV).",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 31, status: "optional" },
    },
  },
  {
    key: "MINT_BURN_DISABLED_SYMBOLS",
    valueType: "string",
    description: "Mint/burn runtime disable list by symbol (CSV).",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 32, status: "optional" },
    },
  },
  {
    key: "MINT_BURN_MAJOR_SYMBOLS",
    valueType: "string",
    description: "Mint/burn health-check major-symbols override (CSV).",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 33, status: "optional" },
    },
  },
  {
    key: "MINT_BURN_STALE_WARN_SEC",
    valueType: "string",
    description: "Mint/burn stale-warning threshold override (seconds).",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 34, status: "optional" },
    },
  },
  {
    key: "MINT_BURN_STALE_CRIT_SEC",
    valueType: "string",
    description: "Mint/burn stale-critical threshold override (seconds).",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 35, status: "optional" },
    },
  },
  {
    key: "MINT_BURN_ALERT_COOLDOWN_SEC",
    valueType: "string",
    description: "Mint/burn stale-alert dedupe cooldown override (seconds).",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 36, status: "optional" },
    },
  },
  {
    key: "OPENEXCHANGERATES_API_KEY",
    valueType: "string",
    description: "Open Exchange Rates credential used for FX cross-validation.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 37, status: "optional" },
    },
  },
  {
    key: "BANXICO_TOKEN",
    valueType: "string",
    description: "Banxico SIE API token required for official MXN CETES 28-day benchmark rates; when the feed fails, MXN retains the last market benchmark when available or remains unavailable for USD fallback.",
    example: { section: "workerRequired", value: "" },
    runtimes: {
      worker: { order: 61, status: "required" },
    },
  },
  {
    key: "CLOUDFLARE_ACCOUNT_ID",
    valueType: "string",
    description: "Cloudflare account scope used by admin D1 status metrics.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 39, status: "optional" },
    },
  },
  {
    key: "CLOUDFLARE_D1_STATUS_API_TOKEN",
    valueType: "string",
    description: "Cloudflare API token with D1 status/analytics read access for admin metrics.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 40, status: "optional" },
    },
  },
  {
    key: "CLOUDFLARE_D1_DATABASE_ID",
    valueType: "string",
    description: "Target D1 database ID used by admin D1 status metrics.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 41, status: "optional" },
    },
  },
  {
    key: "MAINTENANCE_MODE",
    valueType: "string",
    description: "Global worker kill switch; when `true`, non-`OPTIONS` traffic returns `503` maintenance responses.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 42, status: "optional" },
    },
  },
  {
    key: "REQUEST_SOURCE_ATTRIBUTION_DISABLED",
    valueType: "string",
    description: "Operational telemetry kill switch for low-value route/source attribution writes on Worker and Pages site-data lanes.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 43, status: "optional" },
      pagesSiteData: { order: 4, status: "optional" },
    },
  },
  {
    key: "API_KEY_REQUEST_ATTRIBUTION_DISABLED",
    valueType: "string",
    description: "Worker-only operational telemetry kill switch for per-key public API attribution writes.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 44, status: "optional" },
    },
  },
  {
    key: "WORKER_JOB_LEDGER_MODE",
    valueType: "string",
    description: "Scheduled Worker job-attempt ledger mode. Unset or `off` disables writes; `shadow` records best-effort telemetry without changing execution; `write` is reserved for later promotion and currently behaves like `shadow`.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 45, status: "optional" },
    },
  },
  {
    key: "WORKER_JOB_LEDGER_ALLOWLIST",
    valueType: "string",
    description: "Optional CSV allowlist for job-attempt ledger recording. Unset records all scheduled jobs when the ledger mode is enabled.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 46, status: "optional" },
    },
  },
  {
    key: "WORKER_REPAIR_RUNNER_MODE",
    valueType: "string",
    description: "Worker repair-task runner mode. Unset or `off` disables repair processing; `shadow` records due/stale backlog telemetry without claiming rows; `enabled` lets the daily DB-only runner claim, close, or defer a small batch.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 47, status: "optional" },
    },
  },
  {
    key: "WORKER_CANARY_MODE",
    valueType: "string",
    description: "Worker data-invariant canary mode. Unset or `off` skips writes; `shadow`, `status`, and `alert` record structural canary telemetry without changing producer behavior.",
    example: { section: "workerOptional", value: "" },
    runtimes: {
      worker: { order: 48, status: "optional" },
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
    example: { section: "pagesSiteDataRequired", value: "https://site-api.pharos.watch" },
    runtimes: {
      pagesSiteData: { order: 3, status: "required" },
    },
  },
  {
    key: "SELECTOR_SNAPSHOTS",
    valueType: "KVNamespace",
    description: "KV namespace binding for the Pages-only Stablecoin Picker snapshot store at `functions/selector-snapshot/[[path]].ts`; new content-addressed `s:{sid}` entries carry server-recomputed trust metadata, while legacy entries remain client-unverified. HMAC-IP write-quota counters live in D1 for atomic reservations.",
    example: { section: "pagesSiteDataRequired", value: "" },
    runtimes: {
      pagesSiteData: { order: 5, status: "required" },
    },
  },
  {
    key: "SELECTOR_SNAPSHOT_IP_HASH_SECRET",
    valueType: "string",
    description: "Dedicated HMAC pepper for selector-snapshot IP rate-limit and daily-quota keys; raw IP addresses are never stored.",
    docs: { includeInOperatorOriginAccess: true },
    example: { section: "pagesSiteDataRequired", value: "" },
    runtimes: {
      pagesSiteData: { order: 4, status: "required" },
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
