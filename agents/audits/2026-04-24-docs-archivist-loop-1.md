# Documentation Archivist Loop 1

Date: 2026-04-24

Scope: verify the canonical documentation corpus against source code, with code as the source of truth. Covered `/docs`, `README.md`, the About page, the public Methodology page, and the API reference.

## Success Criteria

- Every corrected claim is traceable to code, generated data, or a checked repo guardrail.
- Corrections stay surgical and avoid unrelated copy rewrites.
- Public documentation, internal docs, and route-facing copy agree on behavior and counts.
- Loop 1 is committed and pushed before starting the next verification loop.

## Subagent Coverage

- Faraday (`019dbf22-9888-79c0-a59e-695dd94ed9f7`): API reference, public Worker endpoint contracts, cache/header claims.
- Wegener (`019dbf22-98b5-7c22-b951-2d4277c51071`): About page, methodology route, public route docs.
- Maxwell (`019dbf22-98eb-7b42-be62-e722c5abc36b`): methodology/scoring docs and public scoring explanations.
- Hilbert (`019dbf22-990d-7e63-92ec-02c02556231b`): worker infrastructure, cron docs, operational runbooks.
- Goodall (`019dbf22-993b-7271-a88e-a419e3fb3788`): data pipeline, reserve, shadow asset, blacklist, mint/burn, and report-card docs.
- Harvey (`019dbf22-995f-7082-855e-378124cf6ebb`): design, homepage, scripts, route-doc and agent-facing docs.

## Corrections Applied

- Replaced the About page hard-coded active-stablecoin count with a value derived from `getStablecoinCounts()`.
- Removed stale About-page M0 GraphQL infrastructure-source text and corrected the AI generation source wording.
- Aligned About-page docs with the current reference-module cards and source file paths.
- Corrected README and Worker Infrastructure cron descriptions for the split DEX-liquidity and stablecoin-chart schedule lanes.
- Corrected Worker Infrastructure docs for 18 configured cron expressions, 17 job-bearing schedule keys, exposed CORS headers, admin-auth return shape, and the digest trigger route.
- Corrected API Reference cache semantics for `/_site-data/*`: Pages Function caching requires no `Set-Cookie`, no `no-store`, and no stale `Warning: 110`; no-store endpoints are not cached.
- Added the missing Infrastructure Tagging source mapping to the Methodology page docs.
- Corrected design/page docs for Start desktop order, Home `h1` ownership, alt-peg client order, and the retired homepage bond-maturity filter option.
- Removed a nonexistent `CHART_CYAN` token from Design Tokens.
- Added missing script inventory rows and CI notes for `run-dev-api-proxy.mjs`, `generate-stablecoin-per-coin-asset.ts`, and `run-node-lts-validation.mjs`.
- Corrected feedback auto-verification docs to use the normalized stablecoins cache payload rather than a raw DefiLlama payload claim.
- Corrected Live Reserves freshness semantics for multi-row feeds and the 12-minute outer lease versus the 11-minute cursoring budget.
- Corrected Data Pipeline cluster tie-break order.
- Added missing shadow-asset usage references for DEWS backfill and PSI history universe code paths.
- Removed stale blacklist-version phrasing while preserving live v3.98 API examples.
- Corrected report-card snapshot math to 204 active tracked assets plus 88 cemetery entries.
- Corrected DEX Liquidity Pool Quality docs: the score-retention component uses mechanism and balance-health retention, while pair quality affects effective TVL and pool stress.
- Corrected public Methodology route copy for DEWS sub-signals, LiquidityScore weights, LiquidityScore NR behavior, and the Safety Score worked example.
- Corrected Mint/Burn docs to the current 140 configs, 139 IDs, 7 critical defaults, and 133 extended configs.
- Corrected Architecture cron-budget wording to the current 17 job-bearing schedule keys in `CRON_JOB_DEFINITIONS`.

## Rejected Or Already Current Findings

- Report-card timeline missing-version claim was rejected. `docs/report-cards-timeline.md` already contains the checked v5.9/v5.1/v4.1/v3.3/v3.2 entries.
- Blacklist API examples with `currentVersion: "3.98"` were preserved. They match the current blacklist methodology version used by the API examples.
- Digest docs mentioning `claude-opus-4-7`, adaptive thinking, and `xhigh` were preserved. `worker/src/cron/digest/platform.ts`, `daily-digest.ts`, and `weekly-recap.ts` confirm the current model contract.
- `force=true` references in digest docs and Worker Infrastructure were preserved. The trigger path and scheduled poll still use forced daily-digest regeneration semantics.

## Loop 2 Focus

- Evaluate `docs/superpowers/**`. These files look like agent plans/specs under `/docs`, while AGENTS.md says generated plans, audits, research, and process notes belong in `/agents/`.
- Re-check the public docs allowlist and markdown export path, especially `shared/lib/public-docs.ts`, `src/app/docs/**`, and `scripts/generate-markdown-exports.ts`.
- Go deeper on documentation not heavily touched by loop 1: privacy, funding, portfolio, coverage, chains, status, operator-origin, and release/deploy docs.
- Sweep route-visible methodology/API examples for hard-coded numeric counts and versions after loop-1 patches land.
