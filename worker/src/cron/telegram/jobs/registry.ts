import type {
  TelegramDeliveryInput,
  TelegramDeliveryState,
  TelegramJobKind,
  TelegramJobRow,
} from "../../../telegram/delivery/jobs";
import { buildBroadcastJobPage, type TelegramBroadcastJobPayload } from "../../../telegram/delivery/broadcast-targets";
import { alertJobHandler } from "./alert-job";
import { freezeJobHandler } from "./freeze-job";
import { freezeBatchJobHandler } from "../rollup/rollup-step";

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
export interface TelegramJobKindHandler<P = unknown> {
  kind: TelegramJobKind;
  buildPage?: (ctx: TelegramJobPageContext<P>) => Promise<TelegramJobPage>;
  onDone?: (ctx: TelegramJobDoneContext<P>) => Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TELEGRAM_JOB_KIND_HANDLERS: Partial<Record<TelegramJobKind, TelegramJobKindHandler<any>>> = {
  alert: alertJobHandler,
  freeze: freezeJobHandler,
  freeze_batch: freezeBatchJobHandler,
  broadcast: {
    kind: "broadcast",
    buildPage: (ctx) => buildBroadcastJobPage(ctx),
  } satisfies TelegramJobKindHandler<TelegramBroadcastJobPayload>,
};
