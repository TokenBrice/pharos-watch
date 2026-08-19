/**
 * Allowlists for scripts/ci/check-unused-code.ts.
 *
 * Two sections, deliberately separate:
 *
 * - SCANNER_BLIND_SPOTS — the consumer exists, but the static import graph cannot
 *   see it (string-keyed consumers, generated-artifact text, and the like). These
 *   entries are permanent until the scanner learns the pattern.
 * - DEBT — the finding is real: nothing imports the module or export, and it is
 *   kept on purpose or until a deletion pass reaches it. Target: empty. Removing
 *   an entry from here is a real cleanup; adding one needs a checkable reason.
 *
 * Every entry carries a one-line reason. The allowlist audit fails on a missing
 * reason, a missing file, or a symbol the file no longer exports, so entries
 * cannot rot silently.
 *
 * Export keys are "<repo-relative path>::<exported symbol>"; module keys are the
 * repo-relative path.
 */

/** Modules whose only importers are invisible to the static scan. */
export const SCANNER_BLIND_SPOT_MODULES: Record<string, string> = {};

/** Exports whose only consumers are invisible to the static scan. */
export const SCANNER_BLIND_SPOT_EXPORTS: Record<string, string> = {
  "shared/data/safety-score-v9/evaluation-build-manifest-v1.ts::SAFETY_SCORE_V9_EVALUATION_BUILD_MANIFEST":
    "Generated artifact: the export name is emitted as text by generate-safety-score-v9-evaluation-build-manifest.ts, never imported.",
  "src/components/chart-primitives/data-table.tsx::ChartDataTable":
    "scripts/ci/check-table-primitives.ts matches the exported component name as a string, not through an import.",
};

/** Unreferenced modules kept on purpose; deletion is a separate pass. */
export const DEBT_MODULES: Record<string, string> = {
  "worker/src/test-helpers/telegram-transport-control-schema.ts":
    "Worker test-helper module left behind by the telegram transport work; no test imports it any more.",
};

/** Unreferenced exports kept on purpose; deletion is a separate pass. */
export const DEBT_EXPORTS: Record<string, string> = {
  "shared/lib/methodology-versions/liquidity-score.ts::getLiquidityMethodologyVersionAt":
    "Runtime consumers (the pre-5.9 API reconstruction fallback) were removed in the v6.0 cutover; retained as the mixed-version boundary helper for history analysis. Deletion decision belongs to the v6 Phase 6 cleanup.",
  "shared/data/coverage-dispositions/oracle-risk-branch-dispositions.ts::ORACLE_RISK_BRANCH_DISPOSITION_FIELDS":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "shared/data/coverage-dispositions/oracle-risk-branch-dispositions.ts::ORACLE_RISK_BRANCH_DISPOSITIONS":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "shared/data/coverage-dispositions/oracle-risk-branch-dispositions.ts::ORACLE_RISK_BRANCH_DISPOSITION_REASON_CODES":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "shared/lib/api-endpoints/index.ts::buildQueryPath":
    "Unreferenced here: consumers import the same name from '@shared/lib/api-endpoints/paths' instead.",
  "shared/lib/api-endpoints/index.ts::EndpointPublicApiAccess":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "shared/lib/api-endpoints/index.ts::EndpointSiteDataAccess":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "shared/lib/api-endpoints/index.ts::getEndpointProbePaths":
    "Unreferenced here: consumers import the same name from './selectors' instead.",
  "shared/lib/chains/index.ts::CHAIN_RESILIENCE_TIER":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "shared/lib/chains/l2beat-audit.ts::findL2BeatAliasIntegrityIssues":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "shared/lib/chains/l2beat-risk.ts::L2BEAT_STAGE_SCORES":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "shared/lib/chains/l2beat-risk.ts::L2BEAT_RISK_SENTIMENT_SCORES":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "shared/lib/chains/l2beat-risk.ts::L2BEAT_STAGE_WEIGHT":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "shared/lib/chains/l2beat-risk.ts::L2BEAT_RISK_WEIGHT":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "shared/lib/cron-jobs.ts::VALID_CRON_JOB_IDS":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it; only prose mentions the name (src/data/changelogs/2026-06-21.ts).",
  "shared/lib/data-surface-descriptors.ts::surfaceFreshnessLaneFields":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "shared/lib/mint-burn-signals.ts::COIN_FLOW_COMPOSITE_STATE_VALUES":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "shared/lib/mint-burn-signals.ts::PRESSURE_SHIFT_STABLE_BAND_MAX":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "shared/lib/redemption-backstop-configs/shared.ts::cloneRedemptionDocSource":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "shared/lib/report-cards.ts::inferResilienceDefaults":
    "Unreferenced here: consumers import the same name from '../report-card-policy' instead.",
  "shared/lib/stablecoin-id-registry.ts::ALL_LIVE_COINS":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "shared/lib/stablecoins/schema.ts::StablecoinReservesSidecarSchema":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "shared/lib/stablecoins/schema.ts::DeadStablecoinAssetSchema":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "shared/lib/stablecoins/schema.ts::DeadStablecoinAssetArraySchema":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "shared/lib/tracked-stablecoin-utils.ts::findTrackedContract":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "shared/types/safety-score-v9-facts.ts::V9FactSourceFingerprintsV2Schema":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "shared/types/safety-score-v9-public-facts.ts::compareText":
    "Unreferenced here: consumers import the same name from './safety-score-v9-fact-primitives' instead.",
  "shared/types/stablecoin-meta-schemas.ts::OracleRiskBranchSchema":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "shared/types/stablecoin-meta-schemas.ts::BridgeRouteProtocolEvidenceSchema":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "src/components/chart-primitives/data-table.tsx::capDataForTable":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "src/components/command-palette-model.ts::scoreStablecoinSearchMatch":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "src/components/command-palette-model.ts::isExactStablecoinSymbolMatch":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "src/components/command-palette-model.ts::stablecoinProminenceBonus":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "src/components/providers.tsx::ToastContext":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "src/components/providers.tsx::useToastContext":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "src/components/stablecoin-detail/prose-lead.ts::PROSE_LEAD_CHARS":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "src/components/status/attribution-panel.tsx::AttributionWindowBadge":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "src/components/table/table-label.ts::withFallbackTableAriaLabel":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "src/components/table/table-label.ts::hasTableCaptionChild":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "src/components/ui/badge.tsx::badgeVariants":
    "Vendored shadcn/ui badge primitive surface kept complete; no app consumer.",
  "src/components/ui/button.tsx::buttonVariants":
    "Vendored shadcn/ui button primitive surface kept complete; no app consumer.",
  "src/components/ui/card.tsx::CardFooter":
    "Vendored shadcn/ui card primitive surface kept complete; no app consumer.",
  "src/components/ui/command.tsx::CommandDialog":
    "Vendored shadcn/ui cmdk primitive surface kept complete; no app consumer.",
  "src/components/ui/command.tsx::CommandGroup":
    "Vendored shadcn/ui cmdk primitive surface kept complete; no app consumer.",
  "src/components/ui/command.tsx::CommandShortcut":
    "Vendored shadcn/ui cmdk primitive surface kept complete; no app consumer.",
  "src/components/ui/command.tsx::CommandSeparator":
    "Vendored shadcn/ui cmdk primitive surface kept complete; no app consumer.",
  "src/components/ui/dialog.tsx::DialogOverlay":
    "Vendored shadcn/ui dialog primitive surface kept complete; no app consumer.",
  "src/components/ui/dialog.tsx::DialogPortal":
    "Vendored shadcn/ui dialog primitive surface kept complete; no app consumer.",
  "src/components/ui/dropdown-menu.tsx::DropdownMenuPortal":
    "Vendored shadcn/ui dropdown-menu primitive surface kept complete; no app consumer.",
  "src/components/ui/dropdown-menu.tsx::DropdownMenuGroup":
    "Vendored shadcn/ui dropdown-menu primitive surface kept complete; no app consumer.",
  "src/components/ui/dropdown-menu.tsx::DropdownMenuShortcut":
    "Vendored shadcn/ui dropdown-menu primitive surface kept complete; no app consumer.",
  "src/components/ui/dropdown-menu.tsx::DropdownMenuSub":
    "Vendored shadcn/ui dropdown-menu primitive surface kept complete; no app consumer.",
  "src/components/ui/dropdown-menu.tsx::DropdownMenuSubTrigger":
    "Vendored shadcn/ui dropdown-menu primitive surface kept complete; no app consumer.",
  "src/components/ui/dropdown-menu.tsx::DropdownMenuSubContent":
    "Vendored shadcn/ui dropdown-menu primitive surface kept complete; no app consumer.",
  "src/components/ui/sheet.tsx::SheetClose":
    "Vendored shadcn/ui sheet primitive surface kept complete; no app consumer.",
  "src/hooks/use-admin-polling-query.ts::useAdminPollingQuery":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it; only prose mentions the name (docs/status-dashboard.md).",
  "src/hooks/use-preferences.ts::isColumnId":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "src/lib/alt-peg-packing.ts::DEFAULT_COLLISION_ITERATIONS":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "src/lib/command-palette-verbs.ts::resolveCoinIdFromToken":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "src/lib/compare-config.ts::ID_TO_COMPARE_COIN":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "src/lib/contagion-layout.ts::contagionEdgeRelationship":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it; only prose mentions the name (docs/dependency-map.md).",
  "src/lib/coverage-matrix-model.ts::COVERAGE_MATRIX_QUERY_KEYS":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "src/lib/coverage/shared.ts::createStatus":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it; only prose mentions the name (docs/architecture.md).",
  "src/lib/cron-intervals.ts::CRON_1H":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it; only prose mentions the name (docs/data-pipeline.md).",
  "src/lib/exports/csv.ts::escapeCsvField":
    "Unreferenced here: consumers import the same name from '@shared/lib/csv' instead.",
  "src/lib/exports/csv.ts::buildCsv":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "src/lib/homepage-bootstrap-shared.ts::descriptorMaxAgeMs":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "src/lib/mint-authority-display.ts::MINT_AUTHORITY_STATUS_VALUES":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "src/lib/mint-authority-display.ts::mintPostureTextClassName":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "src/lib/safety-score-v9-consumers.ts::V9GradeRiskBucket":
    "Unreferenced here: consumers import the same name from '../safety-grade-buckets' instead.",
  "src/lib/stablecoin-detail-mint-authority-view-model.ts::EOA_UNVERIFIED_CUSTODY_LABEL":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "src/lib/yield-constants.ts::WARNING_SIGNAL_LABELS":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "src/lib/yield-data-source.ts::YIELD_DATA_SOURCE_META":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/api/dex-liquidity-evidence.ts::isTrendworthyLiquiditySnapshot":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/api/mint-burn-flows-shared.ts::FLOW_CACHE_PREFIX":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/api/mint-burn-flows-shared.ts::readCachedFlow":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/api/telegram-webhook-messages.ts::formatCoinLines":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/api/telegram-webhook-parsing.ts::parseStoredSetCommand":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/api/telegram-webhook-parsing.ts::parseStringArray":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/api/telegram-webhook-parsing.ts::parseResolvedCoins":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/api/telegram-webhook-pending-gate.ts::canActOnPendingOwner":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/cron/blacklist/evm-source.ts::resolveRpcLogTarget":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/cron/daily-digest/voice-guards.ts::FORBIDDEN_TICS_ANYWHERE":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/cron/daily-digest/voice-guards.ts::FORBIDDEN_TICS_CLOSER":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/cron/dews/source-state/hydration.ts::DEWS_STALE_DEX_LIQUIDITY_SEC":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/cron/dews/source-state/hydration.ts::DEWS_PREVIOUS_SIGNAL_SMOOTHING_MAX_AGE_SEC":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/cron/dex-liquidity/challenger-persistence.ts::selectDexPriceChallengerRowsFromPools":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/cron/dex-liquidity/geckoterminal-shared.ts::getGtPoolKind":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/cron/dispatch-telegram-pending-lifecycle.ts::pendingQueueChanged":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/cron/measured-execution/curve-composite.ts::CURVE_ALUSD_3CRV_METAPOOL_POLICY":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/cron/measured-execution/curve-composite.ts::CURVE_DOLA_FRAXBP_METAPOOL_POLICY":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/cron/measured-execution/curve-composite.ts::CURVE_EUSD_FRAXBP_METAPOOL_POLICY":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/cron/measured-execution/curve-composite.ts::CURVE_MSUSD_FRAXBP_METAPOOL_POLICY":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/cron/measured-execution/curve-composite.ts::CURVE_MEUSD_CRV2POOL_METAPOOL_POLICY":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/cron/measured-execution/curve-composite.ts::CURVE_OUSD_3CRV_METAPOOL_POLICY":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/cron/measured-execution/curve-composite.ts::CURVE_MAI_AM3CRV_METAPOOL_POLICY":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/cron/measured-execution/curve-composite.ts::CURVE_TUSD_AM3CRV_METAPOOL_POLICY":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/cron/measured-execution/curve-cryptoswap.ts::CURVE_CRYPTOSWAP_REVIEWED_FAMILIES":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/cron/reserve-adapters/slice-math.ts::RATIO_SCALE":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/cron/sync-stablecoins/metadata.ts::buildPriceSourceHealth":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/cron/sync-stablecoins/supplemental-assets/shared.ts::buildSupplementalAsset":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/cron/telegram-alert-snapshots.ts::SAFETY_GRADE_RANK":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/cron/telegram-pending/upsert-sql.ts::PENDING_ALERT_UPSERT_COLUMNS":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/cron/yield-sync/cache.ts::filterValidDlPools":
    "Unreferenced here: consumers import the same name from './cache/defillama-pool-cache' instead.",
  "worker/src/cron/yield-sync/cache.ts::ParsedYieldSupplementalSourcesCache":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/cron/yield-sync/cache/normalization.ts::toNullableString":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/cron/yield-sync/cache/normalization.ts::toStringArray":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/lib/chain-registry.ts::CG_CHAIN_REVERSE":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/lib/chain-registry.ts::GT_CHAIN_REVERSE":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/lib/circuit-breaker.ts::isActiveCircuitSource":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/lib/cron-timeouts.ts::getConfiguredCronTimeoutMs":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/lib/dews/evidence-policy.ts::EVIDENCE_STRESS_THRESHOLD":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/lib/dews/evidence-policy.ts::hasStressEvidence":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/lib/dex-api-common.ts::DIRECT_API_MAX_POOL_TVL_USD":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/lib/external-api-schemas.ts::TronEventResultSchema":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/lib/external-api-schemas.ts::TronEventSchema":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/lib/fx-rate-state.ts::resetFxRateStateForTests":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/lib/mint-burn-scoring.ts::MIN_ACTIVITY_USD":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/lib/psi-history-universe.ts::buildPsiHistoricalUniverseForDay":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/lib/redemption-backstop-capacity.ts::CapacityResolution":
    "Unreferenced here: consumers import the same name from './profile' instead.",
  "worker/src/lib/repair-tasks.ts::DDR_REPAIR_RUNNER_CLAIM_LEASE_SEC_V1":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it; only prose mentions the name (docs/depeg-resolver.md).",
  "worker/src/lib/report-card-evidence-journal-store.ts::REPORT_CARD_EVIDENCE_JOURNAL_STORE_MAX_ROWS_PER_ASSET":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/lib/report-cards-fixed-input.ts::FixedDexLiquidityRow":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/lib/safety-score-v9-extension-shared.ts::isoDateStartSec":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/lib/scheduled-slot-fence.ts::STALE_SLOT_ABANDONED_EVENT_TYPE":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/lib/schemas.ts::CronMetadataSchema":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/lib/stability-index.ts::BAND_COLORS":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/lib/telegram-transport-control.ts::TELEGRAM_DELIVERY_MODES":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/lib/telegram-transport-control.ts::readTelegramDeliveryPauses":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/test-helpers/v9-fixed-input.ts::V9_TEST_CLOCK_FLOOR_SEC":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/test-helpers/v9-fixed-input.ts::v9MechanismReview":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/test-helpers/v9-fixed-input.ts::V9_REGISTRY_FIXTURE_CLOCK_SEC":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
  "worker/src/test-helpers/v9-fixed-input.ts::V9_REGISTRY_FIXTURE_DEX_UPDATED_AT_SEC":
    "Unreferenced: nothing in the scanned graph (src, shared, worker, functions, scripts, tests) imports it.",
};
