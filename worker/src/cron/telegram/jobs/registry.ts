import type { TelegramJobKind } from "../../../telegram/delivery/jobs";
import { buildBroadcastJobPage, type TelegramBroadcastJobPayload } from "../../../telegram/delivery/broadcast-targets";
import type { FreezeAlert } from "../../../telegram/common/alerts-formatting";
import type { FreezeBatchJobPayload } from "../rollup/rollup-step";
import type { TelegramJobKindHandler } from "../../../telegram/delivery/job-handler";
import { alertJobHandler, type TelegramAlertJobPayload } from "./alert-job";
import { freezeJobHandler } from "./freeze-job";
import { freezeBatchJobHandler } from "../rollup/rollup-step";

type TelegramJobPayloads = {
  alert: TelegramAlertJobPayload;
  freeze: FreezeAlert;
  freeze_batch: FreezeBatchJobPayload;
  broadcast: TelegramBroadcastJobPayload;
};

type TelegramJobHandlers = {
  [K in Exclude<TelegramJobKind, "rollup" | "digest">]: TelegramJobKindHandler<TelegramJobPayloads[K], K>;
} & { rollup?: never; digest?: never };

const TELEGRAM_JOB_KIND_HANDLERS: TelegramJobHandlers = {
  alert: alertJobHandler,
  freeze: freezeJobHandler,
  freeze_batch: freezeBatchJobHandler,
  broadcast: {
    kind: "broadcast",
    buildPage: (ctx) => buildBroadcastJobPage(ctx),
  } satisfies TelegramJobKindHandler<TelegramBroadcastJobPayload>,
};

export function getTelegramJobKindHandler(kind: TelegramJobKind): TelegramJobKindHandler | undefined {
  return TELEGRAM_JOB_KIND_HANDLERS[kind] as TelegramJobKindHandler | undefined;
}
