import { defineRecordEntries, finalizeBackstopRegistry } from "../factory";
import { BASE_OFFCHAIN_ISSUER_ENTRIES } from "./base-batches";
import { COMMODITY_OFFCHAIN_CONFIGS } from "./commodity";
import { COVERAGE_AND_STABLECOIN_AUDIT_OFFCHAIN_CONFIGS } from "./coverage-and-stablecoin-audit";
import { MAJOR_ISSUER_OFFCHAIN_CONFIGS } from "./major-issuers";
import { NON_USD_AND_TOKENIZED_OFFCHAIN_CONFIGS } from "./non-usd-and-tokenized";
import { REMEDIATION_AND_LATE_AUDIT_OFFCHAIN_CONFIGS } from "./remediation-and-late-audit";
import { REVIEWED_NON_USD_BATCH_AT, REVIEWED_REMEDIATION_AT } from "./shared";
import type { RedemptionBackstopConfig } from "../shared";

const OFFCHAIN_ISSUER_REGISTRY_ENTRIES = [
  ...BASE_OFFCHAIN_ISSUER_ENTRIES,
  ...defineRecordEntries(COVERAGE_AND_STABLECOIN_AUDIT_OFFCHAIN_CONFIGS, {
    overrideReason: "Reviewed issuer-specific config replaces the shared offchain issuer default.",
    sourceFilePath: "shared/lib/redemption-backstop-configs/offchain-issuer/coverage-and-stablecoin-audit.ts",
  }),
  ...defineRecordEntries(MAJOR_ISSUER_OFFCHAIN_CONFIGS, {
    overrideReason: "Reviewed major-issuer config replaces the shared offchain issuer default.",
    sourceFilePath: "shared/lib/redemption-backstop-configs/offchain-issuer/major-issuers.ts",
  }),
  ...defineRecordEntries(NON_USD_AND_TOKENIZED_OFFCHAIN_CONFIGS, {
    overrideReason: "Reviewed non-USD or tokenized-asset config replaces the shared offchain issuer default.",
    sourceFilePath: "shared/lib/redemption-backstop-configs/offchain-issuer/non-usd-and-tokenized.ts",
  }),
  ...defineRecordEntries(COMMODITY_OFFCHAIN_CONFIGS, {
    overrideReason: "Reviewed commodity issuer config replaces the shared offchain issuer default.",
    sourceFilePath: "shared/lib/redemption-backstop-configs/offchain-issuer/commodity.ts",
  }),
  ...defineRecordEntries(REMEDIATION_AND_LATE_AUDIT_OFFCHAIN_CONFIGS, {
    overrideReason: "Reviewed remediation or late-audit config replaces the shared offchain issuer default.",
    sourceFilePath: "shared/lib/redemption-backstop-configs/offchain-issuer/remediation-and-late-audit.ts",
  }),
];

const FINALIZED_OFFCHAIN_ISSUER_BACKSTOP_REGISTRY = finalizeBackstopRegistry(
  OFFCHAIN_ISSUER_REGISTRY_ENTRIES,
  [
    {
      stablecoinIds: [
        "usdt-tether", "usdc-circle", "pyusd-paypal", "fdusd-first-digital", "rlusd-ripple",
        "eurc-circle", "usdg-paxos", "usd1-world-liberty-financial", "ausd-agora", "tusd-trueusd",
        "brz-transfero", "a7a5-old-vector", "ylds-figure", "usdtb-ethena", "gusd-gate",
        "usyc-hashnote", "buidl-blackrock", "usdy-ondo-finance", "paxg-paxos", "xaut-tether",
        "kau-kinesis", "kag-kinesis",
      ],
    },
    {
      stablecoinIds: ["zarp-zarp", "cetes-etherfuse", "cgo-comtech", "dgld-gold-token-sa"],
      reviewedAt: REVIEWED_REMEDIATION_AT,
    },
    {
      stablecoinIds: [
        "audx-aussie-dollar-token", "brl1-brl1", "cngn-compliant-naira", "kgst-kyrgyz-som",
        "reur-royal-euro", "wars-argentine-peso", "eusd-telcoin", "jpyc-jpyc-v1", "rusd-royal-dollar",
      ],
      reviewedAt: REVIEWED_NON_USD_BATCH_AT,
    },
  ],
);

export const OFFCHAIN_ISSUER_BACKSTOP_CONFIGS: Record<string, RedemptionBackstopConfig> =
  FINALIZED_OFFCHAIN_ISSUER_BACKSTOP_REGISTRY.configs;
export const OFFCHAIN_ISSUER_BACKSTOP_ENTRIES = FINALIZED_OFFCHAIN_ISSUER_BACKSTOP_REGISTRY.entries;
