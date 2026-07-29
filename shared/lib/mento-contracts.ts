import { decodeAbiParameters } from "viem/utils";

// Mento V2 BiPoolManager on Celo; verified against forno.celo.org and
// docs.mento.org/mento/build-on-mento/smart-contracts/bipoolmanager (2026-07-09).
export const MENTO_BIPOOL_MANAGER_ADDRESS = "0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901";
export const MENTO_GET_EXCHANGE_IDS_SELECTOR = "0xdc162e36"; // getExchangeIds()
export const MENTO_GET_POOL_EXCHANGE_SELECTOR = "0x278488a4"; // getPoolExchange(bytes32)
// PoolConfig.spread is a Fixidity fraction with 24-decimal precision.
export const MENTO_POOL_SPREAD_FIXIDITY_SCALE = 10n ** 24n;

export const MENTO_POOL_EXCHANGE_ABI_PARAMETERS = [
  {
    type: "tuple",
    components: [
      { name: "asset0", type: "address" },
      { name: "asset1", type: "address" },
      { name: "pricingModule", type: "address" },
      { name: "bucket0", type: "uint256" },
      { name: "bucket1", type: "uint256" },
      { name: "lastBucketUpdate", type: "uint256" },
      {
        name: "config",
        type: "tuple",
        components: [
          { name: "spread", type: "uint256" },
          { name: "referenceRateFeedID", type: "address" },
          { name: "referenceRateResetFrequency", type: "uint256" },
          { name: "minimumReports", type: "uint256" },
          { name: "stablePoolResetSize", type: "uint256" },
        ],
      },
    ],
  },
] as const;

export interface MentoPoolExchange {
  asset0: `0x${string}`;
  asset1: `0x${string}`;
  pricingModule: `0x${string}`;
  bucket0: bigint;
  bucket1: bigint;
  lastBucketUpdate: bigint;
  config: {
    spread: bigint;
    referenceRateFeedID: `0x${string}`;
    referenceRateResetFrequency: bigint;
    minimumReports: bigint;
    stablePoolResetSize: bigint;
  };
}

export function decodeMentoPoolExchange(raw: `0x${string}`): MentoPoolExchange {
  const [decoded] = decodeAbiParameters(MENTO_POOL_EXCHANGE_ABI_PARAMETERS, raw) as readonly [MentoPoolExchange];
  return decoded;
}
