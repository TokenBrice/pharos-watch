# Documentation Audit Report

**Date:** March 5, 2026
**Trigger:** Post-refactoring documentation accuracy review
**Scope:** 212 documentation artifacts (root docs, canonical docs, process/runbook docs, historical plans/research/tasks, and inline comments/docstrings in code)

## Executive Summary
The documentation set was generally current at a high level, but the recent shared-boundary refactor introduced concentrated drift in cross-file path references and contributor instructions. The primary issue pattern was stale references to modules moved from `src/lib/*` to `shared/lib/*`, plus a few behavior-level mismatches (most notably API method-gating coverage for depeg-audit dry runs).

This audit corrected all code-verifiable inaccuracies found in active/canonical documentation, removed stale inline TODO debt, and added missing contract coverage where the API surface had evolved. Verification passed end-to-end with `npm run build`, `npm run lint`, `npm test`, and `cd worker && npx tsc --noEmit`.

Historical plan/research/task artifacts were treated as archival snapshots (non-canonical by design) and retained; they are now explicitly represented in the inventory map so teams can distinguish canonical docs from historical records during future audits.

## Documentation Map
Detailed phase-1 mapping metadata (file format, apparent ownership, doc last-modified date, mapped code references, and mapped code last-modified date) is recorded in:

- `docs/documentation-map-2026-03-05.tsv`

Highest-risk stale docs before this audit (active docs that described refactored code paths but still used pre-refactor module locations):

| Document | Reason flagged before audit |
|----------|-----------------------------|
| `AGENTS.md` | Core contributor instructions still referenced moved `src/lib/*` shared modules and retired routes |
| `CLAUDE.md` | Same shared-boundary drift + brittle endpoint count references |
| `docs/process/adding-a-stablecoin.md` | Contributor SOP pointed to moved module paths for stablecoin/chains edits |
| `docs/api-reference.md` | Method-gating coverage omitted explicit GET dry-run contract path for `/api/audit-depeg-history` |
| `docs/yield-intelligence.md` | Referenced non-existent test file path after test-suite restructuring |

## Documentation Inventory
| Document | Path | Describes | Status Before Audit |
|----------|------|-----------|-------------------|
| AGENTS.md | AGENTS.md | Agent operating instructions for contributors | ❌ Significantly outdated |
| CLAUDE.md | CLAUDE.md | Alternative agent operating instructions | ❌ Significantly outdated |
| README.md | README.md | Project overview, setup, architecture, deployment | ⚠ Partially stale |
| api-reference.md | docs/api-reference.md | Public/admin API contracts, caching, errors | ❌ Significantly outdated |
| architecture.md | docs/architecture.md | Repository structure and endpoint map | ✅ Accurate |
| blacklist-tracker-timeline.md | docs/blacklist-tracker-timeline.md | Methodology/version timeline history | ⚠ Partially stale |
| blacklist-tracker.md | docs/blacklist-tracker.md | Documentation artifact | ✅ Accurate |
| cemetery-and-compare.md | docs/cemetery-and-compare.md | Documentation artifact | ⚠ Partially stale |
| classification.md | docs/classification.md | Stablecoin classification and peg handling | ⚠ Partially stale |
| data-flow-map.md | docs/data-flow-map.md | End-to-end source→cron→DB→API→frontend flows | ✅ Accurate |
| data-pipeline.md | docs/data-pipeline.md | Stablecoin sync and price enrichment pipeline | ✅ Accurate |
| depeg-detection.md | docs/depeg-detection.md | Depeg detection and confirmation flow | ⚠ Partially stale |
| depeg-dews-timeline.md | docs/depeg-dews-timeline.md | Methodology/version timeline history | ⚠ Partially stale |
| dependency-map.md | docs/dependency-map.md | Documentation artifact | ⚠ Partially stale |
| deployment-process.md | docs/deployment-process.md | Deployment workflow and merge gates | ✅ Accurate |
| design-language.md | docs/design-language.md | Documentation artifact | ✅ Accurate |
| design-tokens.md | docs/design-tokens.md | Documentation artifact | ✅ Accurate |
| dews.md | docs/dews.md | DEWS formula and signal model | ⚠ Partially stale |
| dex-liquidity.md | docs/dex-liquidity.md | Liquidity scoring pipeline and model | ⚠ Partially stale |
| digest-pipeline.md | docs/digest-pipeline.md | Daily digest generation and distribution | ✅ Accurate |
| feedback-pipeline.md | docs/feedback-pipeline.md | Feedback API and GitHub routing | ✅ Accurate |
| liquidity-score-timeline.md | docs/liquidity-score-timeline.md | Methodology/version timeline history | ⚠ Partially stale |
| methodology-page.md | docs/methodology-page.md | Methodology page source mapping contract | ⚠ Partially stale |
| mint-burn-flows-timeline.md | docs/mint-burn-flows-timeline.md | Methodology/version timeline history | ⚠ Partially stale |
| mint-burn-flows.md | docs/mint-burn-flows.md | Mint/burn ingestion and scoring | ✅ Accurate |
| 2026-02-28-spiritual-page-design-ideas.md | docs/plans/2026-02-28-spiritual-page-design-ideas.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-05-two-phase-simplification-and-decoupling-implementation-plan.md | docs/plans/2026-03-05-two-phase-simplification-and-decoupling-implementation-plan.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| README.md | docs/plans/README.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-01-grade-history.md | docs/plans/future/2026-03-01-grade-history.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-03-probabilistic-crisis-simulator-design.md | docs/plans/future/2026-03-03-probabilistic-crisis-simulator-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-03-telegram-bot-alert-subscriptions-mvp-reference.md | docs/plans/future/2026-03-03-telegram-bot-alert-subscriptions-mvp-reference.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-04-flow-intensity-signed-baseline-implementation.md | docs/plans/future/2026-03-04-flow-intensity-signed-baseline-implementation.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-24-cemetery-epitaphs-design.md | docs/plans/implemented/2026-02-24-cemetery-epitaphs-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-24-compare-improvements-design.md | docs/plans/implemented/2026-02-24-compare-improvements-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-24-compare-improvements.md | docs/plans/implemented/2026-02-24-compare-improvements.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-24-compare-share-design.md | docs/plans/implemented/2026-02-24-compare-share-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-24-compare-share.md | docs/plans/implemented/2026-02-24-compare-share.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-24-report-cards-design.md | docs/plans/implemented/2026-02-24-report-cards-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-25-coingecko-onchain-impl.md | docs/plans/implemented/2026-02-25-coingecko-onchain-impl.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-25-coingecko-onchain-migration-design.md | docs/plans/implemented/2026-02-25-coingecko-onchain-migration-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-25-depeg-validation-design.md | docs/plans/implemented/2026-02-25-depeg-validation-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-25-depeg-validation-impl.md | docs/plans/implemented/2026-02-25-depeg-validation-impl.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-25-portfolio-stress-test-design.md | docs/plans/implemented/2026-02-25-portfolio-stress-test-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-25-portfolio-stress-test-impl.md | docs/plans/implemented/2026-02-25-portfolio-stress-test-impl.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-25-psi-current-deviation-fix.md | docs/plans/implemented/2026-02-25-psi-current-deviation-fix.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-25-psi-dedup-depreciation-design.md | docs/plans/implemented/2026-02-25-psi-dedup-depreciation-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-25-psi-dedup-depreciation-impl.md | docs/plans/implemented/2026-02-25-psi-dedup-depreciation-impl.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-25-psi-lighthouse-design.md | docs/plans/implemented/2026-02-25-psi-lighthouse-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-25-psi-lighthouse-plan.md | docs/plans/implemented/2026-02-25-psi-lighthouse-plan.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-25-psi-marketcap-overlay-design.md | docs/plans/implemented/2026-02-25-psi-marketcap-overlay-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-25-psi-marketcap-overlay-impl.md | docs/plans/implemented/2026-02-25-psi-marketcap-overlay-impl.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-25-psi-page-design.md | docs/plans/implemented/2026-02-25-psi-page-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-25-psi-page-plan.md | docs/plans/implemented/2026-02-25-psi-page-plan.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-25-report-cards-impl.md | docs/plans/implemented/2026-02-25-report-cards-impl.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-25-stability-index-design.md | docs/plans/implemented/2026-02-25-stability-index-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-25-stability-index-plan.md | docs/plans/implemented/2026-02-25-stability-index-plan.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-26-dependency-map-page-design.md | docs/plans/implemented/2026-02-26-dependency-map-page-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-26-dependency-map-page.md | docs/plans/implemented/2026-02-26-dependency-map-page.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-26-design-tier1-quick-wins.md | docs/plans/implemented/2026-02-26-design-tier1-quick-wins.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-26-design-tier2-structural.md | docs/plans/implemented/2026-02-26-design-tier2-structural.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-26-design-tier3-strategic.md | docs/plans/implemented/2026-02-26-design-tier3-strategic.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-26-digest-snapshot-design.md | docs/plans/implemented/2026-02-26-digest-snapshot-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-26-ga-event-tracking-design.md | docs/plans/implemented/2026-02-26-ga-event-tracking-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-26-ga-event-tracking.md | docs/plans/implemented/2026-02-26-ga-event-tracking.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-26-hero-card-polish-design.md | docs/plans/implemented/2026-02-26-hero-card-polish-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-26-hero-card-polish-impl.md | docs/plans/implemented/2026-02-26-hero-card-polish-impl.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-26-hero-redesign-impl.md | docs/plans/implemented/2026-02-26-hero-redesign-impl.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-26-hero-redesign.md | docs/plans/implemented/2026-02-26-hero-redesign.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-26-homepage-feature-cards-design.md | docs/plans/implemented/2026-02-26-homepage-feature-cards-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-26-homepage-feature-cards-impl.md | docs/plans/implemented/2026-02-26-homepage-feature-cards-impl.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-26-kill-peg-tracker-page.md | docs/plans/implemented/2026-02-26-kill-peg-tracker-page.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-26-portfolio-page.md | docs/plans/implemented/2026-02-26-portfolio-page.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-26-portfolio-stress-split-design.md | docs/plans/implemented/2026-02-26-portfolio-stress-split-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-26-portfolio-stress-split.md | docs/plans/implemented/2026-02-26-portfolio-stress-split.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-26-resilience-redesign-impl.md | docs/plans/implemented/2026-02-26-resilience-redesign-impl.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-26-resilience-redesign.md | docs/plans/implemented/2026-02-26-resilience-redesign.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-26-risk-lab-cleanup-design.md | docs/plans/implemented/2026-02-26-risk-lab-cleanup-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-26-risk-lab-cleanup.md | docs/plans/implemented/2026-02-26-risk-lab-cleanup.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-26-ui-polish-design.md | docs/plans/implemented/2026-02-26-ui-polish-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-26-ui-polish-implementation.md | docs/plans/implemented/2026-02-26-ui-polish-implementation.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-26-upstream-exposure-reserves-design.md | docs/plans/implemented/2026-02-26-upstream-exposure-reserves-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-26-upstream-exposure-reserves.md | docs/plans/implemented/2026-02-26-upstream-exposure-reserves.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-27-audit-immediate-impl.md | docs/plans/implemented/2026-02-27-audit-immediate-impl.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-27-audit-immediate.md | docs/plans/implemented/2026-02-27-audit-immediate.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-27-audit-short-term-impl.md | docs/plans/implemented/2026-02-27-audit-short-term-impl.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-27-audit-short-term.md | docs/plans/implemented/2026-02-27-audit-short-term.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-27-audit-strategic.md | docs/plans/implemented/2026-02-27-audit-strategic.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-27-dependency-map-visual-fidelity-design.md | docs/plans/implemented/2026-02-27-dependency-map-visual-fidelity-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-27-dependency-map-visual-fidelity.md | docs/plans/implemented/2026-02-27-dependency-map-visual-fidelity.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-27-dependency-type-ceiling-design.md | docs/plans/implemented/2026-02-27-dependency-type-ceiling-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-27-dependency-type-ceiling.md | docs/plans/implemented/2026-02-27-dependency-type-ceiling.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-27-dynamic-fx-price-bounds-design.md | docs/plans/implemented/2026-02-27-dynamic-fx-price-bounds-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-27-dynamic-fx-price-bounds.md | docs/plans/implemented/2026-02-27-dynamic-fx-price-bounds.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-27-feedback-pipeline-design.md | docs/plans/implemented/2026-02-27-feedback-pipeline-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-27-feedback-pipeline.md | docs/plans/implemented/2026-02-27-feedback-pipeline.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-27-reserve-derived-collateral-quality-design.md | docs/plans/implemented/2026-02-27-reserve-derived-collateral-quality-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-27-reserve-derived-collateral-quality.md | docs/plans/implemented/2026-02-27-reserve-derived-collateral-quality.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-27-reserve-tier-migration-log.md | docs/plans/implemented/2026-02-27-reserve-tier-migration-log.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-27-reserves-ai-research.md | docs/plans/implemented/2026-02-27-reserves-ai-research.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-27-reserves-default-templates.md | docs/plans/implemented/2026-02-27-reserves-default-templates.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-27-reserves-manual-curation.md | docs/plans/implemented/2026-02-27-reserves-manual-curation.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-27-safety-score-peg-multiplier-design.md | docs/plans/implemented/2026-02-27-safety-score-peg-multiplier-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-28-audit-remediation.md | docs/plans/implemented/2026-02-28-audit-remediation.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-28-contract-enrich-design.md | docs/plans/implemented/2026-02-28-contract-enrich-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-28-contract-enrich-plan.md | docs/plans/implemented/2026-02-28-contract-enrich-plan.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-28-contract-populate-design.md | docs/plans/implemented/2026-02-28-contract-populate-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-28-contract-populate-plan.md | docs/plans/implemented/2026-02-28-contract-populate-plan.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-28-deployment-model-batch-handover.md | docs/plans/implemented/2026-02-28-deployment-model-batch-handover.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-28-digest-broadsheet-design.md | docs/plans/implemented/2026-02-28-digest-broadsheet-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-28-digest-broadsheet-plan.md | docs/plans/implemented/2026-02-28-digest-broadsheet-plan.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-28-grade-threshold-adjustments.md | docs/plans/implemented/2026-02-28-grade-threshold-adjustments.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-28-kag-mcap-fix-design.md | docs/plans/implemented/2026-02-28-kag-mcap-fix-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-28-kag-mcap-fix.md | docs/plans/implemented/2026-02-28-kag-mcap-fix.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-28-liquidity-coverage-expansion-design.md | docs/plans/implemented/2026-02-28-liquidity-coverage-expansion-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-28-liquidity-coverage-expansion.md | docs/plans/implemented/2026-02-28-liquidity-coverage-expansion.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-28-multichain-risk-design.md | docs/plans/implemented/2026-02-28-multichain-risk-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-28-multichain-risk-plan.md | docs/plans/implemented/2026-02-28-multichain-risk-plan.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-28-reserve-derived-dependencies-design.md | docs/plans/implemented/2026-02-28-reserve-derived-dependencies-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-28-reserve-derived-dependencies-plan.md | docs/plans/implemented/2026-02-28-reserve-derived-dependencies-plan.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-28-status-page-overhaul-design.md | docs/plans/implemented/2026-02-28-status-page-overhaul-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-28-status-page-overhaul.md | docs/plans/implemented/2026-02-28-status-page-overhaul.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-28-telegram-channel-design.md | docs/plans/implemented/2026-02-28-telegram-channel-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-02-28-telegram-channel.md | docs/plans/implemented/2026-02-28-telegram-channel.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-01-depeg-early-warning.md | docs/plans/implemented/2026-03-01-depeg-early-warning.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-01-depeg-tracker-page-design.md | docs/plans/implemented/2026-03-01-depeg-tracker-page-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-01-depeg-tracker-page.md | docs/plans/implemented/2026-03-01-depeg-tracker-page.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-01-mint-burn-audit-fixes.md | docs/plans/implemented/2026-03-01-mint-burn-audit-fixes.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-01-mint-burn-flow-tracker.md | docs/plans/implemented/2026-03-01-mint-burn-flow-tracker.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-01-mobile-menu-redesign-design.md | docs/plans/implemented/2026-03-01-mobile-menu-redesign-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-01-mobile-menu-redesign.md | docs/plans/implemented/2026-03-01-mobile-menu-redesign.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-01-test-suite-upgrade-design.md | docs/plans/implemented/2026-03-01-test-suite-upgrade-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-01-test-suite-upgrade.md | docs/plans/implemented/2026-03-01-test-suite-upgrade.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-01-yield-coverage-wave1-design.md | docs/plans/implemented/2026-03-01-yield-coverage-wave1-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-01-yield-coverage-wave1.md | docs/plans/implemented/2026-03-01-yield-coverage-wave1.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-01-yield-coverage-wave2-design.md | docs/plans/implemented/2026-03-01-yield-coverage-wave2-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-01-yield-coverage-wave2.md | docs/plans/implemented/2026-03-01-yield-coverage-wave2.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-01-yield-intelligence.md | docs/plans/implemented/2026-03-01-yield-intelligence.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-02-dews-radar-inversion-design.md | docs/plans/implemented/2026-03-02-dews-radar-inversion-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-02-dews-radar-inversion.md | docs/plans/implemented/2026-03-02-dews-radar-inversion.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-02-dews-radar-plan.md | docs/plans/implemented/2026-03-02-dews-radar-plan.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-02-dews-radar-redesign.md | docs/plans/implemented/2026-03-02-dews-radar-redesign.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-02-dews-telegram-alerts-design.md | docs/plans/implemented/2026-03-02-dews-telegram-alerts-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-02-dews-telegram-alerts.md | docs/plans/implemented/2026-03-02-dews-telegram-alerts.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-02-feature-status-badge-design.md | docs/plans/implemented/2026-03-02-feature-status-badge-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-02-feature-status-badge.md | docs/plans/implemented/2026-03-02-feature-status-badge.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-02-inherited-blacklist-risk-design.md | docs/plans/implemented/2026-03-02-inherited-blacklist-risk-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-02-inherited-blacklist-risk.md | docs/plans/implemented/2026-03-02-inherited-blacklist-risk.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-02-portfolio-upstream-categorization-design.md | docs/plans/implemented/2026-03-02-portfolio-upstream-categorization-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-02-portfolio-upstream-categorization.md | docs/plans/implemented/2026-03-02-portfolio-upstream-categorization.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-02-sync-mint-burn-alchemy-migration-plan.md | docs/plans/implemented/2026-03-02-sync-mint-burn-alchemy-migration-plan.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-02-sync-mint-burn-alchemy-migration.md | docs/plans/implemented/2026-03-02-sync-mint-burn-alchemy-migration.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-02-three-phase-refinement-design.md | docs/plans/implemented/2026-03-02-three-phase-refinement-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-02-three-phase-refinement-plan.md | docs/plans/implemented/2026-03-02-three-phase-refinement-plan.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-03-audit-findings-remediation-plan.md | docs/plans/implemented/2026-03-03-audit-findings-remediation-plan.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-03-coverage-ratchet-and-hotspots-implementation-plan.md | docs/plans/implemented/2026-03-03-coverage-ratchet-and-hotspots-implementation-plan.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-03-dashboard-refinement-implementation-plan.md | docs/plans/implemented/2026-03-03-dashboard-refinement-implementation-plan.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-03-multi-source-yield-design.md | docs/plans/implemented/2026-03-03-multi-source-yield-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-03-multi-source-yield-wrappers.md | docs/plans/implemented/2026-03-03-multi-source-yield-wrappers.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-03-reliability-maintainability-resilience-refinement-plan.md | docs/plans/implemented/2026-03-03-reliability-maintainability-resilience-refinement-plan.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-03-reliability-refinement-implementation-prep.md | docs/plans/implemented/2026-03-03-reliability-refinement-implementation-prep.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-03-runtime-neutral-reliability-gates-plan.md | docs/plans/implemented/2026-03-03-runtime-neutral-reliability-gates-plan.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-03-unified-trust-ux-refinement-plan.md | docs/plans/implemented/2026-03-03-unified-trust-ux-refinement-plan.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-03-wsrusd-resurrection-design.md | docs/plans/implemented/2026-03-03-wsrusd-resurrection-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-03-wsrusd-resurrection.md | docs/plans/implemented/2026-03-03-wsrusd-resurrection.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-04-maintainability-audit-remediation-implementation-plan.md | docs/plans/implemented/2026-03-04-maintainability-audit-remediation-implementation-plan.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-04-simplification-tier1-tier2-implementation-plan.md | docs/plans/implemented/2026-03-04-simplification-tier1-tier2-implementation-plan.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-04-simplification-tier3-independent-implementation-plan.md | docs/plans/implemented/2026-03-04-simplification-tier3-independent-implementation-plan.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-04-simplification-unified-tier1-tier2-tier3-implementation-plan.md | docs/plans/implemented/2026-03-04-simplification-unified-tier1-tier2-tier3-implementation-plan.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-04-status-reliability-hardening.md | docs/plans/implemented/2026-03-04-status-reliability-hardening.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-04-sync-mint-burn-reliability-remediation-tasklist.md | docs/plans/implemented/2026-03-04-sync-mint-burn-reliability-remediation-tasklist.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-05-design-refinement-plan.md | docs/plans/implemented/2026-03-05-design-refinement-plan.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-05-maintainability-audit-consolidated.md | docs/plans/implemented/2026-03-05-maintainability-audit-consolidated.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| 2026-03-05-simplification-audit-handover.md | docs/plans/implemented/2026-03-05-simplification-audit-handover.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| CCIP-mint-burn-processing.md | docs/plans/implemented/CCIP-mint-burn-processing.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| critical-high-priority.md | docs/plans/implemented/critical-high-priority.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| data-pipeline-audit.md | docs/plans/implemented/data-pipeline-audit.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| depeg-early-warning-design.md | docs/plans/implemented/depeg-early-warning-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| low-priority.md | docs/plans/implemented/low-priority.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| medium-priority.md | docs/plans/implemented/medium-priority.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| mint-burn-flow-design.md | docs/plans/implemented/mint-burn-flow-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| score-card-resilience-refactor.md | docs/plans/implemented/score-card-resilience-refactor.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| visual-audit.md | docs/plans/implemented/visual-audit.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| yield-intelligence-design.md | docs/plans/implemented/yield-intelligence-design.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| yield-tracking-more-tokens.md | docs/plans/implemented/yield-tracking-more-tokens.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| newID-disambiguation-research.md | docs/plans/newID/newID-disambiguation-research.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| newID-mission-statement.md | docs/plans/newID/newID-mission-statement.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| newid-migration-readiness-tasklist.md | docs/plans/newID/newid-migration-readiness-tasklist.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| old-basic-coin-id-disambiguation.md | docs/plans/newID/old-basic-coin-id-disambiguation.md | Planning artifact (historical; non-canonical behavior source) | ✅ Accurate (historical snapshot) |
| CAR-flow.md | docs/process/CAR-flow.md | Process workflow documentation | ✅ Accurate |
| adding-a-stablecoin.md | docs/process/adding-a-stablecoin.md | Contributor SOP for adding stablecoins | ❌ Significantly outdated |
| report-cards-timeline.md | docs/report-cards-timeline.md | Methodology/version timeline history | ✅ Accurate |
| report-cards.md | docs/report-cards.md | Risk card scoring model | ⚠ Partially stale |
| ccip-mint-burn-final-audit.md | docs/research/ccip-mint-burn-final-audit.md | Research notes and audits | ✅ Accurate (historical snapshot) |
| ccip-mint-burn-rollout-log.md | docs/research/ccip-mint-burn-rollout-log.md | Research notes and audits | ✅ Accurate (historical snapshot) |
| mint-burn-ingestion.md | docs/runbooks/mint-burn-ingestion.md | Mint/burn operations runbook | ✅ Accurate |
| scripts.md | docs/scripts.md | Operational script inventory | ✅ Accurate |
| stability-index-timeline.md | docs/stability-index-timeline.md | Methodology/version timeline history | ⚠ Partially stale |
| stability-index.md | docs/stability-index.md | PSI formula and behavior | ⚠ Partially stale |
| status-dashboard.md | docs/status-dashboard.md | Status page architecture and probes | ✅ Accurate |
| supply-snapshot.md | docs/supply-snapshot.md | Daily supply snapshot pipeline | ⚠ Partially stale |
| testing.md | docs/testing.md | Test/lint commands, suites, conventions | ⚠ Partially stale |
| worker-and-api-limits.md | docs/worker-and-api-limits.md | External provider and platform limits | ✅ Accurate |
| worker-infrastructure.md | docs/worker-infrastructure.md | Worker env, cron orchestration, cache, auth | ✅ Accurate |
| yield-intelligence.md | docs/yield-intelligence.md | Yield ranking pipeline and scoring | ❌ Significantly outdated |
| refactor-verification.md | refactor-verification.md | Documentation artifact | ✅ Accurate |
| sync-mint-backfill-postrefactor-todo.md | sync-mint-backfill-postrefactor-todo.md | Documentation artifact | ✅ Accurate (historical snapshot) |
| contract-enrichment-tracker.md | tasks/contract-enrichment-tracker.md | Task trackers and execution boards | ✅ Accurate (historical snapshot) |
| resilience-collateral-audit.md | tasks/done/resilience-collateral-audit.md | Task trackers and execution boards | ✅ Accurate (historical snapshot) |
| stablecoin-data-fetch-initial.md | tasks/done/stablecoin-data-fetch-initial.md | Task trackers and execution boards | ✅ Accurate (historical snapshot) |
| reliability-refinement-execution-board.md | tasks/reliability-refinement-execution-board.md | Task trackers and execution boards | ✅ Accurate (historical snapshot) |
| reserve-composition-tracker-findings.md | tasks/reserve-composition-tracker-findings.md | Task trackers and execution boards | ✅ Accurate (historical snapshot) |
| reserve-composition-tracker.md | tasks/reserve-composition-tracker.md | Task trackers and execution boards | ✅ Accurate (historical snapshot) |

## Changes Made

### Critical Fixes (Incorrect Information Corrected)
| # | Document | What Was Wrong | What Was Fixed |
|---|----------|---------------|----------------|
| 1 | AGENTS.md | Core architecture notes still referenced pre-refactor `src/lib/*` shared modules, stale route list (`mint`, `stability-index-alt`), and old stablecoin count | Updated shared-boundary paths to `shared/lib/*`, corrected route inventory to current `src/app`, and corrected tracked-asset count to `148 + 2 shadow` |
| 2 | CLAUDE.md | Same boundary drift as AGENTS plus brittle endpoint counts (`31 static router handlers`) that no longer match code | Aligned all shared-module references, fixed route inventory, and replaced hardcoded endpoint counts with contract-based wording |
| 3 | docs/api-reference.md | Method-gating docs omitted the dedicated `GET` dry-run path for `/api/audit-depeg-history` | Added explicit `GET /api/audit-depeg-history?dry-run=true` section with auth + query contract |
| 4 | docs/process/adding-a-stablecoin.md | Contributor SOP still instructed edits under moved files (`src/lib/stablecoins.ts`, `src/lib/chains.ts`) | Updated SOP, command examples, and related references to `shared/lib/stablecoins.ts` and `shared/lib/chains.ts` |
| 5 | docs/yield-intelligence.md | Testing reference pointed to non-existent `src/lib/__tests__/yield-helpers.test.ts` | Corrected to `worker/src/cron/__tests__/yield-helpers.test.ts` (actual test location) |

### Staleness Fixes (Outdated Content Updated)
| # | Document | What Was Stale | What Was Updated |
|---|----------|---------------|-----------------|
| 1 | README.md | Project-structure section no longer reflected the shared runtime boundary after refactor | Added explicit `shared/` boundary section and updated frontend `src/lib` description to frontend-only utilities |
| 2 | docs/methodology-page.md | Version-module and scoring-source links still pointed to pre-refactor `src/lib/*` locations | Updated methodology source map and update rules to `shared/lib/*-version.ts`, `shared/lib/report-cards.ts`, `shared/lib/peg-score.ts` |
| 3 | docs/stability-index.md + timeline docs | Canonical version-source paths drifted after module move | Migrated version-source paths to `shared/lib/stability-index-version.ts` and other `shared/lib/*-version.ts` modules |
| 4 | docs/classification.md, docs/supply-snapshot.md, docs/report-cards.md, docs/dependency-map.md | Cross-doc references still mixed old/shared module paths | Normalized all moved shared modules to `shared/lib/*` while preserving valid `src/lib/*` frontend-only references |
| 5 | docs/depeg-detection.md, docs/dews.md, docs/dex-liquidity.md, docs/cemetery-and-compare.md | Stale path references to moved shared scoring/version modules | Updated to current shared boundary (`shared/lib/peg-score.ts`, `shared/lib/classification.ts`, `shared/lib/dead-stablecoins.ts`, etc.) |
| 6 | docs/testing.md | Conventions section implied pure logic lived only in `src/lib` | Updated guidance to explicitly cover both `shared/lib` and `src/lib` pure-function testing |

### Gaps Filled (New Documentation Added)
| # | Document | What Was Missing | What Was Added |
|---|----------|-----------------|---------------|
| 1 | docs/api-reference.md | No dedicated API reference entry for dry-run audit mode | New endpoint section for `GET /api/audit-depeg-history?dry-run=true` |
| 2 | README.md | No explicit mention of the runtime-neutral shared boundary in structure docs | Added `shared/lib` and `shared/types` to Project Structure |
| 3 | docs/documentation-map-2026-03-05.tsv | No machine-readable documentation map with recency/ownership metadata | Added full 212-artifact map with format, ownership, doc/code modified dates, code refs, and pre-audit status |

### Cleanup (Removed or Consolidated)
| # | Document | What Was Removed/Changed | Reason |
|---|----------|------------------------|--------|
| 1 | shared/lib/stablecoins.ts | Removed/changed: stale `TODO` comment questioning AEUR domain validity | Live URL now resolves (HTTP 200) and stale TODO no longer represented current uncertainty |
| 2 | CLAUDE.md, README.md | Removed/changed: brittle hardcoded static-router endpoint counts | Counts were replaced with contract-based wording to reduce future drift |

## Remaining Items Requiring Team Input
- Historical artifact policy: `docs/plans/*`, `docs/research/*`, and `tasks/*` intentionally contain time-bound implementation assumptions. Team decision needed on whether to keep these in-place, archive them elsewhere, or add front-matter metadata for machine filtering.
- Ownership model: almost all docs currently show one effective owner in git history. Team-level ownership assignment per canonical doc would reduce single-point drift risk.
- Local untracked note file `refactor-verification.md` appeared during audit but was not part of this documentation pass; team should confirm whether it should be tracked, archived, or deleted.

## Recommendations
1. Add a CI doc-integrity check that fails on non-existent file-path references in canonical docs (exclude historical `docs/plans/*` by rule).
2. Add an API-doc sync check that compares `docs/api-reference.md` endpoint headings to `shared/lib/api-endpoints.ts` (including special-case method guards like `dry-run`).
3. Add a PR checklist item: when moving shared modules or renaming paths, update `README.md`, `AGENTS.md`, `CLAUDE.md`, and relevant `docs/*.md` in the same change.
4. Keep dated inventory snapshots (for example `docs/documentation-map-2026-03-05.tsv`) for major refactors so drift detection remains incremental instead of ad hoc.
