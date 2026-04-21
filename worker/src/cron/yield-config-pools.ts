export const YIELD_POOL_MAP: Record<string, string> = {
  // USDe (sUSDe) - ethena-usde native staking, Ethereum, $3.5B TVL, ~3.6% APY
  "usde-ethena": "66985a81-9c51-46ca-9977-42b4fe7bc6df",
  // USYC - ondo-yield-assets (listed as USDYC), Ethereum, $602M TVL, ~3.6% APY
  "usyc-hashnote": "ee457473-3b5f-4b53-8c8a-fde6b2e16c8a",
  // USDY - ondo-yield-assets native, Ethereum, $149M TVL, ~3.6% APY
  "usdy-ondo-finance": "ac61ee82-2fe4-4f9b-a9cd-7fb33f598859",
  // BUIDL (173) - no DL pool; Blackrock/Securitize fund not tracked by DL Yields
  // YLDS (272) - no DL pool; Figure Markets not tracked by DL Yields
  // reUSD -> stUSR - resolv native staking, Ethereum, $109M TVL, ~0.6% APY
  "reusd-re-protocol": "0aedb3f6-9298-49de-8bb0-2f611a4df784",
  // TBILL - openeden-tbill native, Ethereum, $27M TVL, ~3.0% APY
  "tbill-openeden": "e140f3b2-0327-46ea-93f5-88b17b0a0a16",
  // YUSD - aegis native, Ethereum, $36M TVL, ~5.7% APY
  "yusd-aegis": "f91b2168-c279-475c-a98a-673220f4fee7",
  // USDB (172) - no native DL pool; Blast native yield is not tracked by DL Yields
  // AZND -> loAZND - mu-digital native, Monad, $7.4M TVL, ~6.7% APY
  "aznd-mu-digital": "0a05f2ee-e182-476a-9cdc-2fed86fcd765",
  // OUSD - origin-dollar native, Ethereum, $7M TVL, ~5.4% APY
  "ousd-origin-protocol": "529258ee-9b27-4fcf-a32c-b82abb3fda68",
  // USP - merkl pool, Ethereum, $12M TVL, ~23.5% APY
  "usp-pikudao": "2fb2f840-9be7-4de9-b29a-ea928205c476",
  // syrupUSDC - maple native USDC pool, Ethereum, $3.2B TVL, ~4.6% APY
  //             (syrupUSDC is the yield wrapper for USDC deposits into Maple)
  "syrupusdc-maple": "43641cf5-a92e-416b-bce9-27113d3c0db6",
  // syrupUSDT - maple native USDT pool, Ethereum, $1.4B TVL, ~4.4% APY
  //             (syrupUSDT is the yield wrapper for USDT deposits into Maple)
  "syrupusdt-maple": "8edfdf02-cdbb-43f7-bca6-954e5fe56813",
  // yoUSD - pendle SY yield token, Base, $1.3M TVL, ~8.0% APY
  "yousd-yield-optimizer": "c7c9e2c5-a3ea-4e6e-80d7-090fd2d604c5",
  // bUSD0 - usual-usd0 liquid bond, Ethereum, $500M+ TVL, ~3.3% APY
  "busd0-usual": "55b0893b-1dbb-47fd-9912-5e439cd3d511",
  // ── Wave 1: Native yield coins (C+ or above) ─────────────────────
  // USDS -> sUSDS - sky-lending, Ethereum, $5.3B TVL, ~4.0% APY
  "usds-sky": "d8c4eff5-c8a9-46fc-a888-057c4c668e72",
  // GHO -> sGHO - aave-v3 staking, Ethereum, $266M TVL, ~5.3% APY
  "gho-aave": "ff2a68af-030c-4697-b0a1-b62a738eaef0",
  // DAI -> sDAI - sdai native, Gnosis, $86M TVL, ~5.5% APY
  "dai-makerdao": "13392973-be6e-4b2f-bce9-4f7dd53d1c3a",
  // crvUSD -> scrvUSD - crvusd native savings, Ethereum, $40M TVL, ~6.7% APY
  "crvusd-curve": "5fd328af-4203-471b-bd16-1705c726d926",
  // FRXUSD -> sfrxUSD - frax native staking, Ethereum, $26M TVL, ~4.3% APY
  "frxusd-frax": "42523cca-14b0-44f6-95fb-4781069520a5",
  // DOLA -> sDOLA - inverse-finance-firm, Ethereum, $14M TVL, ~4.3% APY
  "dola-inverse-finance": "bf0f95c9-bc46-467d-9762-1d80ff50cd74",
  // BOLD -> yBOLD - yearn-finance vault, Ethereum, $4.5M TVL, ~9.8% APY
  "bold-liquity": "4c29f645-12db-461f-a1d7-16900d624271",
  // ZCHF - frankencoin native savings (no wrapper), Ethereum, $7.1M TVL, ~3.8% APY
  "zchf-frankencoin": "8b427366-7bfb-4c61-88be-8dc004fdc3da",
  // fxUSD - fx-protocol Stability Pool, Ethereum, $33.9M TVL, ~4.0% APY
  //         (DL symbol is FXUSDSTABILITYPOOLV2.0, not fxUSD — must use static map)
  "fxusd-f-x-protocol": "abd6c9e1-3b52-459a-a31b-9022a4dcf7e2",
  // ── Stablewatch Wave 1: New wrapper pools ─────────────────────────
  // infiniFi USD -> siUSD - infinifi native savings, Ethereum, $121M TVL, ~4.8% APY
  "iusd-infinifi": "8fa2e60e-365a-41fc-8d50-fadde5041f94",
  // Falcon USD -> sUSDf - falcon-finance native savings, Ethereum, $87M TVL, ~5.9% APY
  "usdf-falcon": "0f67a08c-3f24-4a4b-963e-541f5a5c0364",
  // Unitas -> sUSDu - unitas native savings, Solana, $49M TVL, ~12.9% APY
  "usdu-unitas": "7f980c43-5b87-4690-a11a-b0e8a5e37a63",
  // GAIB sAID - gaib native savings, Ethereum, $15M TVL, ~10.5% APY
  "said-gaib": "e575606e-5642-4f87-b9ad-3e53d6f83c82",
  // OUSG - ondo-yield-assets native, Ethereum, $519M TVL, ~3.1% APY
  "ousg-ondo-finance": "7436db9b-2872-46c8-81a2-da6baff902b7",
  // sUSDai - usd-ai native savings, Arbitrum, $217M TVL, ~7.7% APY
  "susdai-usd-ai": "712ce948-bd9e-4f4a-8916-b72c447f7578",
  // wsrUSD - reservoir-protocol native, Ethereum, $159M TVL, ~4.8% APY
  "wsrusd-reservoir": "d646f32f-d5af-4e34-a29f-8ebeea6a8520",
  // avUSD -> savUSD - merkl HOLD pool, Avalanche, $72M TVL, APY via on-chain rate
  "avusd-avant": "2fe112ff-95a5-4ba0-8ee3-a741e6a8f7c9",
  // Neutrl USD -> sNUSD - pendle PT-buying pool, Ethereum, $41M TVL, ~7.5% APY
  "nusd-neutrl": "0f38d9a4-8e34-4abc-b9ba-25f326ef7828",
  // Main Street msY - mainstreet native pool, Ethereum, $50M+ TVL, ~12.0% APY
  "msy-main-street": "8a28570f-2316-488a-94a7-67c87e76c1f1",
  // Yuzu USD -> syzUSD - yuzu-money native savings, Plasma, $28M TVL, ~7.3% APY
  "yzusd-yuzu": "6174b1d6-8212-4964-95bf-ca9c539864ba",
  // Noon USN -> sUSN - morpho-v1 collateral, Ethereum, $10M TVL, APY via on-chain rate
  "usn-noon": "a18a761b-49cd-416d-8342-839cac722094",
  // Cap stcUSD - cap native staking, Ethereum, $90M+ TVL, ~5.9% APY
  "stcusd-cap": "bf6ca887-e357-49ec-8031-0d1a6141c455",
};
