import type { DataQuality, StatusResponse, StatusSectionError } from "@shared/types/status";

const STATUS_SECTION_MESSAGES: Record<string, string> = {
  dependencyHealth: "Dependency health unavailable.",
  reserveComposition: "Reserve composition overview unavailable.",
  scheduledSlots: "Scheduled slot diagnostics unavailable.",
  telegramBot: "Telegram bot diagnostics unavailable.",
  liquidity_health_extraction_failed: "Liquidity health data unavailable.",
  yield_health_summary_failed: "Yield health summary unavailable.",
  publication_health_partial_failure: "Publication health partially unavailable.",
  publication_health_query_failed: "Publication health unavailable.",
  provider_circuit_health_query_failed: "Provider circuit health unavailable.",
  canary_status_query_failed: "Data-invariant canaries unavailable.",
  price_source_health_extraction_failed: "Price source health data unavailable.",
  coingecko_price_diff_query_failed: "CoinGecko price diff unavailable.",
  cloudflare_d1_status_config_incomplete:
    "CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_STATUS_API_TOKEN, and CLOUDFLARE_D1_DATABASE_ID must be configured together for admin D1 metrics.",
  d1_usage_query_failed: "D1 usage metrics unavailable.",
  mint_burn_reconciliation_query_failed: "Mint/burn reconciliation unavailable.",
  reserve_drift_computation_failed: "Reserve drift diagnostics unavailable.",
  classification_warnings_computation_failed: "Classification warnings unavailable.",
};
const STATUS_SECTION_FALLBACK_MESSAGE = "Status section unavailable.";

export function getStatusSectionMessage(code: keyof StatusResponse["sectionErrors"]): string {
  return STATUS_SECTION_MESSAGES[code] ?? STATUS_SECTION_FALLBACK_MESSAGE;
}

export function createStatusSectionError(code: string): StatusSectionError {
  return {
    code,
    message: STATUS_SECTION_MESSAGES[code] ?? STATUS_SECTION_FALLBACK_MESSAGE,
  };
}

type DataQualitySourceKey = DataQuality["sourceFailures"][number]["source"];

const SOURCE_FAILURE_MESSAGES: Record<DataQualitySourceKey, string> = {
  "active-depegs": "Active depeg metrics unavailable.",
  "blacklist-gaps": "Blacklist gap metrics unavailable.",
  "onchain-supply": "Onchain supply diagnostics unavailable.",
  "stablecoins-cache": "Stablecoins cache unavailable.",
};

export function getSourceFailureMessage(source: DataQualitySourceKey): string {
  return SOURCE_FAILURE_MESSAGES[source];
}
