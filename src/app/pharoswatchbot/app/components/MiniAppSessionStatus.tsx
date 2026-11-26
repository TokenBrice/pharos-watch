"use client";

import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { TELEGRAM_BOT_URL } from "@shared/lib/telegram-bot-registration";
import type { MiniAppScreen } from "../use-mini-app-view";
import { HomeSkeleton } from "./HomeSkeleton";

export type MiniAppSessionStatus = "preview" | "loading" | "ready" | "stale" | "error";

const INLINE_BUTTON_CLASS = "pharos-focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold whitespace-nowrap";

function Callout({ tone, title, children, role = "status" }: {
  tone: "warn" | "danger";
  title: string;
  children: React.ReactNode;
  role?: "status" | "alert";
}) {
  return (
    <section role={role} aria-live={role === "status" ? "polite" : undefined} className="mb-5 flex gap-3 rounded-xl bg-[var(--mini-card)] px-4 py-3">
      <span aria-hidden="true" className={cn("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full", tone === "danger" ? "bg-state-danger-solid" : "bg-state-warn-solid")} />
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <div className="mt-0.5 text-sm leading-snug text-muted-foreground">{children}</div>
      </div>
    </section>
  );
}

interface MiniAppSessionStatusProps {
  status: MiniAppSessionStatus;
  screenName?: MiniAppScreen["name"];
  hasDisplayState: boolean;
  /** Local time the shown settings were last confirmed by the server. */
  refreshedAtMs: number | null;
  message: string | null;
  canClose: boolean;
  /** A retry exists (in the MainButton when `onRetry` is absent), so Close is not offered instead. */
  retryAvailable: boolean;
  /** True when the native MainButton already carries the reopen action. */
  relaunchInMainButton?: boolean;
  /** Terminal update-required state after a 409 version mismatch already ran its one-shot reload. */
  updateRequired?: boolean;
  /**
   * Non-null when launch auth expired for edits. When the 24h session read also
   * expired (`sessionExpired`), it replaces every other status banner.
   */
  staleAuth: { sessionExpired: boolean } | null;
  onClose: () => void;
  /** Inline actions render only where no Telegram MainButton carries them. */
  onRetry?: () => void;
  onStaleAuthRelaunch?: () => void;
  onUpdateReopen?: () => void;
}

export function MiniAppSessionStatus({
  status,
  screenName,
  hasDisplayState,
  refreshedAtMs,
  message,
  canClose,
  retryAvailable,
  relaunchInMainButton = false,
  updateRequired = false,
  staleAuth,
  onClose,
  onRetry,
  onStaleAuthRelaunch,
  onUpdateReopen,
}: MiniAppSessionStatusProps) {
  if (updateRequired) {
    const showBotFallback = !onUpdateReopen && !canClose && !relaunchInMainButton;
    return (
      <Callout tone="warn" title="Update required" role="alert">
        <p>Pharos was updated. Reopen it from PharosWatchBot to continue.</p>
        {onUpdateReopen || canClose || showBotFallback ? (
          <div className="mt-2 -ml-3 flex flex-wrap">
            {onUpdateReopen ? (
              <button type="button" onClick={onUpdateReopen} className={cn(INLINE_BUTTON_CLASS, "text-[color:var(--telegram-link,var(--mini-accent))]")}>Reopen</button>
            ) : null}
            {canClose ? (
              <button type="button" onClick={onClose} className={cn(INLINE_BUTTON_CLASS, "text-[color:var(--telegram-link,var(--mini-accent))]")}>Close</button>
            ) : null}
            {showBotFallback ? (
              <a href={TELEGRAM_BOT_URL} target="_blank" rel="noopener noreferrer" className={cn(INLINE_BUTTON_CLASS, "text-[color:var(--telegram-link,var(--mini-accent))]")}>
                Open PharosWatchBot <ExternalLink className="h-4 w-4" aria-hidden="true" />
              </a>
            ) : null}
          </div>
        ) : null}
      </Callout>
    );
  }

  const showStaleBotFallback = !onStaleAuthRelaunch && !canClose && !relaunchInMainButton;
  const staleAuthBanner = staleAuth ? (
    <Callout tone="warn" title={hasDisplayState && !staleAuth.sessionExpired ? "Editing paused" : "This window has expired"}>
      <p>
        {hasDisplayState
          ? "Telegram windows can save changes for 5 minutes. Reopen it to keep editing; your settings below are still current."
          : "Reopen it from PharosWatchBot to see your alerts."}
      </p>
      {onStaleAuthRelaunch || canClose || showStaleBotFallback ? (
        <div className="mt-2 -ml-3 flex flex-wrap">
          {onStaleAuthRelaunch ? (
            <button type="button" onClick={onStaleAuthRelaunch} className={cn(INLINE_BUTTON_CLASS, "text-[color:var(--telegram-link,var(--mini-accent))]")}>Reopen to edit</button>
          ) : null}
          {canClose ? (
            <button type="button" onClick={onClose} className={cn(INLINE_BUTTON_CLASS, "text-[color:var(--telegram-link,var(--mini-accent))]")}>Close</button>
          ) : null}
          {showStaleBotFallback ? (
            <a href={TELEGRAM_BOT_URL} target="_blank" rel="noopener noreferrer" className={cn(INLINE_BUTTON_CLASS, "text-[color:var(--telegram-link,var(--mini-accent))]")}>
              Open PharosWatchBot <ExternalLink className="h-4 w-4" aria-hidden="true" />
            </a>
          ) : null}
        </div>
      ) : null}
    </Callout>
  ) : null;
  // An expired session can never refresh, so its reopen banner replaces every other one.
  if (staleAuth?.sessionExpired) return staleAuthBanner;
  return <>{sessionBanner()}{staleAuthBanner}</>;

  function sessionBanner() {
    if (status === "loading" && !hasDisplayState) return <HomeSkeleton screenName={screenName} />;
    if (status === "loading") return <p className="sr-only" aria-live="polite">Refreshing your alerts.</p>;

    if (status === "stale" && hasDisplayState) {
      const time = refreshedAtMs == null
        ? null
        : new Date(refreshedAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      return (
        <Callout tone="warn" title="Couldn't refresh">
          <p>
            {message}
            {" "}
            {time ? <>Showing your settings from <span className="tabular-nums">{time}</span>. </> : null}
            Editing is paused until a refresh works.
          </p>
          {onRetry ? (
            <div className="mt-2 -ml-3">
              <button type="button" onClick={onRetry} className={cn(INLINE_BUTTON_CLASS, "text-[color:var(--telegram-link,var(--mini-accent))]")}>Try again</button>
            </div>
          ) : null}
        </Callout>
      );
    }

    if (status === "error") {
      return (
        <Callout tone="danger" title="Couldn't load your alerts" role="alert">
          <p>{message}</p>
          <div className="mt-2 -ml-3 flex flex-wrap">
            {onRetry ? (
              <button type="button" onClick={onRetry} className={cn(INLINE_BUTTON_CLASS, "text-[color:var(--telegram-link,var(--mini-accent))]")}>Try again</button>
            ) : retryAvailable ? null : canClose ? (
              <button type="button" onClick={onClose} className={cn(INLINE_BUTTON_CLASS, "text-[color:var(--telegram-link,var(--mini-accent))]")}>Close and reopen</button>
            ) : (
              <a href={TELEGRAM_BOT_URL} target="_blank" rel="noopener noreferrer" className={cn(INLINE_BUTTON_CLASS, "text-[color:var(--telegram-link,var(--mini-accent))]")}>
                Open PharosWatchBot <ExternalLink className="h-4 w-4" aria-hidden="true" />
              </a>
            )}
          </div>
        </Callout>
      );
    }

    return null;
  }
}
