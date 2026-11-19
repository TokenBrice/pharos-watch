// Node-only entry point for the operator receipt to exercise the Worker implementation.
export { decideDepegAsset } from "../../src/cron/depeg-detection/decision-engine";
export { persistDepegCommands } from "../../src/cron/depeg-detection/persistence";
export { buildDuplicateOpenEventRepair } from "../../src/cron/depeg-detection/repair";
export { buildConfirmationPlan, isNativeQuoteForPending, SELECT_PENDING_CONFIRMATION_SQL, type ConfirmationEvidenceInput } from "../../src/cron/pending-depeg-confirmation";
export { evaluatePromotionDecision } from "../../src/cron/pending-depeg-confirmation-decision";
export { collectConfirmationEvidence } from "../../src/cron/pending-depeg-confirmation-evidence";
export { FxSyncRunState } from "../../src/cron/sync-fx-rates-helpers";
export { isNativeOriginPending, loadDexPrices } from "../../src/lib/depeg-helpers";
export { normalizePendingDepegRow, type PendingDepegRow } from "../../src/lib/depeg-pending";
export { getDepegRecoveryThresholdBps, getDepegThresholdBps } from "../../src/lib/depeg-threshold-policy";
export { isAffirmativeDexPriceRow } from "../../src/lib/depeg-trust-policy";
export { computeDivergSignal } from "../../src/lib/dews/signal-families";
export type { DEWSInput } from "../../src/lib/dews/types";
export { hydrateFxRateState } from "../../src/lib/fx-rate-state";
export { getNativePegQueryCurrencies } from "../../src/lib/native-peg-quotes";
export { POOL_CHALLENGE_MIN_TVL } from "../../src/lib/price-depeg-voting-policy";
