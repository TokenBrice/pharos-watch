/**
 * Canonical coin IDs by archetype for detail-page test coverage.
 *
 * Use these instead of inline string literals so future archetype additions
 * propagate without touching individual test files. Each key represents a
 * distinct detail-page shape that exercises a separate code path:
 *
 *   - bluechip:    Tier-1 fiat-backed USD anchor (USDC)
 *   - largeCefi:   Largest centralized USD issuer (USDT)
 *   - cdp:         Decentralized CDP-backed (DAI)
 *   - synthetic:   Delta-neutral synthetic dollar (USDe)
 *   - variant:     Yield-bearing wrapper of a parent coin (sUSDe wraps USDe)
 *   - algorithmic: Algorithmic / partially-collateralized model (USDD)
 *   - nonUsd:      Non-USD peg (EURC, EUR)
 *   - navToken:    NAV / RWA token classification (USDY)
 *   - sparse:      Mid-cap with sparse blacklist + flow signal (FDUSD)
 *   - frozen:      Status === "frozen" with obituary (USR-Resolv)
 *   - midSupply:   Below-floor or recent-launch low supply that may surface
 *                  the limited-depeg-coverage note (CADD)
 */
export const ARCHETYPE_COINS = {
  bluechip: "usdc-circle",
  largeCefi: "usdt-tether",
  cdp: "dai-makerdao",
  synthetic: "usde-ethena",
  variant: "susde-ethena",
  algorithmic: "usdd-tron-dao-reserve",
  nonUsd: "eurc-circle",
  navToken: "usdy-ondo-finance",
  sparse: "fdusd-first-digital",
  frozen: "usr-resolv",
  midSupply: "cadd-cad-digital",
} as const;

export type Archetype = keyof typeof ARCHETYPE_COINS;
