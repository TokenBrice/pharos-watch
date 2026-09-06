"use client";

import { Check, Clock3, Home, Send, ShieldAlert } from "lucide-react";
import { RECOMMENDED_OPERATION, SNOOZE_DURATION_TOKENS } from "../constants";
import { isPausedSentinel } from "@shared/lib/telegram-delivery-policy";
import { formatQuietHoursRange, formatSnoozePill, formatTime } from "../format";
import type {
  TelegramMiniAppOperation,
  TelegramMiniAppState,
} from "../types";
import { MiniButton } from "./MiniButton";

export interface StatusPanelProps {
  /** Last server-confirmed state; reading `subscriber`, `viewer`, `health`. */
  state: TelegramMiniAppState;
  /** Whether the user has write access AND `initData` is present. */
  canMutate: boolean;
  /** True while a mutation POST is in flight. Disables every action button. */
  isMutating: boolean;
  /** Mutation currently in flight, used for scoped control feedback. */
  pendingOperation: TelegramMiniAppOperation | null;
  /** Server-confirmed mutation dispatcher. */
  onMutate: (operation: TelegramMiniAppOperation) => void;
  /** Pre-computed headline summary (active globals, coin count, preset count). */
  homeHeadline: string;
  /** "missed" → show CTA; "added" / null → hide. Plumbed from `useMiniAppMutations`. */
  homeScreenStatus: string | null;
  /** `webApp.addToHomeScreen` + haptic + checkHomeScreenStatus refresh. */
  onAddToHomeScreen: () => void;
  /**
   * Deep-links into the bot DM to trigger the synthetic `/sample` alert. Undefined
   * when the client lacks `webApp.openTelegramLink`, which hides the CTA entirely
   * (the Mini App cannot call the Bot API directly).
   */
  onSendSample?: () => void;
}

export const STALE_AUTH_READ_ONLY_COPY = {
  title: "Reopen Telegram to edit settings",
  body: "This session is still readable, but edits require a fresh launch from Telegram.",
} as const;

function failureCopy(failureClass: string | null): { title: string; body: string; urgent: boolean } | null {
  if (!failureClass) return null;
  if (failureClass === "blocked" || failureClass === "forbidden") {
    return {
      title: "Alerts paused by Telegram",
      body: "Telegram rejected recent deliveries. Message PharosWatchBot again to reopen delivery, then re-enable the alert families you want.",
      urgent: true,
    };
  }
  return {
    title: "Recent delivery issue",
    body: `Last Telegram delivery failed with ${failureClass}. Replies can still work while the next alert retries through the queue.`,
    urgent: false,
  };
}

export function StatusPanel({ state, canMutate, isMutating, pendingOperation, onMutate, homeHeadline, homeScreenStatus, onAddToHomeScreen, onSendSample }: StatusPanelProps) {
  const snoozeUntil = state.subscriber.snoozeUntilTs;
  const snoozeActive = snoozeUntil != null;
  const paused = isPausedSentinel(snoozeUntil);
  const showGroupReadOnlyCopy = !state.viewer.canMutate && state.viewer.mutationBlockReason !== "stale-auth";
  const recentFailure = failureCopy(state.health.recentFailureClass);
  const lastDelivery = formatTime(state.health.lastSuccessfulDeliveryAt);
  const lastReply = formatTime(state.health.lastSuccessfulReplyAt);

  return (
    <div className="space-y-4">
      {showGroupReadOnlyCopy ? (
        <section className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
          <div className="flex gap-3">
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" />
            <div>
              <h2 className="text-sm font-semibold text-foreground">Group settings are command-only for now</h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Use{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.6875rem] text-foreground">
                  /settings@PharosWatchBot
                </code>{" "}
                in the group. Only group admins can change alert settings.
              </p>
            </div>
          </div>
        </section>
      ) : null}
      {recentFailure ? (
        <section className={`rounded-2xl border p-4 ${recentFailure.urgent ? "border-red-500/30 bg-red-500/10" : "border-amber-500/30 bg-amber-500/10"}`}>
          <div className="flex gap-3">
            <ShieldAlert className={`mt-0.5 h-5 w-5 shrink-0 ${recentFailure.urgent ? "text-red-700 dark:text-red-300" : "text-amber-700 dark:text-amber-300"}`} aria-hidden="true" />
            <div>
              <h2 className="text-sm font-semibold text-foreground">{recentFailure.title}</h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{recentFailure.body}</p>
            </div>
          </div>
        </section>
      ) : null}

      <section className="rounded-2xl border border-border/70 bg-card/90 p-4">
        <p className="pharos-kicker">Watcher state</p>
        <h2 className="mt-1 text-xl font-semibold tracking-tight text-foreground">{state.subscriber.exists ? "Alerts are active" : "No active watcher yet"}</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {state.subscriber.exists ? homeHeadline : "Start with the recommended setup for DEWS and depeg alerts on the top USD stablecoins."}
        </p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <MiniButton
            disabled={!canMutate || isMutating}
            loading={pendingOperation?.kind === "recommended-setup"}
            onClick={() => onMutate(RECOMMENDED_OPERATION)}
          >
            <Check className="h-4 w-4" aria-hidden="true" /> Use recommended setup
          </MiniButton>
          {homeScreenStatus === "missed" ? (
            <MiniButton variant="secondary" disabled={!canMutate || isMutating} onClick={onAddToHomeScreen}>
              <Home className="h-4 w-4" aria-hidden="true" /> Add to home screen
            </MiniButton>
          ) : null}
        </div>
        <div className="mt-4 border-t border-border/60 pt-4">
          <div className="flex items-center justify-between gap-3">
            <p className="pharos-kicker">Snooze alerts</p>
            {snoozeActive ? (
              <span className="mini-selected shrink-0 rounded-md border px-2 py-1 text-[11px] font-semibold">
                {paused
                  ? "Paused indefinitely"
                  : <>Quiet until <span className="pharos-numeric">{formatSnoozePill(snoozeUntil)}</span></>}
              </span>
            ) : null}
          </div>
          {snoozeActive ? (
            <div className="mt-3">
              <MiniButton
                variant="secondary"
                disabled={!canMutate || isMutating}
                loading={pendingOperation?.kind === "clear-snooze"}
                onClick={() => onMutate({ kind: "clear-snooze" })}
              >
                <Clock3 className="h-4 w-4" aria-hidden="true" /> {paused ? "Resume alerts" : "Clear snooze"}
              </MiniButton>
            </div>
          ) : (
            <>
              <div className="mt-3 grid grid-cols-3 gap-2" role="group" aria-label="Snooze alerts">
                {SNOOZE_DURATION_TOKENS.map((token) => (
                  <MiniButton
                    key={token}
                    ariaLabel={`Snooze alerts for ${token}`}
                    variant="secondary"
                    disabled={!canMutate || isMutating}
                    loading={pendingOperation?.kind === "set-snooze" && pendingOperation.durationToken === token}
                    onClick={() => onMutate({ kind: "set-snooze", durationToken: token })}
                  >
                    {token}
                  </MiniButton>
                ))}
              </div>
              <div className="mt-2">
                <MiniButton
                  ariaLabel="Pause all alerts indefinitely"
                  variant="secondary"
                  disabled={!canMutate || isMutating}
                  loading={pendingOperation?.kind === "pause"}
                  onClick={() => onMutate({ kind: "pause" })}
                >
                  <Clock3 className="h-4 w-4" aria-hidden="true" /> Pause indefinitely
                </MiniButton>
              </div>
            </>
          )}
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-2">
        <section className="rounded-2xl border border-border/70 bg-card/90 p-4">
          <p className="pharos-kicker">Quiet hours</p>
          <p className="mt-2 text-lg font-semibold text-foreground pharos-numeric">
            {state.subscriber.quietHours.enabled
              ? formatQuietHoursRange(
                state.subscriber.quietHours.startHourUtc,
                state.subscriber.quietHours.endHourUtc,
                state.subscriber.quietHours.timezone,
              )
              : "Off"}
          </p>
        </section>
        <section className="rounded-2xl border border-border/70 bg-card/90 p-4">
          <p className="pharos-kicker">Last delivery</p>
          <p className="mt-2 text-lg font-semibold text-foreground pharos-numeric">{lastDelivery}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Last reply <span className="pharos-numeric">{lastReply}</span> · <span className="pharos-numeric">{state.health.queuedAlerts}</span> queued alerts
          </p>
        </section>
      </div>

      {onSendSample ? (
        <div>
          <MiniButton variant="secondary" ariaLabel="Send me a sample alert" onClick={onSendSample}>
            <Send className="h-4 w-4" aria-hidden="true" /> Send me a sample alert
          </MiniButton>
          <p className="pharos-meta mt-2">Opens a chat with PharosWatchBot and previews a sample alert.</p>
        </div>
      ) : null}
    </div>
  );
}
