export const COMPOUND_V3_COMETS = [
  { stablecoinId: "usdc-circle", chain: "ethereum", comet: "0xc3d688B66703497DAA19211EEdff47f25384cdc3", symbol: "USDC" },
  { stablecoinId: "usdt-tether", chain: "ethereum", comet: "0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840", symbol: "USDT" },
  { stablecoinId: "usdc-circle", chain: "base", comet: "0xb125E6687d4313864e53df431d5425969c15Eb2F", symbol: "USDC" },
  { stablecoinId: "usdc-circle", chain: "arbitrum", comet: "0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA", symbol: "USDC" },
] as const;

// Verified Aave V3 reserves (aave-address-book AaveV3Ethereum/Arbitrum/Base,
// 2026-09-27). Match these identities against the active tracked inventory.
export const AAVE_V3_PINNED_RESERVES = [
  { stablecoinId: "usdc-circle", chain: "ethereum", assetAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
  { stablecoinId: "usdt-tether", chain: "arbitrum", assetAddress: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9" },
  { stablecoinId: "usdc-circle", chain: "base", assetAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
] as const;
