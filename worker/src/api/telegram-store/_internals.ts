/**
 * Compatibility re-export for the Telegram store's internal helpers.
 *
 * The operation-batch primitives live in `worker/src/lib` so API and cron
 * services share one implementation and preserve the same atomic statement
 * ordering.
 */
export {
  appendTelegramOperationStatements,
  d1ChangeCount,
} from "../../lib/telegram-operation-batch";
export type { TelegramOperationBatchOptions } from "../../lib/telegram-operation-batch";
