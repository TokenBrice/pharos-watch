import type { RedemptionBackstopConfig } from "./shared";
import {
  cloneRedemptionBackstopConfig,
  documentedBoundSupplyFull,
  fixedFee,
  queueRedeemBase,
  sourceRef,
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

/** Vaults whose documented Plume USDC and pUSD NestVault paths both returned
 *  fees(2) = (flat 0, rate 0) at Plume block 97180152 (2026-10-03T23:12:23Z).
 *  The zero covers only the direct queued-redemption fee on those paths. */
const NEST_ZERO_QUEUED_FEE_VAULTS: Partial<Record<string, true>> = { "ntbill-nest": true, "nwisdom-nest": true };

export const NEST_NAV_VAULT_CONFIGS: Record<string, RedemptionBackstopConfig> = Object.fromEntries(
  NEST_NAV_VAULTS.map(([id, ticker, outputAssets]) => {
    const config = cloneRedemptionBackstopConfig(nestNavVaultBase);
    config.outputAssets = [...outputAssets];
    const zeroQueuedFee = NEST_ZERO_QUEUED_FEE_VAULTS[id] === true;
    config.costModel = zeroQueuedFee
      ? fixedFee(
          0,
          `${ticker} NestVault fees(2) returned flat 0 and rate 0 on the documented Plume USDC and pUSD paths at Plume block 97180152 (2026-10-03); this zero covers only the direct queued-redemption fee, not transaction gas, optional bridge legs, or other chains`,
        )
      : undisclosedReviewedFee(
          `Nest docs describe ${ticker} redemptions through the Nest app; public materials reviewed do not publish one fixed redemption fee`,
        );
    if (zeroQueuedFee) {
      config.docs = [
        ...config.docs!,
        sourceRef(
          "Nest protocol NestVaultCore fee source (reviewed 2026-10-03)",
          "https://github.com/plumenetwork/nest-protocol/blob/main/contracts/NestVaultCore.sol",
          ["fees"],
        ),
      ];
    }
    config.notes = [`Nest's current vault directory lists a ${ticker} redemption estimate of 4 days.`];
    return [id, config];
  }),
);
