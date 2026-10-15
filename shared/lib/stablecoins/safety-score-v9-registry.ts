import scoringCatalogAsset from "../../data/stablecoins/coins.safety-score-v9.generated.json";
import { deepFreeze } from "../../types/safety-score-v9-immutable";
import type {
  SafetyScoreV9ScoringCatalog,
  SafetyScoreV9ScoringMeta,
} from "../../types/safety-score-v9-scoring-catalog";

// The registered generator validates the full source catalog before projection.
// Keep full-catalog loading and runtime schema validation outside this boundary.
const catalog = deepFreeze(scoringCatalogAsset as unknown as SafetyScoreV9ScoringCatalog);

export const SAFETY_SCORE_V9_SCORING_ROWS: readonly SafetyScoreV9ScoringMeta[] = catalog.rows;
export const SAFETY_SCORE_V9_ACTIVE_META_BY_ID: ReadonlyMap<string, SafetyScoreV9ScoringMeta> =
  new Map(SAFETY_SCORE_V9_SCORING_ROWS.map((coin) => [coin.id, coin]));
export const SAFETY_SCORE_V9_ACTIVE_ASSET_IDS: readonly string[] = catalog.activeAssetIds;
export const SAFETY_SCORE_V9_CATALOG_COUNT = catalog.catalogCount;
export const SAFETY_SCORE_V9_REGISTRY_FINGERPRINT = catalog.registryFingerprint;
