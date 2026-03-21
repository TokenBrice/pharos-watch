import type { RedemptionBackstopConfig } from "./shared";
import { COLLATERAL_REDEEM_BACKSTOP_CONFIGS } from "./collateral-redeem";
import { OFFCHAIN_ISSUER_BACKSTOP_CONFIGS } from "./offchain-issuer";
import { PSM_AND_BASKET_BACKSTOP_CONFIGS } from "./psm-and-basket";
import { QUEUE_REDEEM_BACKSTOP_CONFIGS } from "./queue-redeem";
import { STABLECOIN_REDEEM_BACKSTOP_CONFIGS } from "./stablecoin-redeem";

export const REDEMPTION_BACKSTOP_CONFIGS: Record<string, RedemptionBackstopConfig> = {
  ...OFFCHAIN_ISSUER_BACKSTOP_CONFIGS,
  ...PSM_AND_BASKET_BACKSTOP_CONFIGS,
  ...COLLATERAL_REDEEM_BACKSTOP_CONFIGS,
  ...QUEUE_REDEEM_BACKSTOP_CONFIGS,
  ...STABLECOIN_REDEEM_BACKSTOP_CONFIGS,
};
