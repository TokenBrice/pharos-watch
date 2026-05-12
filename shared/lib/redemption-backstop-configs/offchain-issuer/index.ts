import { defineBackstopRegistry, type RedemptionBackstopRegistryEntry } from "../factory";
import { applyTrackedReviewedDocs } from "../shared";
import { BASE_OFFCHAIN_ISSUER_ENTRIES } from "./base-batches";
import { COMMODITY_OFFCHAIN_CONFIGS } from "./commodity";
import { COVERAGE_AND_STABLECOIN_AUDIT_OFFCHAIN_CONFIGS } from "./coverage-and-stablecoin-audit";
import { MAJOR_ISSUER_OFFCHAIN_CONFIGS } from "./major-issuers";
import { NON_USD_AND_TOKENIZED_OFFCHAIN_CONFIGS } from "./non-usd-and-tokenized";
import { REMEDIATION_AND_LATE_AUDIT_OFFCHAIN_CONFIGS } from "./remediation-and-late-audit";
import { REVIEWED_NON_USD_BATCH_AT, REVIEWED_REMEDIATION_AT } from "./shared";
import type { RedemptionBackstopConfig } from "../shared";

function defineRecordEntries(
  configs: Record<string, RedemptionBackstopConfig>,
  overrideReason: string,
): RedemptionBackstopRegistryEntry[] {
  return Object.entries(configs).map(([id, config]) => ({ id, config, overrideReason }));
}

export const OFFCHAIN_ISSUER_BACKSTOP_CONFIGS: Record<string, RedemptionBackstopConfig> = defineBackstopRegistry([
  ...BASE_OFFCHAIN_ISSUER_ENTRIES,
  ...defineRecordEntries(
    COVERAGE_AND_STABLECOIN_AUDIT_OFFCHAIN_CONFIGS,
    "Reviewed issuer-specific config replaces the shared offchain issuer default.",
  ),
  ...defineRecordEntries(
    MAJOR_ISSUER_OFFCHAIN_CONFIGS,
    "Reviewed major-issuer config replaces the shared offchain issuer default.",
  ),
  ...defineRecordEntries(
    NON_USD_AND_TOKENIZED_OFFCHAIN_CONFIGS,
    "Reviewed non-USD or tokenized-asset config replaces the shared offchain issuer default.",
  ),
  ...defineRecordEntries(
    COMMODITY_OFFCHAIN_CONFIGS,
    "Reviewed commodity issuer config replaces the shared offchain issuer default.",
  ),
  ...defineRecordEntries(
    REMEDIATION_AND_LATE_AUDIT_OFFCHAIN_CONFIGS,
    "Reviewed remediation or late-audit config replaces the shared offchain issuer default.",
  ),
]);

applyTrackedReviewedDocs(OFFCHAIN_ISSUER_BACKSTOP_CONFIGS, [
  "usdt-tether",
  "usdc-circle",
  "pyusd-paypal",
  "fdusd-first-digital",
  "rlusd-ripple",
  "eurc-circle",
  "usdg-paxos",
  "usd1-world-liberty-financial",
  "ausd-agora",
  "tusd-trueusd",
  "brz-transfero",
  "a7a5-old-vector",
  "ylds-figure",
  "usdtb-ethena",
  "gusd-gate",
  "usyc-hashnote",
  "ustb-superstate",
  "buidl-blackrock",
  "usdy-ondo-finance",
  "paxg-paxos",
  "xaut-tether",
  "kau-kinesis",
  "kag-kinesis",
]);

applyTrackedReviewedDocs(OFFCHAIN_ISSUER_BACKSTOP_CONFIGS, [
  "zarp-zarp",
  "cetes-etherfuse",
  "cgo-comtech",
  "dgld-gold-token-sa",
], REVIEWED_REMEDIATION_AT);

applyTrackedReviewedDocs(OFFCHAIN_ISSUER_BACKSTOP_CONFIGS, [
  "audx-aussie-dollar-token",
  "brl1-brl1",
  "cngn-compliant-naira",
  "kgst-kyrgyz-som",
  "reur-royal-euro",
  "wars-argentine-peso",
  "eusd-telcoin",
  "jpyc-jpyc-v1",
  "rusd-royal-dollar",
], REVIEWED_NON_USD_BATCH_AT);
