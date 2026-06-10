import {
  documentedBoundSupplyFull,
  fixedFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_YIELD_EXPANSION_AT } from "./shared";

export const SUSDD_TRON_DAO_RESERVE_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...documentedBoundSupplyFull(REVIEWED_YIELD_EXPANSION_AT),
  capacityModel: { kind: "reserve-sync-metadata" },
  executionModel: "rules-based-nav",
  costModel: fixedFee(0, "USDD docs describe sUSDD withdrawals to USDD with no lock-up or protocol fee"),
  docs: [
    sourceRef("USDD sUSDD mechanism", "https://docs.usdd.io/susdd-mechanism", ["route", "capacity", "fees", "access", "settlement"]),
    sourceRef("USDD savings guide", "https://docs.usdd.io/user-guide/usdd-savings", ["route"]),
  ],
  notes: [
    "sUSDD exits to USDD at the savings-vault exchange rate; downstream USDD par exit remains governed by the parent USDD route",
    "Fresh ERC-4626 reserve telemetry reads the vault's idle USDD balance as current direct wrapper capacity; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
  ],
};
