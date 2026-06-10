import { undisclosedReviewedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, REVIEWED_DIRECT_REDEMPTION_AT } from "./shared";

export const USN_NOON_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  accessModel: "whitelisted-onchain",
  capacityModel: { kind: "supply-ratio", ratio: 0.15 },
  costModel: undisclosedReviewedFee(
    "Noon documents 1:1 minting and redemption for approved users, but does not publish a fixed redemption fee",
  ),
  reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
  docs: [
    sourceRef(
      "Noon USN documentation",
      "https://docs.noon.capital/built-for-high-yields/our-stablecoin-usn-and-susn/return-generation",
      ["route", "capacity"],
    ),
    sourceRef("Noon smart contract audits", "https://docs.noon.capital/built-for-safety/smart-contract-audits", [
      "route",
      "access",
    ]),
    sourceRef("Noon Accountable dashboard", "https://noon.accountable.capital/", ["capacity"]),
  ],
  notes: [
    "Direct mint and redemption are reserved for approved primary-market users; current model does not treat Noon strategy collateral as a separately measured instant stablecoin buffer",
    "Because USN relies on delta-neutral exchange strategies rather than a pure cash-equivalent reserve bucket, the reviewed route keeps a conservative 15% immediate-capacity bound instead of scoring against full supply",
  ],
});
