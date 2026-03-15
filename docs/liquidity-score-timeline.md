# Liquidity Score Methodology - Version Timeline

Internal changelog reconstructed from git history. Covers Liquidity Score `v1.0` through `v4.0` (2026-02-19 -> 2026-03-10).

---

## v4.0 - Log-scale volume, cross-chain removal, durability rebalance (Mar 10, 2026)

**Commit:** `unreleased`

- Volume activity moved from a linear scale to `33.3 * log10(vtRatio / 0.005)`, lifting mid-market scores without letting extreme churn dominate
- The cross-chain component was removed from the composite score, with its weight redistributed to TVL depth and pool quality
- Durability weights were rebalanced to `15% organic fraction`, `35% TVL stability`, `25% volume consistency`, and `25% maturity`
- Locked-liquidity was removed from durability because the discovery-stage data is not reliable enough to keep scoring it directly

---

## v3.4 - Retained-pool recomputation and trusted staged-price hardening (Mar 9, 2026)

**Commit:** `unreleased`

- Aggregate score inputs are now recomputed from the retained pool set after filtering and TVL caps, preventing dropped pools from leaking stale influence
- HHI now uses the full retained pool set before display truncation, and global 7d volume is deduped by physical pool
- Staged discovery merges now preserve raw DEX metadata and pool-quality multipliers while deduping against token-pair fingerprints
- DEX price observations require a consistent `$50K` post-confidence TVL floor across source families

---

## v3.3 - Separated discovery pipeline with staged pool confidence decay (Mar 9, 2026)

**Commit:** `unreleased`

- Discovery sources now run on a dedicated 30-minute cron with a 20-minute crawl budget instead of sharing a short scoring-run budget
- Staged pools merge into scoring with freshness confidence decay `max(0.5, 1 - ageHours/48)` and fall out after 24 hours
- Chain-aware source routing now skips irrelevant networks, reducing wasted crawl attempts
- Tiered priority with exponential backoff prevents repeated looping on pool-less coins

---

## v3.2 - Effective TVL symbol-fallback inflation fix (Mar 2, 2026)

**Commit:** `71cc096`

- Fixed effective TVL inflation when non-Curve pools matched Curve entries by symbol fallback
- Metapool-adjusted TVL now applies only to address-matched Curve pools
- Symbol-fallback pools keep their own TVL for effective TVL computation

---

## v3.1 - Anti-duplication and TVL cap normalization (Feb 28-Mar 1, 2026)

**Commits:** `0b6bfb8`, `617ab25`, `1224015`, `0e54c20`

- Added token-pair fingerprint deduplication across DeFiLlama and CG/GT/DS sources
- Added per-pool and protocol-level TVL caps anchored to DeFiLlama protocol ceilings
- Distributed protocol cap reductions into chain totals to keep global sums coherent

---

## v3.0 - Coverage expansion with fallback sources (Feb 28, 2026)

**Commits:** `6b2e006`, `ef9bb2b`

- Added DexScreener fallback for coins still at zero pools after primary crawl
- Added CoinGecko tickers fallback for orderbook-heavy assets (for example, KAU/KAG)
- Reduced false zero-liquidity outcomes for long-tail assets

---

## v2.2 - No-pool rows switched to NR semantics (Feb 27, 2026)

**Commit:** `06c6681`

- Coins without DEX pools now persist `liquidity_score = NULL` instead of `0`
- Daily liquidity snapshots for zero-pool coins also store `NULL`
- Allows downstream systems to distinguish not-rated from low-rated

---

## v2.1 - Onchain source upgrade + locked-liquidity durability term (Feb 25, 2026)

**Commits:** `361e240`, `4f6d9ed`

- Upgraded primary pool discovery to CoinGecko Onchain (with GT fallback)
- Added locked-liquidity input to durability
- Durability weights changed from `40/25/20/15` to `35/25/20/15/5`

---

## v2.0 - Six-component v2 model (Feb 19, 2026)

**Commit:** `0254445`

- Replaced the 5-component model with a 6-component model
- Weights changed from `35/25/20/10/10` to `30/20/20/15/7.5/7.5`
- Introduced effective TVL, durability decomposition, and component persistence

---

## v1.0 - Initial DEX liquidity release (Feb 19, 2026)

**Commits:** `a7ae273`, `443ac1b`, `f26fdf3`

- Initial DEX liquidity score pipeline shipped
- Initial component set: TVL depth, volume, pool quality, pair diversity, cross-chain
- API endpoint and dashboard integration launched

---

## Notes

- Liquidity methodology did not initially ship with explicit version tracking; versions above were assigned retroactively from score-impacting commit boundaries.
- Canonical windows for historical labeling are encoded in `shared/lib/liquidity-score-version.ts` and migration `worker/migrations/0036_liquidity_methodology_version.sql`.
