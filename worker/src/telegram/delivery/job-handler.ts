import type {
  TelegramDeliveryInput,
  TelegramDeliveryState,
  TelegramJobRow,
} from "./jobs";

export interface TelegramJobPageContext<P> {
  db: D1Database;
  job: TelegramJobRow;
  payload: P;
  cursor: string | null;
  nowSec: number;
  /** Max chats to build in this page. */
  limit: number;
  signal?: AbortSignal;
}

export interface TelegramJobPage {
  deliveries: TelegramDeliveryInput[];
  /** Opaque resume point; null when fan-out is complete (job becomes `ready`). */
  nextCursor: string | null;
}

export interface TelegramJobDoneContext<P> {
  db: D1Database;
  job: TelegramJobRow;
  payload: P;
  counts: Partial<Record<TelegramDeliveryState, number>>;
}

/**
 * Per-kind behavior. `buildPage` is required for jobs enqueued without direct
 * deliveries; it must be deterministic per cursor (rows insert with INSERT OR
 * IGNORE) and throw to fail closed. `onDone` runs before the job is marked
 * `done`, so it must be idempotent: a crash in between re-runs it.
 */
export interface TelegramJobKindHandler<P = unknown, K extends TelegramJobRow["kind"] = TelegramJobRow["kind"]> {
  kind: K;
  buildPage?: (ctx: TelegramJobPageContext<P>) => Promise<TelegramJobPage>;
  onDone?: (ctx: TelegramJobDoneContext<P>) => Promise<void>;
}
