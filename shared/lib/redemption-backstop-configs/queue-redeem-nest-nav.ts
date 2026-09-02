import type { RedemptionBackstopConfig } from "./shared";
import {
  cloneRedemptionBackstopConfig,
  documentedBoundSupplyFull,
  queueRedeemBase,
  sourceRefFull,
  undisclosedReviewedFee,
} from "./shared";
import { REVIEWED_STABLECOIN_AUDIT_AT } from "./review-dates";

const REVIEWED_REDEMPTION_OUTPUTS_AT = "2026-07-15";

/** Nest NAV-vault redemptions (nTBILL/nBASIS/nOPAL/nWISDOM) share an identical
 *  issuer-API queued-NAV shape and docs[]; they differ only in the documented
 *  stablecoin output basket and fee-description token name. */
const nestNavVaultBase: RedemptionBackstopConfig = {
  ...queueRedeemBase,
  ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
  accessModel: "issuer-api",
  settlementModel: "days",
  executionModel: "rules-based-nav",
  outputAssetType: "stable-basket",
  costModel: undisclosedReviewedFee(),
  reviewedAt: REVIEWED_REDEMPTION_OUTPUTS_AT,
  docs: [
    sourceRefFull("Nest available vaults", "https://docs.nest.credit/about/available-vaults"),
  ],
};

const NEST_NAV_VAULTS: readonly [id: string, ticker: string, outputAssets: readonly string[]][] = [
  ["ntbill-nest", "nTBILL", ["usdc-circle", "pusd-plume"]],
  ["nbasis-nest", "nBASIS", ["usdc-circle", "pusd-plume"]],
  ["nopal-nest", "nOPAL", ["usdc-circle", "pusd-plume", "usdt-tether"]],
  ["nwisdom-nest", "nWISDOM", ["usdc-circle", "pusd-plume"]],
];

export const NEST_NAV_VAULT_CONFIGS: Record<string, RedemptionBackstopConfig> = Object.fromEntries(
  NEST_NAV_VAULTS.map(([id, ticker, outputAssets]) => {
    const config = cloneRedemptionBackstopConfig(nestNavVaultBase);
    config.outputAssets = [...outputAssets];
    config.costModel = undisclosedReviewedFee(
      `Nest docs describe ${ticker} redemptions through the Nest app; public materials reviewed do not publish one fixed redemption fee`,
    );
    config.notes = [`Nest's current vault directory lists a ${ticker} redemption estimate of 4 days.`];
    return [id, config];
  }),
);
