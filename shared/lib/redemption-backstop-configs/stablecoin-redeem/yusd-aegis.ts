import {
  documentedVariableFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_DIRECT_REDEMPTION_AT } from "./shared";

export const YUSD_AEGIS_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  accessModel: "whitelisted-onchain",
  capacityModel: { kind: "supply-ratio", ratio: 0.15 },
  costModel: documentedVariableFee("Aegis documents 1:1 minting and redemption for approved users, but does not publish a fixed redemption fee"),
  reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
  docs: [
    sourceRef("Aegis liquidity", "https://docs.aegis.im/overview/liquidity", ["route", "capacity", "access"]),
    sourceRef("Aegis FAQ", "https://docs.aegis.im/aegis-faq/how-can-i-get-my-earned-yusd", ["route"]),
    sourceRef("Aegis Accountable dashboard", "https://aegis.accountable.capital/", ["capacity"]),
  ],
  notes: [
    "Direct mint and redemption are reserved for approved primary-market users, while most secondary users access YUSD via DEX liquidity or supported venues",
    "Because YUSD relies on a delta-neutral BTC hedge rather than a pure cash-equivalent reserve bucket, the reviewed route keeps a conservative 15% immediate-capacity bound instead of scoring against full supply",
  ],
};
