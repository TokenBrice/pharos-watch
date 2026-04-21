# 2026-04-21 Archivist Documentation Verification — Loop 1

## Scope

Code was treated as source of truth. Five `gpt-5.4` / `xhigh` read-only subagents verified separate documentation slices:

- static frontend routes and public page contracts
- API, Worker, auth, cache, and operator docs
- data pipeline, pricing, supply, scripts, and testing docs
- methodology/scoring/taxonomy docs and public methodology copy
- monitoring/operations docs for blacklist, mint/burn, yield, digest, feedback, Telegram, reserves, and shadow assets

Local verification also ran route/API inventory checks and repo documentation guardrails.

## Issues Corrected

- Safety Score copy now describes four weighted base dimensions plus the peg-stability multiplier, not five weighted base dimensions.
- Resilience, Chain Health, PSI trend, dependency normalization, dependency type, effective-exit rounding, and governance-tier docs now match shared scoring code.
- About/API/coverage/stablecoin-detail route contracts now match current route behavior.
- Pricing-pipeline DEX admission and low-confidence consensus wording now matches primary price collection/selection code.
- Supply snapshot, stale-data banner coverage, validation command, discovery-candidate, and generated artifact docs now match source and package scripts.
- API reference edge cases now match router/method validation, public-status filtering order, PSI bootstrap/detail behavior, Telegram webhook auth handling, and dependency weight normalization.
- Worker/operator docs now match cron run status preservation, cron health rules, progress reporting, cache profiles, host split, and secret-rotation enforcement boundaries.
- Blacklist, mint/burn, yield operations, digest streaming, feedback migration, and Telegram secret docs now match current handlers, registries, migrations, and runtime helpers.

## Verification Commands

Passed:

- `npm run check:doc-counts`
- `npm run check:doc-source-paths`
- `npm run check:verified-doc-links`
- `npm run check:doc-sync`
- `npm run check:openapi`
- `npm run check:postman`
- `npm run check:llms-txt`
- `npm run typecheck`
- `npm run lint`

## Residual Notes

- Timeline effective-date and reconstructed git-history claims are not fully verifiable from current source alone; they require git history/release artifacts.
- A second verification loop should focus on deeper endpoint response-shape prose, older timeline entries, and public copy outside the named docs/pages.
