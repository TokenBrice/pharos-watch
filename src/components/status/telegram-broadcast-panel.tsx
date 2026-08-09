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
import { useAdminMutationIntents } from "@/components/status/admin-mutation-intent";

const BROADCAST_PATH = "/api/admin-telegram-broadcast";
const DRY_RUN_LANE = "telegram-broadcast:dry-run";
const LIVE_LANE = "telegram-broadcast:live";
const MESSAGE_HTML_MAX_LENGTH = 16_000;

const FIELD_CLASS_NAME =
  "min-h-11 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring";

const SCOPE_OPTIONS = [
  { value: "all", label: "All subscribers" },
  { value: "deliverable-watchers", label: "Deliverable watchers (any alert or preset follow)" },
  { value: "global-subscribers", label: "Global subscribers (global alert flags only)" },
] as const;

type BroadcastScope = (typeof SCOPE_OPTIONS)[number]["value"];

interface BroadcastFormState {
  messageHtml: string;
  scope: BroadcastScope;
  canaryChatId: string;
}

function buildBody(state: BroadcastFormState, dryRun: boolean): Record<string, unknown> {
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
  const { executions, execute, retrySame, executeNew } = useAdminMutationIntents();

  const dryRunExecution = executions[DRY_RUN_LANE];
  const liveExecution = executions[LIVE_LANE];
  const busy = dryRunExecution?.requestInFlight === true || liveExecution?.requestInFlight === true;

  const trimmedMessage = state.messageHtml.trim();
  const canaryChatId = state.canaryChatId.trim();
  const messageTooLong = state.messageHtml.length > MESSAGE_HTML_MAX_LENGTH;
  const canPreview = trimmedMessage.length > 0 && !messageTooLong;
  const canaryValid = /^[1-9]\d*$/.test(canaryChatId);
  const previewConfirmed = dryRunExecution?.status === "succeeded";
  const canSendLive = canPreview && canaryValid && previewConfirmed;

  function patch(next: Partial<BroadcastFormState>) {
    setState((previous) => ({ ...previous, ...next }));
  }

  async function run(lane: string, dryRun: boolean, mode: "start" | "retry" | "new") {
    const request = { laneKey: lane, path: BROADCAST_PATH, body: buildBody(state, dryRun) };
    const result =
      mode === "retry" ? await retrySame(lane) : mode === "new" ? await executeNew(request) : await execute(request);
    if (!result.didStart) return;
    if (result.execution.status === "succeeded") {
      setReceipt({
        receipt: buildAdminMutationReceiptMetadata(result.execution),
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
          <p className="pharos-numeric text-[11px] text-muted-foreground">
            {state.messageHtml.length.toLocaleString()} / {MESSAGE_HTML_MAX_LENGTH.toLocaleString()} characters
            {messageTooLong ? " — too long" : ""}. Only Telegram-supported tags are accepted; raw {"<"} must be escaped
            as &amp;lt;.
          </p>

          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Audience</span>
              <select
                className={FIELD_CLASS_NAME}
                value={state.scope}
                onChange={(event) => patch({ scope: event.target.value as BroadcastScope })}
              >
                {SCOPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
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
            <pre className="max-h-64 overflow-auto rounded-md border border-border/60 bg-background/35 p-2 text-[11px]">
              {dryRunExecution.output}
            </pre>
          </div>
        ) : null}

        {liveExecution?.status === "succeeded" && liveExecution.output ? (
          <div className="space-y-1">
            <h4 className="text-xs font-medium text-muted-foreground">Live result</h4>
            <pre className="max-h-64 overflow-auto rounded-md border border-border/60 bg-background/35 p-2 text-[11px]">
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
