# Chain Health Score Methodology - Version Timeline

Internal changelog reconstructed from the machine-readable methodology version source. Covers Chain Health Score `v1.0` through `v1.1` (both released 2026-03-16).

---

## v1.1 - Chain environment factor and weight rebalance (Mar 16, 2026)

**Commit:** `f6978ec`

- Added a fifth factor, `chainEnvironment`, scored from chain resilience tiers
- Rebalanced weights to `quality 30%`, `chainEnvironment 20%`, `concentration 20%`, `pegStability 20%`, `backingDiversity 10%`
- `CHAIN_ENVIRONMENT_SCORES` now map tier `1 -> 100`, `2 -> 60`, `3 -> 20`
- Reduced backing-diversity influence and penalized fragile chain environments directly in the composite

---

## v1.0 - Initial Chain Health Score release (Mar 16, 2026)

**Commit:** `003eafd`

- Introduced chain-level health scoring as a `0-100` composite
- Initial factors were `quality 35%`, `concentration 25%`, `pegStability 25%`, and `backingDiversity 15%`
- Added `GET /api/chains`, `/chains/`, and `/chains/[chain]/`
- Shipped the first health bands: `robust`, `healthy`, `mixed`, `fragile`, and `concentrated`

---

## Notes

- Canonical machine-readable source: `shared/lib/chain-health-version.ts`
- Current runtime weights and factor helpers live in `shared/lib/chain-health.ts`
