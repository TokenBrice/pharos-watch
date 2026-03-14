# 2026-03-14 Documentation Health Report — Pass 2

Second-pass audit focused on deeper coverage analysis, clarification quality, and live pricing-pipeline drift.

## Additional Findings Resolved

### Coverage gap filled

| File | Gap | Remediation |
|------|-----|-------------|
| `docs/pricing-pipeline.md` | Pricing Pipeline had become a versioned methodology surface with a public changelog route and `/methodology` section, but it still lacked a dedicated canonical `/docs` reference file | Added a standalone pricing-pipeline doc covering source weights, consensus rules, authoritative overrides, fallback enrichment, and provider-specific normalization |

### Clarifications added

| File | Clarification |
|------|---------------|
| `docs/data-pipeline.md` | Added provider-specific normalization notes for Pyth Hermes feed IDs, Coinbase symbol casing, RedStone exact-case allowlisting/batching/retry, and data-aware breaker accounting |
| `docs/README.md` | Added a public-route coverage map so route-first readers can quickly find the authoritative docs for `/blacklist/`, `/depeg/`, `/digest/`, `/flows/`, `/liquidity/`, `/safety-scores/`, `/stability-index/`, `/telegram/`, and `/yield/` |
| `docs/methodology-page.md` | Tightened the update contract so pricing-pipeline source changes explicitly require updating the pricing/data/about docs as well as the `/methodology` page |

## Notes

- This pass was driven by live uncommitted pricing-pipeline code changes in `worker/src/cron/enrich-prices.ts`, `worker/src/lib/pyth.ts`, and `worker/src/lib/redstone.ts`.
- No new broken internal links or missing file references were introduced; link and path checks were rerun after these additions.
