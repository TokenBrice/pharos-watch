import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const YIELD_METHODOLOGY_V3: readonly MethodologyChangelogEntry[] = [
  {
    version: "3.3",
    title: "Coverage ratchet: deterministic overrides + address-aware discovery",
    date: "2026-03-03",
    effectiveAt: 1772529534,
    summary:
      "Auto-discovered lending coverage expanded with stricter quality gates, deterministic overrides, and contract-address fallback matching for symbol drift.",
    impact: [
      "Auto-discovery added minimum APY/TVL filters and expanded protocol allowlist coverage",
      "Deterministic pool overrides introduced for hard-to-match symbols (including explicit safety bypass handling)",
      "findBestLendingPool now falls back to underlying token address matches when symbol matching fails",
      "Price-derived fallback explicitly extended to BUIDL when no usable on-chain or DL source exists",
    ],
    commits: ["d9bf617", "39f3f95", "2a45230", "ce2293d"],
    reconstructed: true,
  },
  {
    version: "3.2",
    title: "Inherited blacklistability alignment for inline safety scoring",
    date: "2026-03-02",
    effectiveAt: 1772459422,
    summary:
      "Yield sync safety scoring switched to shared blacklistability logic (including reserve inheritance), improving parity with report-card safety behavior.",
    impact: [
      "Resilience inputs in inline safety computation now use shared isBlacklistable() logic",
      "Risk penalties in PYS better reflect inherited blacklist exposure",
      "Reduced divergence between yield-page safety grades and safety-scores page outputs",
    ],
    commits: ["595f176"],
    reconstructed: true,
  },
  {
    version: "3.1",
    title: "Auto-discovery hardening and finite-math safeguards",
    date: "2026-03-01",
    effectiveAt: 1772386997,
    summary:
      "Post-launch hardening pass improved reliability of discovered yield rows and prevented non-finite volatility values from polluting persisted rankings.",
    impact: [
      "NAV tokens were included in inline safety scoring instead of defaulting to implicit NR behavior",
      "Yield sync now reuses cached DeFiLlama pools from DEX sync to reduce upstream fetch failures",
      "Non-finite 30-day APY volatility values are sanitized before D1 writes",
    ],
    commits: ["2e2a0aa", "9decd36", "4402307"],
    reconstructed: true,
  },
  {
    version: "3.0",
    title: "Automatic lending-opportunity discovery",
    date: "2026-03-01",
    effectiveAt: 1772380525,
    summary:
      "Yield Intelligence expanded beyond explicitly yield-bearing tokens by automatically discovering best lending pools for safer non-yield-bearing coins.",
    impact: [
      "Added allowlist-based auto-discovery pass over DeFiLlama lending pools",
      "Eligibility gated by safety score threshold before pool selection",
      "Introduced defillama-auto source type and lending-opportunity yield classification",
    ],
    commits: ["2b1a551"],
    reconstructed: true,
  },
];
