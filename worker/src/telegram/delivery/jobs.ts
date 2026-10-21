import { TELEGRAM_PENDING_PRIORITY } from "@shared/lib/telegram-delivery-policy";
import { chunkArray, D1_MAX_BOUND_PARAMETERS, executeAtomicBatch } from "../../lib/db";
import { D1_BATCH_SIZE } from "../../lib/constants";
import { fnv1a32 } from "@shared/lib/fnv1a";
import { TELEGRAM_SPLIT_VERSION } from "../common/constants";
import type { LinkPreviewOptions } from "./telegram";

/**
 * Telegram delivery v2 job API (contract:
 * agents/2026-10-21-telegram-bot-review/c-job-api.md, durable docs:
 * docs/telegram-architecture.md#delivery). A job is one logical send
 * (an alert event, a freeze event, a broadcast, a digest edition, a roll-up);
 * each job owns one `telegram_deliveries` row per (chat, chunk).
 */
export type TelegramJobKind = "alert" | "freeze" | "freeze_batch" | "rollup" | "broadcast" | "digest";
export type TelegramJobState = "planning" | "ready" | "done" | "cancelled";
export type TelegramDeliveryState =
  | "pending"
  | "retry"
  | "sending"
  | "sent"
  | "failed"
  | "blocked"
  | "expired"
  | "cancelled"
  | "unknown"
  | "suppressed_duplicate";

/** Drain-time chat checks applied to a delivery (see `job-drain.ts`). */
export type TelegramDeliveryAudience = "alert" | "notice" | "channel";

/** Same-chat identical-body suppression window (the legacy 24 h anti-flap). */
const TELEGRAM_DUPLICATE_BODY_WINDOW_SEC = 24 * 60 * 60;

/** Prior row states that make an identical body for the same chat a duplicate. */
const TELEGRAM_DUPLICATE_PRIOR_STATES = ["pending", "retry", "sending", "sent", "unknown"] as const;

export interface TelegramDeliveryInput {
  chatId: string;
  seq?: number;
  method?: "sendMessage" | "sendPhoto";
  body: string;
  photoUrl?: string;
  replyMarkup?: unknown;
  linkPreviewOptions?: LinkPreviewOptions;
  disableWebPagePreview?: boolean;
  disableNotification?: boolean;
  audience?: TelegramDeliveryAudience;
  coinIds?: readonly string[];
  families?: readonly string[];
  priority?: number;
  expiresAt?: number;
  notBefore?: number;
  /** Canonical pre-split body; enables 24 h same-chat identical-body suppression. */
  dedupeBody?: string;
}

export interface TelegramJobSpec<P = unknown> {
  jobId: string;
  kind: TelegramJobKind;
  payload: P;
  createdAt: number;
  expiresAt: number;
  deliveries?: readonly TelegramDeliveryInput[];
}

export interface TelegramJobRow {
  job_id: string;
  kind: TelegramJobKind;
  payload_json: string;
  state: TelegramJobState;
  cursor: string | null;
  planned_count: number;
  created_at: number;
  expires_at: number;
  completed_at: number | null;
  error: string | null;
}

/** Send options persisted in `options_json`. */
export interface TelegramDeliveryOptions {
  photoUrl?: string;
  replyMarkup?: unknown;
  linkPreviewOptions?: LinkPreviewOptions;
  disableWebPagePreview?: boolean;
  disableNotification?: boolean;
}

const DEFAULT_PRIORITY_BY_KIND: Record<TelegramJobKind, number> = {
  alert: TELEGRAM_PENDING_PRIORITY.riskAlert,
  freeze: TELEGRAM_PENDING_PRIORITY.freeze,
  freeze_batch: TELEGRAM_PENDING_PRIORITY.reserve,
  rollup: TELEGRAM_PENDING_PRIORITY.reserve,
  broadcast: TELEGRAM_PENDING_PRIORITY.adminBroadcast,
  digest: TELEGRAM_PENDING_PRIORITY.riskAlert,
};

function defaultPriority(kind: TelegramJobKind, families: readonly string[] | undefined): number {
  const familyPriorities = (families ?? [])
    .map((family) => (TELEGRAM_PENDING_PRIORITY as Record<string, number>)[family])
    .filter((value): value is number => Number.isFinite(value));
  return familyPriorities.length > 0 ? Math.min(...familyPriorities) : DEFAULT_PRIORITY_BY_KIND[kind];
}

function serializeOptions(input: TelegramDeliveryInput): string | null {
  const options: TelegramDeliveryOptions = {
    ...(input.photoUrl ? { photoUrl: input.photoUrl } : {}),
    ...(input.replyMarkup != null ? { replyMarkup: input.replyMarkup } : {}),
    ...(input.linkPreviewOptions ? { linkPreviewOptions: input.linkPreviewOptions } : {}),
    ...(input.disableWebPagePreview ? { disableWebPagePreview: true } : {}),
    ...(input.disableNotification ? { disableNotification: true } : {}),
  };
  return Object.keys(options).length > 0 ? JSON.stringify(options) : null;
}

/** Per-chat body identity used by the 24 h duplicate suppression. */
function hashTelegramDeliveryBody(seq: number, body: string): string {
  return `v${TELEGRAM_SPLIT_VERSION}:${seq}:${fnv1a32(body).toString(36)}`;
}

const DELIVERY_COLUMNS = [
  "job_id", "kind", "chat_id", "seq", "audience", "method", "body", "body_hash",
  "options_json", "coin_ids", "families", "priority", "next_attempt_at", "expires_at",
  "dedupe",
] as const;

/**
 * One multi-row INSERT OR IGNORE per chunk of rows. A row with a dedupe body
 * whose (chat, body hash) matches a live or delivered row of another job from
 * the last 24 h is written terminal as `suppressed_duplicate` (body dropped),
 * which keeps the legacy anti-flap and makes it countable. Each statement
 * returns the `state` of every row it wrote.
 */
export function buildTelegramDeliveryInsertStatements(
  db: D1Database,
  job: { jobId: string; kind: TelegramJobKind; expiresAt: number },
  deliveries: readonly TelegramDeliveryInput[],
  nowSec: number,
): D1PreparedStatement[] {
  if (deliveries.length === 0) return [];
  const rows = deliveries.map((input) => {
    const seq = input.seq ?? 0;
    const method = input.method ?? "sendMessage";
    if (method === "sendPhoto" && !input.photoUrl) {
      throw new Error("Telegram sendPhoto delivery requires photoUrl");
    }
    return [
      job.jobId,
      job.kind,
      input.chatId,
      seq,
      input.audience ?? "alert",
      method,
      input.body,
      hashTelegramDeliveryBody(seq, input.dedupeBody ?? input.body),
      serializeOptions(input),
      input.coinIds && input.coinIds.length > 0 ? [...new Set(input.coinIds)].join(",") : null,
      input.families && input.families.length > 0 ? [...new Set(input.families)].join(",") : null,
      input.priority ?? defaultPriority(job.kind, input.families),
      input.notBefore ?? nowSec,
      input.expiresAt ?? job.expiresAt,
      input.dedupeBody != null ? 1 : 0,
    ] as const;
  });
  const fixedBinds = 2;
  const rowsPerStatement = Math.floor((D1_MAX_BOUND_PARAMETERS - fixedBinds) / DELIVERY_COLUMNS.length);
  const priorStates = TELEGRAM_DUPLICATE_PRIOR_STATES.map((state) => `'${state}'`).join(", ");
  // VALUES columns are column1..column15 in DELIVERY_COLUMNS order.
  return chunkArray(rows, rowsPerStatement).map((chunk) => {
    const placeholders = chunk
      .map(() => `(${DELIVERY_COLUMNS.map(() => "?").join(", ")})`)
      .join(", ");
    return db.prepare(
      `WITH p(now_sec, since_sec) AS (SELECT ?, ?)
       INSERT OR IGNORE INTO telegram_deliveries (
         job_id, kind, chat_id, seq, audience, method, body, body_hash, options_json,
         coin_ids, families, priority, next_attempt_at, expires_at, created_at,
         state, done_at, reason
       )
       SELECT v.column1, v.column2, v.column3, v.column4, v.column5, v.column6,
              CASE WHEN dup.hit = 1 THEN NULL ELSE v.column7 END,
              v.column8, v.column9, v.column10, v.column11, v.column12, v.column13, v.column14,
              p.now_sec,
              CASE WHEN dup.hit = 1 THEN 'suppressed_duplicate' ELSE 'pending' END,
              CASE WHEN dup.hit = 1 THEN p.now_sec ELSE NULL END,
              CASE WHEN dup.hit = 1 THEN 'duplicate_prior_delivery' ELSE NULL END
         FROM (VALUES ${placeholders}) AS v
        CROSS JOIN p
         LEFT JOIN (SELECT 1 AS hit) AS dup
           ON v.column15 = 1 AND EXISTS (
             SELECT 1 FROM telegram_deliveries prior
              WHERE prior.chat_id = v.column3
                AND prior.body_hash = v.column8
                AND prior.created_at >= p.since_sec
                AND prior.job_id <> v.column1
                AND prior.state IN (${priorStates})
           )
       RETURNING state`,
    ).bind(nowSec, nowSec - TELEGRAM_DUPLICATE_BODY_WINDOW_SEC, ...chunk.flat());
  });
}

/**
 * Statements for one job (INSERT OR IGNORE) plus its direct delivery rows.
 * Callers add them to their own atomic batch when the job must commit together
 * with another state change (a snapshot baseline, a cursor, a sent marker).
 */
export async function buildTelegramJobStatements(
  db: D1Database,
  spec: TelegramJobSpec,
): Promise<D1PreparedStatement[]> {
  const direct = spec.deliveries != null;
  const statements = [
    db.prepare(
      `INSERT OR IGNORE INTO telegram_jobs (
         job_id, kind, payload_json, state, cursor, planned_count, created_at, expires_at
       ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
    ).bind(
      spec.jobId,
      spec.kind,
      JSON.stringify(spec.payload ?? null),
      direct ? "ready" : "planning",
      direct ? spec.deliveries!.length : 0,
      spec.createdAt,
      spec.expiresAt,
    ),
  ];
  if (direct) {
    // INSERT OR IGNORE on (job, chat, seq): a replayed enqueue adds nothing.
    const insertStatements = buildTelegramDeliveryInsertStatements(
      db,
      { jobId: spec.jobId, kind: spec.kind, expiresAt: spec.expiresAt },
      spec.deliveries!,
      spec.createdAt,
    );
    statements.push(...insertStatements);
  }
  return statements;
}

/** Atomic, idempotent enqueue. `created` is false when the job id already existed. */
export async function enqueueTelegramJob(
  db: D1Database,
  spec: TelegramJobSpec,
): Promise<{ created: boolean }> {
  const statements = await buildTelegramJobStatements(db, spec);
  if (statements.length > D1_BATCH_SIZE) {
    throw new RangeError(
      `Telegram job ${spec.jobId} has too many direct deliveries for one atomic batch; use a fan-out builder`,
    );
  }
  const existing = await db.prepare("SELECT 1 AS present FROM telegram_jobs WHERE job_id = ?")
    .bind(spec.jobId)
    .first<{ present: number }>();
  if (existing) return { created: false };
  const results = await executeAtomicBatch(db, statements, { returnResults: true });
  return { created: Number(results[0]?.meta?.changes ?? 0) > 0 };
}

export function parseTelegramDeliveryOptions(raw: string | null): TelegramDeliveryOptions {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as TelegramDeliveryOptions
      : {};
  } catch {
    return {};
  }
}
