import type {
  DexArchiveArtifactInput,
  DexArchiveCell,
  DexArchivePublication,
  DexArchiveTable,
} from "./codec";

const HOT_RETENTION_SEC = 3 * 60 * 60;
const PAGE_SIZE = 64;

const QUOTE_SURFACES = [
  "dex-measured-execution-quotes",
  "dex-solana-measured-execution-quotes",
  "dex-tron-measured-execution-quotes",
] as const;
const TARGET_SURFACES = [
  "dex-measured-execution-targets",
  "dex-solana-measured-execution-targets",
  "dex-tron-measured-execution-targets",
] as const;

type QuoteSurface = (typeof QUOTE_SURFACES)[number];
type TargetSurface = (typeof TARGET_SURFACES)[number];

const TARGET_SURFACE_BY_QUOTE: Record<QuoteSurface, TargetSurface> = {
  "dex-measured-execution-quotes": "dex-measured-execution-targets",
  "dex-solana-measured-execution-quotes": "dex-solana-measured-execution-targets",
  "dex-tron-measured-execution-quotes": "dex-tron-measured-execution-targets",
};

const LEDGER_COLUMNS = [
  "surface",
  "generation_id",
  "started_at",
  "validated_at",
  "published_at",
  "state",
  "candidate_rows",
  "published_rows",
  "expected_rows",
  "previous_generation_id",
  "input_watermarks_json",
  "dependency_snapshot_json",
  "validation_summary_json",
  "artifact_checksum",
  "artifact_cache_key",
  "failure_reason",
  "producer_schedule_key",
  "producer_job",
  "producer_path",
  "producer_kind",
  "invocation_id",
  "worker_version",
] as const;

const QUOTE_COLUMNS = [
  "generation_id",
  "target_generation_id",
  "target_id",
  "stablecoin_id",
  "adapter_profile_id",
  "protocol",
  "chain",
  "pool_id",
  "status",
  "failure_reason",
  "quoted_at",
  "block_number",
  "quote_profile_json",
  "raw_quote_payload_json",
] as const;

const TARGET_COLUMNS = [
  "generation_id",
  "target_id",
  "stablecoin_id",
  "adapter_profile_id",
  "protocol",
  "chain",
  "pool_id",
  "captured_at",
  "target_json",
] as const;

interface PublicationLedgerRow {
  surface: string;
  generation_id: string;
  started_at: number;
  validated_at: number | null;
  published_at: number | null;
  state: string;
  candidate_rows: number | null;
  published_rows: number | null;
  expected_rows: number | null;
  previous_generation_id: string | null;
  input_watermarks_json: string | null;
  dependency_snapshot_json: string | null;
  validation_summary_json: string | null;
  artifact_checksum: string | null;
  artifact_cache_key: string | null;
  failure_reason: string | null;
  producer_schedule_key: string | null;
  producer_job: string | null;
  producer_path: string | null;
  producer_kind: string | null;
  invocation_id: string | null;
  worker_version: string | null;
}

interface MeasuredQuoteRow {
  generation_id: string;
  target_generation_id: string;
  target_id: string;
  stablecoin_id: string;
  adapter_profile_id: string;
  protocol: string;
  chain: string;
  pool_id: string;
  status: string;
  failure_reason: string | null;
  quoted_at: number | null;
  block_number: number | null;
  quote_profile_json: string | null;
  raw_quote_payload_json: string | null;
}

interface MeasuredTargetRow {
  generation_id: string;
  target_id: string;
  stablecoin_id: string;
  adapter_profile_id: string;
  protocol: string;
  chain: string;
  pool_id: string;
  captured_at: number;
  target_json: string;
}

interface CandidateRow {
  kind: "quote" | "target";
  surface: string;
  generation_id: string;
  started_at: number;
  expected_rows: number;
  dependency_generation_id: string | null;
}

interface BacklogRow {
  generation_count: number;
  source_row_count: number;
  logical_bytes: number;
  oldest_eligible_at: number | null;
}

export interface MeasuredArchiveCandidate {
  kind: "quote" | "target";
  surface: QuoteSurface | TargetSurface;
  generationId: string;
  sourceSlotStartedAt: number;
  expectedRows: number;
  dependencyGenerationId: string | null;
}

export interface MeasuredArchiveBacklog {
  generationCount: number;
  sourceRowCount: number;
  logicalBytes: number;
  oldestEligibleAt: number | null;
}

export interface LoadedMeasuredArchiveArtifact {
  candidate: MeasuredArchiveCandidate;
  artifactInput: DexArchiveArtifactInput;
  objectKey: string;
}

function isQuoteSurface(value: string): value is QuoteSurface {
  return (QUOTE_SURFACES as readonly string[]).includes(value);
}

function isTargetSurface(value: string): value is TargetSurface {
  return (TARGET_SURFACES as readonly string[]).includes(value);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function ledgerValues(row: PublicationLedgerRow): DexArchiveCell[] {
  return LEDGER_COLUMNS.map((column) => row[column]);
}

function quoteValues(row: MeasuredQuoteRow): DexArchiveCell[] {
  return QUOTE_COLUMNS.map((column) => row[column]);
}

function targetValues(row: MeasuredTargetRow): DexArchiveCell[] {
  return TARGET_COLUMNS.map((column) => row[column]);
}

function publicationFromLedger(row: PublicationLedgerRow): DexArchivePublication {
  return {
    surface: row.surface,
    state: row.state,
    startedAt: row.started_at,
    validatedAt: row.validated_at,
    publishedAt: row.published_at,
  };
}

export function buildMeasuredArchiveObjectKey(
  family: "quote" | "target",
  generationId: string,
  sourceSlotStartedAt: number,
): string {
  const timestamp = new Date(sourceSlotStartedAt * 1_000);
  if (!Number.isFinite(timestamp.getTime())) throw new RangeError("Invalid measured archive source timestamp");
  const year = timestamp.getUTCFullYear().toString().padStart(4, "0");
  const month = (timestamp.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = timestamp.getUTCDate().toString().padStart(2, "0");
  const prefix = family === "quote" ? "measured-execution" : "measured-targets";
  return `dex/${prefix}/v1/${year}/${month}/${day}/${generationId}.json.gz`;
}

function assertCompleteSupersededLedger(
  row: PublicationLedgerRow,
  expectedSurface: string,
  cutoff: number,
): void {
  if (
    row.surface !== expectedSurface
    || row.state !== "superseded"
    || row.started_at >= cutoff
    || row.expected_rows == null
    || row.expected_rows <= 0
    || row.published_rows !== row.expected_rows
    || row.published_at == null
  ) {
    throw new Error(`Measured archive protected or incomplete generation: ${expectedSurface}/${row.generation_id}`);
  }
}

async function loadLedger(
  db: D1Database,
  surface: string,
  generationId: string,
): Promise<PublicationLedgerRow> {
  const row = await db
    .prepare(
      `SELECT ${LEDGER_COLUMNS.join(", ")}
         FROM surface_publication_generations
        WHERE surface = ? AND generation_id = ?`,
    )
    .bind(surface, generationId)
    .first<PublicationLedgerRow>();
  if (!row) throw new Error(`Measured archive ledger row missing: ${surface}/${generationId}`);
  return row;
}

async function loadPagedQuotes(
  db: D1Database,
  generationId: string,
  signal?: AbortSignal,
): Promise<MeasuredQuoteRow[]> {
  const rows: MeasuredQuoteRow[] = [];
  let afterTargetId = "";
  while (true) {
    throwIfAborted(signal);
    const page = await db
      .prepare(
        `SELECT ${QUOTE_COLUMNS.join(", ")}
           FROM dex_measured_execution_quotes
          WHERE generation_id = ? AND target_id > ?
          ORDER BY target_id ASC
          LIMIT ?`,
      )
      .bind(generationId, afterTargetId, PAGE_SIZE)
      .all<MeasuredQuoteRow>();
    const values = page.results ?? [];
    rows.push(...values);
    if (values.length < PAGE_SIZE) break;
    afterTargetId = values[values.length - 1]!.target_id;
  }
  return rows;
}

async function loadPagedTargets(
  db: D1Database,
  generationId: string,
  signal?: AbortSignal,
): Promise<MeasuredTargetRow[]> {
  const rows: MeasuredTargetRow[] = [];
  let afterTargetId = "";
  while (true) {
    throwIfAborted(signal);
    const page = await db
      .prepare(
        `SELECT ${TARGET_COLUMNS.join(", ")}
           FROM dex_measured_execution_targets
          WHERE generation_id = ? AND target_id > ?
          ORDER BY target_id ASC
          LIMIT ?`,
      )
      .bind(generationId, afterTargetId, PAGE_SIZE)
      .all<MeasuredTargetRow>();
    const values = page.results ?? [];
    rows.push(...values);
    if (values.length < PAGE_SIZE) break;
    afterTargetId = values[values.length - 1]!.target_id;
  }
  return rows;
}

export async function listMeasuredArchiveCandidates(
  db: D1Database,
  now: number,
  limit: number,
): Promise<MeasuredArchiveCandidate[]> {
  const cutoff = now - HOT_RETENTION_SEC;
  const quoteRows = await db
    .prepare(
      `SELECT 'quote' AS kind, g.surface, g.generation_id, g.started_at, g.expected_rows,
              t.generation_id AS dependency_generation_id
         FROM surface_publication_generations g
         JOIN surface_publication_generations t
           ON t.generation_id = json_extract(g.dependency_snapshot_json, '$.targetGenerationId')
          AND t.surface = CASE g.surface
            WHEN 'dex-measured-execution-quotes' THEN 'dex-measured-execution-targets'
            WHEN 'dex-solana-measured-execution-quotes' THEN 'dex-solana-measured-execution-targets'
            WHEN 'dex-tron-measured-execution-quotes' THEN 'dex-tron-measured-execution-targets'
          END
        WHERE g.surface IN (?, ?, ?)
          AND g.state = 'superseded'
          AND g.started_at < ?
          AND g.published_at IS NOT NULL
          AND g.expected_rows > 0
          AND g.published_rows = g.expected_rows
          AND json_type(g.dependency_snapshot_json, '$.targetGenerationId') = 'text'
          AND t.state = 'superseded'
          AND t.started_at < ?
          AND t.published_at IS NOT NULL
          AND t.expected_rows > 0
          AND t.published_rows = t.expected_rows
          AND NOT EXISTS (
            SELECT 1 FROM dex_archive_manifests m
             WHERE m.family = 'measured-quote-generation'
               AND m.generation_id = g.generation_id
               AND m.verified_at IS NOT NULL
          )
        ORDER BY g.started_at ASC, g.surface ASC, g.generation_id ASC
        LIMIT ?`,
    )
    .bind(...QUOTE_SURFACES, cutoff, cutoff, limit)
    .all<CandidateRow>();
  const candidates: MeasuredArchiveCandidate[] = (quoteRows.results ?? []).map((row) => {
    if (!isQuoteSurface(row.surface) || !row.dependency_generation_id) {
      throw new Error(`Invalid measured quote archive candidate ${row.generation_id}`);
    }
    return {
      kind: "quote",
      surface: row.surface,
      generationId: row.generation_id,
      sourceSlotStartedAt: row.started_at,
      expectedRows: row.expected_rows,
      dependencyGenerationId: row.dependency_generation_id,
    };
  });
  const remaining = Math.max(0, limit - candidates.length);
  if (remaining === 0) return candidates;
  const targetRows = await db
    .prepare(
      `SELECT 'target' AS kind, surface, generation_id, started_at, expected_rows,
              NULL AS dependency_generation_id
         FROM surface_publication_generations
        WHERE surface IN (?, ?, ?)
          AND state = 'superseded'
          AND started_at < ?
          AND published_at IS NOT NULL
          AND expected_rows > 0
          AND published_rows = expected_rows
          AND NOT EXISTS (
            SELECT 1 FROM dex_measured_execution_quotes q
             WHERE q.target_generation_id = surface_publication_generations.generation_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM dex_archive_manifests m
             WHERE m.family = 'measured-target-generation'
               AND m.generation_id = surface_publication_generations.generation_id
               AND m.verified_at IS NOT NULL
          )
        ORDER BY started_at ASC, surface ASC, generation_id ASC
        LIMIT ?`,
    )
    .bind(...TARGET_SURFACES, cutoff, remaining)
    .all<CandidateRow>();
  for (const row of targetRows.results ?? []) {
    if (!isTargetSurface(row.surface)) {
      throw new Error(`Invalid measured target archive candidate ${row.generation_id}`);
    }
    candidates.push({
      kind: "target",
      surface: row.surface,
      generationId: row.generation_id,
      sourceSlotStartedAt: row.started_at,
      expectedRows: row.expected_rows,
      dependencyGenerationId: null,
    });
  }
  return candidates.sort(
    (left, right) =>
      left.sourceSlotStartedAt - right.sourceSlotStartedAt
      || left.surface.localeCompare(right.surface)
      || left.generationId.localeCompare(right.generationId),
  );
}

export async function loadMeasuredArchiveBacklog(
  db: D1Database,
  now: number,
): Promise<MeasuredArchiveBacklog> {
  const cutoff = now - HOT_RETENTION_SEC;
  const row = await db
    .prepare(
      `WITH eligible AS (
         SELECT g.started_at,
                g.expected_rows + COALESCE(t.expected_rows, 0) AS source_rows,
                COALESCE((
                  SELECT SUM(
                    length(COALESCE(q.quote_profile_json, ''))
                    + length(COALESCE(q.raw_quote_payload_json, ''))
                  )
                    FROM dex_measured_execution_quotes q
                   WHERE q.generation_id = g.generation_id
                ), 0) + COALESCE((
                  SELECT SUM(length(mt.target_json))
                    FROM dex_measured_execution_targets mt
                   WHERE mt.generation_id = json_extract(
                     g.dependency_snapshot_json,
                     '$.targetGenerationId'
                   )
                ), 0) AS logical_bytes
           FROM surface_publication_generations g
           LEFT JOIN surface_publication_generations t
             ON t.generation_id = json_extract(g.dependency_snapshot_json, '$.targetGenerationId')
            AND t.surface = CASE g.surface
              WHEN 'dex-measured-execution-quotes' THEN 'dex-measured-execution-targets'
              WHEN 'dex-solana-measured-execution-quotes' THEN 'dex-solana-measured-execution-targets'
              WHEN 'dex-tron-measured-execution-quotes' THEN 'dex-tron-measured-execution-targets'
            END
          WHERE g.surface IN (?, ?, ?)
            AND g.state = 'superseded'
            AND g.started_at < ?
            AND g.published_at IS NOT NULL
            AND g.expected_rows > 0
            AND g.published_rows = g.expected_rows
            AND json_type(g.dependency_snapshot_json, '$.targetGenerationId') = 'text'
            AND t.state = 'superseded'
            AND t.started_at < ?
            AND t.published_at IS NOT NULL
            AND t.expected_rows > 0
            AND t.published_rows = t.expected_rows
            AND NOT EXISTS (
              SELECT 1 FROM dex_archive_manifests m
               WHERE m.family = 'measured-quote-generation'
                 AND m.generation_id = g.generation_id
                 AND m.verified_at IS NOT NULL
            )
         UNION ALL
         SELECT g.started_at,
                g.expected_rows AS source_rows,
                COALESCE((
                  SELECT SUM(length(mt.target_json))
                    FROM dex_measured_execution_targets mt
                   WHERE mt.generation_id = g.generation_id
                ), 0) AS logical_bytes
           FROM surface_publication_generations g
          WHERE g.surface IN (?, ?, ?)
            AND g.state = 'superseded'
            AND g.started_at < ?
            AND g.published_at IS NOT NULL
            AND g.expected_rows > 0
            AND g.published_rows = g.expected_rows
            AND NOT EXISTS (
              SELECT 1 FROM dex_measured_execution_quotes q
               WHERE q.target_generation_id = g.generation_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM dex_archive_manifests m
               WHERE m.family = 'measured-target-generation'
                 AND m.generation_id = g.generation_id
                 AND m.verified_at IS NOT NULL
            )
       )
       SELECT COUNT(*) AS generation_count,
              COALESCE(SUM(source_rows), 0) AS source_row_count,
              COALESCE(SUM(logical_bytes), 0) AS logical_bytes,
              MIN(started_at) AS oldest_eligible_at
         FROM eligible`,
    )
    .bind(
      ...QUOTE_SURFACES,
      cutoff,
      cutoff,
      ...TARGET_SURFACES,
      cutoff,
    )
    .first<BacklogRow>();
  return {
    generationCount: Number(row?.generation_count ?? 0),
    sourceRowCount: Number(row?.source_row_count ?? 0),
    logicalBytes: Number(row?.logical_bytes ?? 0),
    oldestEligibleAt: row?.oldest_eligible_at ?? null,
  };
}

export async function loadMeasuredArchiveArtifact(
  db: D1Database,
  candidate: MeasuredArchiveCandidate,
  now: number,
  signal?: AbortSignal,
): Promise<LoadedMeasuredArchiveArtifact> {
  throwIfAborted(signal);
  const cutoff = now - HOT_RETENTION_SEC;
  const sourceLedger = await loadLedger(db, candidate.surface, candidate.generationId);
  assertCompleteSupersededLedger(sourceLedger, candidate.surface, cutoff);
  if (sourceLedger.expected_rows !== candidate.expectedRows) {
    throw new Error(`Measured archive candidate count changed: ${candidate.generationId}`);
  }

  if (candidate.kind === "target") {
    const referenced = await db
      .prepare(
        "SELECT 1 AS present FROM dex_measured_execution_quotes WHERE target_generation_id = ? LIMIT 1",
      )
      .bind(candidate.generationId)
      .first<{ present: number }>();
    if (referenced) throw new Error(`Measured target became referenced: ${candidate.generationId}`);
    const targets = await loadPagedTargets(db, candidate.generationId, signal);
    if (targets.length !== sourceLedger.expected_rows) {
      throw new Error(`Measured target archive row mismatch: ${candidate.generationId}`);
    }
    const tables: DexArchiveTable[] = [
      {
        name: "surface_publication_generations",
        columns: [...LEDGER_COLUMNS],
        rows: [ledgerValues(sourceLedger)],
      },
      {
        name: "dex_measured_execution_targets",
        columns: [...TARGET_COLUMNS],
        rows: targets.map(targetValues),
      },
    ];
    return {
      candidate,
      objectKey: buildMeasuredArchiveObjectKey(
        "target",
        candidate.generationId,
        candidate.sourceSlotStartedAt,
      ),
      artifactInput: {
        family: "measured-target-generation",
        generationId: candidate.generationId,
        sourceSlotStartedAt: candidate.sourceSlotStartedAt,
        publication: publicationFromLedger(sourceLedger),
        producerVersion: sourceLedger.worker_version,
        dependencyGenerationIds: [],
        tables,
        rowCount: targets.length,
        dependencyRowCount: 0,
      },
    };
  }

  const targetGenerationId = candidate.dependencyGenerationId;
  if (!targetGenerationId || !isQuoteSurface(candidate.surface)) {
    throw new Error(`Measured quote dependency missing: ${candidate.generationId}`);
  }
  const targetSurface = TARGET_SURFACE_BY_QUOTE[candidate.surface];
  const targetLedger = await loadLedger(db, targetSurface, targetGenerationId);
  assertCompleteSupersededLedger(targetLedger, targetSurface, cutoff);
  const [quotes, targets] = await Promise.all([
    loadPagedQuotes(db, candidate.generationId, signal),
    loadPagedTargets(db, targetGenerationId, signal),
  ]);
  if (
    quotes.length !== sourceLedger.expected_rows
    || targets.length !== targetLedger.expected_rows
    || quotes.length !== targets.length
    || quotes.some((row) => row.target_generation_id !== targetGenerationId)
    || quotes.some((row, index) => row.target_id !== targets[index]?.target_id)
  ) {
    throw new Error(`Measured quote archive dependency closure mismatch: ${candidate.generationId}`);
  }
  const tables: DexArchiveTable[] = [
    {
      name: "surface_publication_generations",
      columns: [...LEDGER_COLUMNS],
      rows: [sourceLedger, targetLedger]
        .sort(
          (left, right) =>
            left.surface.localeCompare(right.surface)
            || left.generation_id.localeCompare(right.generation_id),
        )
        .map(ledgerValues),
    },
    {
      name: "dex_measured_execution_quotes",
      columns: [...QUOTE_COLUMNS],
      rows: quotes.map(quoteValues),
    },
    {
      name: "dex_measured_execution_targets",
      columns: [...TARGET_COLUMNS],
      rows: targets.map(targetValues),
    },
  ];
  return {
    candidate,
    objectKey: buildMeasuredArchiveObjectKey(
      "quote",
      candidate.generationId,
      candidate.sourceSlotStartedAt,
    ),
    artifactInput: {
      family: "measured-quote-generation",
      generationId: candidate.generationId,
      sourceSlotStartedAt: candidate.sourceSlotStartedAt,
      publication: publicationFromLedger(sourceLedger),
      producerVersion: sourceLedger.worker_version,
      dependencyGenerationIds: [targetGenerationId],
      tables,
      rowCount: quotes.length,
      dependencyRowCount: targets.length,
    },
  };
}
