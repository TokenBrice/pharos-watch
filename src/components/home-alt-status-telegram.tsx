"use client";

import Link from "next/link";
import { Send, SquareArrowRight } from "lucide-react";

import { useTelegramPulse } from "@/hooks/api-hooks";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatDecimal } from "@shared/lib/format";
import { TELEGRAM_METRIC_SEMANTICS } from "@shared/lib/telegram-metrics";

const LINE_LINK_CLASS =
  "pharos-focus-ring group flex min-w-0 items-center gap-2 rounded-md py-0.5 transition-colors";

const ARROW_CLASS =
  "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-foreground";

/**
 * Left line: a plain entry point to /status/. The homepage never renders
 * data-health state (docs/homepage.md#data-health); the status page owns it.
 */
function StatusLine(): React.JSX.Element {
  return (
    <Link href="/status/" prefetch={false} className={cn(LINE_LINK_CLASS, "text-muted-foreground hover:text-foreground")}>
      <span className="text-sm">System status</span>
      <SquareArrowRight aria-hidden="true" className={ARROW_CLASS} strokeWidth={2} />
    </Link>
  );
}

/** Right line: public Telegram watcher pulse as a single clickable line → /pharoswatchbot/. */
function TelegramLine(): React.JSX.Element {
  const { data: pulse, isLoading, isError } = useTelegramPulse();

  if (isLoading) return <Skeleton className="h-5 w-44" />;
  if (!pulse || isError) {
    return (
      <Link
        href="/pharoswatchbot/"
        prefetch={false}
        className={cn(LINE_LINK_CLASS, "text-muted-foreground hover:text-foreground")}
      >
        <Send aria-hidden="true" className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
        <span className="text-sm">Telegram alerts</span>
        <SquareArrowRight aria-hidden="true" className={ARROW_CLASS} strokeWidth={2} />
      </Link>
    );
  }

  return (
    <Link href="/pharoswatchbot/" prefetch={false} className={cn(LINE_LINK_CLASS, "text-foreground hover:text-frost-blue")}>
      <Send
        aria-hidden="true"
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
        strokeWidth={2}
      />
      <span className="pharos-numeric shrink-0 text-sm font-semibold">{formatDecimal(pulse.activeWatchers, 0, 3)}</span>
      <span className="shrink-0 text-sm text-muted-foreground" title={TELEGRAM_METRIC_SEMANTICS.activeWatchers.description}>
        {TELEGRAM_METRIC_SEMANTICS.activeWatchers.label.toLowerCase()}
      </span>
      <span aria-hidden="true" className="text-muted-foreground/40">·</span>
      <span className="pharos-numeric shrink-0 text-sm font-semibold">
        {pulse.coinSubscriptions == null ? "—" : formatDecimal(pulse.coinSubscriptions, 0, 3)}
      </span>
      <span className="shrink-0 text-sm text-muted-foreground" title={TELEGRAM_METRIC_SEMANTICS.coinFollows.description}>
        {TELEGRAM_METRIC_SEMANTICS.coinFollows.label.toLowerCase()}
      </span>
      <SquareArrowRight aria-hidden="true" className={ARROW_CLASS} strokeWidth={2} />
    </Link>
  );
}

// A slim, one-to-two-line status bar: system health on the left, the public
// Telegram watcher pulse on the right. Wraps to two stacked lines below sm.
export function HomeAltStatusTelegram(): React.JSX.Element {
  return (
    <section aria-labelledby="home-alt-status-telegram-title">
      <h2 id="home-alt-status-telegram-title" className="sr-only">
        System status and Telegram watcher pulse
      </h2>
      <div className="pharos-card-shell flex flex-col gap-x-4 gap-y-1.5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <StatusLine />
        <TelegramLine />
      </div>
    </section>
  );
}
