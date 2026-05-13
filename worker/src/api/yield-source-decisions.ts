import { jsonResponse, parseIntParam, parseOptionalEnumParam } from "../lib/api-utils";
import { makeAdminRoute } from "../lib/route-wrappers";

type GenerationState = "staged" | "published" | "failed";

interface YieldGenerationRow {
  generation_id: string;
  started_at: number;
  state: GenerationState;
  cache_key: string;
  ranking_updated_at: number | null;
  ranking_count: number | null;
  source_row_count: number | null;
  best_row_count: number | null;
  decision_count: number | null;
  published_at: number | null;
  failed_at: number | null;
  failure_reason: string | null;
  metadata_json: string | null;
  created_at: number;
}

interface YieldSourceDecisionRow {
  generation_id: string;
  stablecoin_id: string;
  selected_source_key: string;
  selected_confidence_tier: string;
  selected_data_source: string;
  selected_apy_30d: number;
  selected_score: number | null;
  selected_reason: string;
  previous_best_source_key: string | null;
  source_switch: number;
  rejected_count: number;
  alternatives_json: string;
  created_at: number;
}

interface AdminRouteContext {
  db: D1Database;
  url: URL;
  request: Request;
  trustedAdmin: boolean;
}

const GENERATION_STATES = new Set<GenerationState>(["staged", "published", "failed"]);
const DEFAULT_GENERATION_LIMIT = 10;
const MAX_GENERATION_LIMIT = 25;
const DEFAULT_DECISION_LIMIT = 5;
const MAX_DECISION_LIMIT = 25;
const MAX_GENERATION_ID_LENGTH = 128;
const MAX_STABLECOIN_ID_LENGTH = 96;

function parseBoundedToken(
  value: string | null,
  name: string,
  maxLength: number,
  pattern: RegExp,
): string | null | Response {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength || !pattern.test(trimmed)) {
    return jsonResponse({ error: `Invalid ${name} parameter` }, { status: 400 });
  }
  return trimmed;
}

function parseJsonValue(raw: string | null): { value: unknown; malformed: boolean } {
  if (!raw) return { value: null, malformed: false };
  try {
    return { value: JSON.parse(raw) as unknown, malformed: false };
  } catch {
    return { value: null, malformed: true };
  }
}

function toNumberOrNull(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function mapGeneration(row: YieldGenerationRow) {
  const metadata = parseJsonValue(row.metadata_json);
  return {
    generationId: row.generation_id,
    startedAt: row.started_at,
    state: row.state,
    cacheKey: row.cache_key,
    rankingUpdatedAt: row.ranking_updated_at,
    rankingCount: row.ranking_count,
    sourceRowCount: row.source_row_count,
    bestRowCount: row.best_row_count,
    decisionCount: row.decision_count,
    publishedAt: row.published_at,
    failedAt: row.failed_at,
    failureReason: row.failure_reason,
    metadata: metadata.value,
    metadataMalformed: metadata.malformed,
    createdAt: row.created_at,
  };
}

function mapDecision(row: YieldSourceDecisionRow) {
  const parsedAlternatives = parseJsonValue(row.alternatives_json);
  const alternatives = Array.isArray(parsedAlternatives.value) ? parsedAlternatives.value : [];
  const alternativesMalformed =
    parsedAlternatives.malformed || (parsedAlternatives.value !== null && !Array.isArray(parsedAlternatives.value));

  return {
    generationId: row.generation_id,
    stablecoinId: row.stablecoin_id,
    selected: {
      sourceKey: row.selected_source_key,
      confidenceTier: row.selected_confidence_tier,
      dataSource: row.selected_data_source,
      apy30d: row.selected_apy_30d,
      score: toNumberOrNull(row.selected_score),
      reason: row.selected_reason,
    },
    previousBestSourceKey: row.previous_best_source_key,
    sourceSwitch: row.source_switch === 1,
    rejectedCount: row.rejected_count,
    alternatives,
    alternativesMalformed,
    createdAt: row.created_at,
  };
}

async function loadGenerations(
  db: D1Database,
  params: {
    generationId: string | null;
    state: GenerationState | null;
    limit: number;
  },
) {
  const rows = await db
    .prepare(
      `SELECT
         generation_id, started_at, state, cache_key, ranking_updated_at, ranking_count,
         source_row_count, best_row_count, decision_count, published_at, failed_at,
         failure_reason, metadata_json, created_at
       FROM yield_publication_generations
       WHERE (? IS NULL OR generation_id = ?)
         AND (? IS NULL OR state = ?)
       ORDER BY started_at DESC, generation_id DESC
       LIMIT ?`,
    )
    .bind(params.generationId, params.generationId, params.state, params.state, params.limit)
    .all<YieldGenerationRow>();

  return (rows.results ?? []).map(mapGeneration);
}

async function loadStablecoinDecisions(
  db: D1Database,
  params: {
    stablecoinId: string;
    generationId: string | null;
    state: GenerationState | null;
    limit: number;
  },
) {
  const rows = await db
    .prepare(
      `SELECT
         d.generation_id, d.stablecoin_id, d.selected_source_key, d.selected_confidence_tier,
         d.selected_data_source, d.selected_apy_30d, d.selected_score, d.selected_reason,
         d.previous_best_source_key, d.source_switch, d.rejected_count, d.alternatives_json,
         d.created_at
       FROM yield_source_decisions d
       INNER JOIN yield_publication_generations g ON g.generation_id = d.generation_id
       WHERE d.stablecoin_id = ?
         AND (? IS NULL OR d.generation_id = ?)
         AND (? IS NULL OR g.state = ?)
       ORDER BY g.started_at DESC, d.generation_id DESC
       LIMIT ?`,
    )
    .bind(
      params.stablecoinId,
      params.generationId,
      params.generationId,
      params.state,
      params.state,
      params.limit,
    )
    .all<YieldSourceDecisionRow>();

  return (rows.results ?? []).map(mapDecision);
}

export const handleYieldSourceDecisions = makeAdminRoute<AdminRouteContext>(
  "route-yield-source-decisions",
  async ({ db, url }) => {
    const limit = parseIntParam(
      url.searchParams.get("limit"),
      DEFAULT_GENERATION_LIMIT,
      1,
      MAX_GENERATION_LIMIT,
      "limit",
      { rangePolicy: "reject" },
    );
    if (limit instanceof Response) return limit;

    const decisionLimit = parseIntParam(
      url.searchParams.get("decisionLimit"),
      DEFAULT_DECISION_LIMIT,
      1,
      MAX_DECISION_LIMIT,
      "decisionLimit",
      { rangePolicy: "reject" },
    );
    if (decisionLimit instanceof Response) return decisionLimit;

    const state = parseOptionalEnumParam(url.searchParams.get("state"), GENERATION_STATES, "state");
    if (state instanceof Response) return state;

    const generationId = parseBoundedToken(
      url.searchParams.get("generationId"),
      "generationId",
      MAX_GENERATION_ID_LENGTH,
      /^[A-Za-z0-9._:-]+$/,
    );
    if (generationId instanceof Response) return generationId;

    const stablecoinId = parseBoundedToken(
      url.searchParams.get("stablecoin"),
      "stablecoin",
      MAX_STABLECOIN_ID_LENGTH,
      /^[a-z0-9][a-z0-9-]*$/,
    );
    if (stablecoinId instanceof Response) return stablecoinId;

    const [generations, decisions] = await Promise.all([
      loadGenerations(db, { generationId, state, limit }),
      stablecoinId
        ? loadStablecoinDecisions(db, { stablecoinId, generationId, state, limit: decisionLimit })
        : Promise.resolve([]),
    ]);

    return jsonResponse({
      filters: {
        generationId,
        state,
        stablecoinId,
        limit,
        decisionLimit: stablecoinId ? decisionLimit : 0,
      },
      generations,
      decisions,
    });
  },
);
