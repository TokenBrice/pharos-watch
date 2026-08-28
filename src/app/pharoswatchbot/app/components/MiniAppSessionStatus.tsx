"use client";

import { ExternalLink, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { STALE_AUTH_READ_ONLY_COPY } from "./StatusPanel";
import { HomeSkeleton } from "./HomeSkeleton";
import { MiniButton } from "./MiniButton";

const BOT_URL = "https://t.me/PharosWatchBot";

export type MiniAppSessionStatus = "preview" | "loading" | "ready" | "stale" | "error";

interface MiniAppSessionStatusProps {
  status: MiniAppSessionStatus;
  hasDisplayState: boolean;
  confirmedMeta: { revision: string; refreshedAtMs: number } | null;
  message: string | null;
  mutationRetryAfterSec: number;
  initData: string;
  canClose: boolean;
  showStaleAuthBanner: boolean;
  onRefresh: () => void;
  onClose: () => void;
  onStaleAuthRelaunch?: () => void;
}

export function MiniAppSessionStatus({
  status,
  hasDisplayState,
  confirmedMeta,
  message,
  mutationRetryAfterSec,
  initData,
  canClose,
  showStaleAuthBanner,
  onRefresh,
  onClose,
  onStaleAuthRelaunch,
}: MiniAppSessionStatusProps) {
  return (
    <>
      {status === "loading" && !hasDisplayState ? <HomeSkeleton /> : null}
      {status === "loading" && hasDisplayState ? <p className="sr-only" aria-live="polite">Refreshing settings. Editing is temporarily unavailable.</p> : null}
      {status === "stale" && hasDisplayState && confirmedMeta ? (
        <section role="status" aria-live="polite" className="mt-4 rounded-2xl border border-amber-500/35 bg-amber-500/10 p-4">
          <div className="flex gap-3">
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold text-foreground">Showing last-known settings</h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {message} Editing is read-only until Refresh succeeds.
              </p>
              <dl className="mt-2 grid gap-1 text-[11px] text-muted-foreground">
                <div className="flex min-w-0 gap-2">
                  <dt className="font-semibold text-foreground">Revision</dt>
                  <dd className="min-w-0 break-all font-mono">{confirmedMeta.revision}</dd>
                </div>
                <div className="flex min-w-0 gap-2">
                  <dt className="font-semibold text-foreground">Refreshed</dt>
                  <dd>
                    <time dateTime={new Date(confirmedMeta.refreshedAtMs).toISOString()}>
                      {new Date(confirmedMeta.refreshedAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </time>
                  </dd>
                </div>
              </dl>
              <div className="mt-3">
                <MiniButton variant="secondary" onClick={onRefresh}>Retry refresh</MiniButton>
              </div>
            </div>
          </div>
        </section>
      ) : null}
      {status === "error" ? (
        <section role="alert" className="mt-4 rounded-2xl border border-red-500/30 bg-red-500/10 p-4">
          <p className="text-sm font-semibold text-red-700 dark:text-red-300">{message}</p>
          <div className="mt-3">
            {initData ? (
              <MiniButton variant="secondary" onClick={onRefresh}>Retry</MiniButton>
            ) : canClose ? (
              <MiniButton variant="secondary" onClick={onClose}>Close and reopen</MiniButton>
            ) : (
              <Button asChild variant="outline" className="gap-2">
                <a href={BOT_URL} target="_blank" rel="noopener noreferrer">
                  Open PharosWatchBot <ExternalLink className="h-4 w-4" aria-hidden="true" />
                </a>
              </Button>
            )}
          </div>
        </section>
      ) : null}
      {message && status === "ready" ? <section role="status" className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-muted-foreground">{message}</section> : null}
      {mutationRetryAfterSec > 0 && status === "ready" ? (
        <section
          role="timer"
          aria-live="off"
          aria-atomic="true"
          className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-muted-foreground"
        >
          Pharos edit limit reached. Settings unlock in {mutationRetryAfterSec} {mutationRetryAfterSec === 1 ? "second" : "seconds"}.
        </section>
      ) : null}
      {showStaleAuthBanner ? (
        <section className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
          <div className="flex gap-3">
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" />
            <div>
              <h2 className="text-sm font-semibold text-foreground">{STALE_AUTH_READ_ONLY_COPY.title}</h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{STALE_AUTH_READ_ONLY_COPY.body}</p>
              {onStaleAuthRelaunch ? (
                <div className="mt-3">
                  <MiniButton variant="secondary" onClick={onStaleAuthRelaunch}>
                    Relaunch and keep this panel
                  </MiniButton>
                </div>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}
    </>
  );
}
