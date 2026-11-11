"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AdminMutationFeedback,
  AdminMutationReceipt,
  buildAdminMutationReceiptMetadata,
  type AdminMutationReceiptMetadata,
} from "@/components/status/admin-mutation-feedback";
import {
  type AdminMutationIntentMode,
  useAdminMutationIntents,
} from "@/components/status/admin-mutation-intent";
import { STATUS_PANEL_SHELL_CLASS } from "@/components/status/page-primitives";
import { cn } from "@/lib/utils";
import {
  TELEGRAM_BROADCAST_MESSAGE_HTML_MAX_LENGTH,
  TELEGRAM_BROADCAST_SCOPES,
  TELEGRAM_PRIVATE_CHAT_ID_PATTERN,
  type TelegramBroadcastRequest,
  type TelegramBroadcastScope,
} from "@shared/lib/telegram-broadcast-contract";

const BROADCAST_PATH = "/api/admin-telegram-broadcast";
const DRY_RUN_LANE = "telegram-broadcast:dry-run";
const LIVE_LANE = "telegram-broadcast:live";

const FIELD_CLASS_NAME =
  "min-h-11 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring";

const SCOPE_LABELS: Record<TelegramBroadcastScope, string> = {
  all: "All subscribers",
  "deliverable-watchers": "Deliverable watchers (any alert or preset follow)",
  "global-subscribers": "Global subscribers (global alert flags only)",
};

interface BroadcastFormState {
  messageHtml: string;
  scope: TelegramBroadcastScope;
  canaryChatId: string;
}

function buildBody(state: BroadcastFormState, dryRun: boolean): TelegramBroadcastRequest {
  const canaryChatId = state.canaryChatId.trim();
  return {
    messageHtml: state.messageHtml,
    scope: state.scope,
    dryRun,
    ...(canaryChatId ? { canaryChatId } : {}),
  };
}

export function TelegramBroadcastPanel() {
  const [state, setState] = useState<BroadcastFormState>({
    messageHtml: "",
    scope: "all",
    canaryChatId: "",
  });
  const [receipt, setReceipt] = useState<{ receipt: AdminMutationReceiptMetadata; message: string } | null>(null);
  const [previewedDraft, setPreviewedDraft] = useState<{ messageHtml: string; scope: TelegramBroadcastScope } | null>(null);
  const { executions, runIntent } = useAdminMutationIntents();

  const dryRunExecution = executions[DRY_RUN_LANE];
  const liveExecution = executions[LIVE_LANE];
  const busy = dryRunExecution?.requestInFlight === true || liveExecution?.requestInFlight === true;

  const trimmedMessage = state.messageHtml.trim();
  const canaryChatId = state.canaryChatId.trim();
  const messageTooLong = state.messageHtml.length > TELEGRAM_BROADCAST_MESSAGE_HTML_MAX_LENGTH;
  const canPreview = trimmedMessage.length > 0 && !messageTooLong;
  const canaryValid = TELEGRAM_PRIVATE_CHAT_ID_PATTERN.test(canaryChatId);
  // A lane-level success alone would let an edited message/audience go out
  // unreviewed: the live send may only transmit the exact draft that was
  // previewed.
  const previewConfirmed =
    dryRunExecution?.status === "succeeded" &&
    previewedDraft?.messageHtml === state.messageHtml &&
    previewedDraft?.scope === state.scope;
  const canSendLive = canPreview && canaryValid && previewConfirmed;

  function patch(next: Partial<BroadcastFormState>) {
    setState((previous) => ({ ...previous, ...next }));
  }

  // Guard every live-lane action, including the failure banner's retry and
  // new-intent actions, so none can send without a matching preview.
  async function run(lane: string, dryRun: boolean, mode: AdminMutationIntentMode) {
    if (!dryRun && !canSendLive) return;
    const execution = await runIntent({
      laneKey: lane,
      mode,
      buildRequest: () => ({ laneKey: lane, path: BROADCAST_PATH, body: buildBody(state, dryRun) }),
      // The preview is the primary action and is re-runnable, so a "new"
      // intent must carry the *current* draft rather than replaying the
      // previously previewed message.
      replayStoredRequest: false,
    });
    if (execution === null) return;
    if (execution.status === "succeeded") {
      // Same-intent retries replay the original request, even if the form
      // changed after an uncertain outcome. Certify only that executed body.
      if (dryRun) {
        const body = execution.request.body as TelegramBroadcastRequest;
        setPreviewedDraft({ messageHtml: body.messageHtml, scope: body.scope });
      }
      setReceipt({
        receipt: buildAdminMutationReceiptMetadata(execution),
        message: dryRun
          ? "Broadcast preview completed. Review the projected fan-out below before sending live."
          : "Broadcast accepted. The canary was delivered and the fleet fan-out is queued for the dispatch cron.",
      });
    } else {
      setReceipt(null);
    }
  }

  return (
    <Card className="min-w-0 max-w-full">
      <CardHeader>
        <CardTitle as="h3" className="text-base">
          Operator Broadcast
        </CardTitle>
      </CardHeader>
      <CardContent className="min-w-0 space-y-4">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Sends a pre-rendered Telegram HTML message through the normal pending-queue fan-out. Preview first: the dry
          run reports the target chat count, chunking, and whether the projected backlog still fits inside the admin TTL
          reserve. A live send requires a private canary chat, delivers the exact chunks there first, and refuses the
          fleet fan-out if the canary is rejected.
        </p>

        <div className="grid min-w-0 gap-3">
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Message (Telegram HTML)</span>
            <textarea
              rows={6}
              className={`${FIELD_CLASS_NAME} font-mono`}
              value={state.messageHtml}
              placeholder="<b>Pharos maintenance</b>&#10;The bot will be offline 10:00-10:15 UTC."
              onChange={(event) => patch({ messageHtml: event.target.value })}
            />
          </label>
          <p className="pharos-numeric text-2xs text-muted-foreground">
            {state.messageHtml.length.toLocaleString()} / {TELEGRAM_BROADCAST_MESSAGE_HTML_MAX_LENGTH.toLocaleString()} characters
            {messageTooLong ? " — too long" : ""}. Only Telegram-supported tags are accepted; raw {"<"} must be escaped
            as &amp;lt;.
          </p>

          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Audience</span>
              <select
                className={FIELD_CLASS_NAME}
                value={state.scope}
                onChange={(event) => patch({ scope: event.target.value as TelegramBroadcastScope })}
              >
                {TELEGRAM_BROADCAST_SCOPES.map((scope) => (
                  <option key={scope} value={scope}>
                    {SCOPE_LABELS[scope]}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Canary chat ID (private chat)</span>
              <input
                inputMode="numeric"
                className={FIELD_CLASS_NAME}
                value={state.canaryChatId}
                placeholder="123456789"
                onChange={(event) => patch({ canaryChatId: event.target.value })}
              />
            </label>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11"
            disabled={!canPreview || busy}
            onClick={() => void run(DRY_RUN_LANE, true, "new")}
          >
            {dryRunExecution?.requestInFlight ? "Previewing..." : "Preview (dry run)"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            className="min-h-11"
            disabled={!canSendLive || busy}
            onClick={() => void run(LIVE_LANE, false, "start")}
          >
            {liveExecution?.requestInFlight ? "Sending..." : "Send live broadcast"}
          </Button>
        </div>

        {!previewConfirmed ? (
          <p className="text-xs text-muted-foreground">Run a dry-run preview before the live send is enabled.</p>
        ) : !canaryValid ? (
          <p className="text-xs text-muted-foreground">
            A live send requires a numeric private canary chat ID; the fleet fan-out is refused without a passing canary.
          </p>
        ) : null}

        <AdminMutationReceipt receipt={receipt?.receipt ?? null} message={receipt?.message ?? null} />

        {dryRunExecution?.status === "succeeded" && dryRunExecution.output ? (
          <div className="space-y-1">
            <h4 className="text-xs font-medium text-muted-foreground">Preview</h4>
            <pre className={cn("max-h-64 overflow-auto rounded-md p-2 text-2xs", STATUS_PANEL_SHELL_CLASS)}>
              {dryRunExecution.output}
            </pre>
          </div>
        ) : null}

        {liveExecution?.status === "succeeded" && liveExecution.output ? (
          <div className="space-y-1">
            <h4 className="text-xs font-medium text-muted-foreground">Live result</h4>
            <pre className={cn("max-h-64 overflow-auto rounded-md p-2 text-2xs", STATUS_PANEL_SHELL_CLASS)}>
              {liveExecution.output}
            </pre>
          </div>
        ) : null}

        <AdminMutationFeedback
          execution={dryRunExecution}
          onRetrySame={() => void run(DRY_RUN_LANE, true, "retry")}
          onStartNew={() => void run(DRY_RUN_LANE, true, "new")}
          newIntentLabel="Start new preview intent"
        />
        <AdminMutationFeedback
          execution={liveExecution}
          onRetrySame={() => void run(LIVE_LANE, false, "retry")}
          onStartNew={() => void run(LIVE_LANE, false, "new")}
          newIntentLabel="Start new broadcast intent"
        />
      </CardContent>
    </Card>
  );
}
