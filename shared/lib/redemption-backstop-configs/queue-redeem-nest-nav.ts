import { defineConfigFamily } from "./factory";
import type { RedemptionBackstopConfig } from "./shared";
import {
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

const NEST_NAV_VAULTS = [
  { id: "ntbill-nest", ticker: "nTBILL", outputAssets: ["usdc-circle", "pusd-plume"] },
  { id: "nbasis-nest", ticker: "nBASIS", outputAssets: ["usdc-circle", "pusd-plume"] },
  { id: "nopal-nest", ticker: "nOPAL", outputAssets: ["usdc-circle", "pusd-plume", "usdt-tether"] },
  { id: "nwisdom-nest", ticker: "nWISDOM", outputAssets: ["usdc-circle", "pusd-plume"] },
];

/** Vaults whose documented Plume USDC and pUSD NestVault paths both returned
 *  fees(2) = (flat 0, rate 0) at Plume block 97180152 (2026-10-03T23:12:23Z).
 *  The zero covers only the direct queued-redemption fee on those paths. */
const NEST_ZERO_QUEUED_FEE_VAULTS: Partial<Record<string, true>> = { "ntbill-nest": true, "nwisdom-nest": true };

export const NEST_NAV_VAULT_CONFIGS: Record<string, RedemptionBackstopConfig> = defineConfigFamily(
  NEST_NAV_VAULTS,
  ({ id, ticker, outputAssets }) => {
    const zeroQueuedFee = NEST_ZERO_QUEUED_FEE_VAULTS[id] === true;
    return {
      ...nestNavVaultBase,
      outputAssets,
      costModel: zeroQueuedFee
      ? fixedFee(
          0,
          `${ticker} NestVault fees(2) returned flat 0 and rate 0 on the documented Plume USDC and pUSD paths at Plume block 97180152 (2026-10-03); this zero covers only the direct queued-redemption fee, not transaction gas, optional bridge legs, or other chains`,
        )
      : undisclosedReviewedFee(
          `Nest docs describe ${ticker} redemptions through the Nest app; public materials reviewed do not publish one fixed redemption fee`,
        ),
      docs: [
        ...nestNavVaultBase.docs!,
        ...(zeroQueuedFee ? [
          sourceRef(
            "Nest protocol NestVaultCore fee source (reviewed 2026-10-03)",
            "https://github.com/plumenetwork/nest-protocol/blob/main/contracts/NestVaultCore.sol",
            ["fees"],
          ),
        ] : []),
      ],
      notes: [`Nest's current vault directory lists a ${ticker} redemption estimate of 4 days.`],
    };
  },
);
