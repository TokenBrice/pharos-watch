"use client";

import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDown,
  CalendarClock,
  ExternalLink,
  Info,
  OctagonAlert,
  PauseCircle,
  type LucideIcon,
} from "lucide-react";
import { COIN_NOTICE_KIND_LABELS } from "@shared/lib/classification";
import { daysUntilIsoDate, isSpentDeadline } from "@shared/lib/coin-state";
import { formatDeviationBps, formatShortDate } from "@shared/lib/format";
import type { CoinNotice } from "@shared/types/stablecoin-meta-primitives";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { useUtcDayNowMs } from "@/hooks/use-utc-day-clock";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";

type CalloutTone = "danger" | "caution" | "info" | "neutral";

const TYPE_TONES = { danger: "danger", warning: "caution", info: "info" } as const satisfies Record<CoinNotice["type"], CalloutTone>;
const TYPE_ICONS: Record<CoinNotice["type"], LucideIcon> = { danger: OctagonAlert, warning: AlertTriangle, info: Info };
const KIND_ICONS: Partial<Record<NonNullable<CoinNotice["kind"]>, LucideIcon>> = { paused: PauseCircle, deadline: CalendarClock };

const URL_REGEX = /https?:\/\/[^\s]+/g;

/** Notice prose with each URL folded into a "More details" link. */
function formatMessageWithLinks(message: string): ReactNode {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const [index, match] of Array.from(message.matchAll(URL_REGEX)).entries()) {
    const start = match.index ?? cursor;
    if (start > cursor) nodes.push(message.slice(cursor, start));
    nodes.push(
      <a
        key={`${match[0]}-${index}`}
        href={match[0]}
        target="_blank"
        rel="noopener noreferrer"
        className="pharos-focus-ring inline-flex items-center gap-0.5 rounded-sm font-medium text-foreground underline underline-offset-2"
      >
        More details
        <ExternalLink aria-hidden="true" className="h-3 w-3" />
      </a>,
    );
    cursor = start + match[0].length;
  }
  if (cursor < message.length) nodes.push(message.slice(cursor));
  return nodes;
}

function formatNoticeDate(isoDate: string): string {
  return formatShortDate(new Date(`${isoDate}T00:00:00Z`), { utc: true });
}

/** The date holders must act by and, once the reader's clock is known, how far off it is (`days`). */
function DeadlineLine({ deadline, days }: { deadline: string; days: number | null }) {
  const date = formatNoticeDate(deadline);
  const text = days === null
    ? date
    : days < 0
      ? `Passed ${date}`
      : `${date} · ${days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`}`;
  return <p className="mt-1 text-xs font-medium text-foreground" data-notice-deadline={deadline}>{text}</p>;
}

/** The one flat notice callout: hairline border, severity tint, leading icon, title and kicker, then the body. */
function NoticeCallout({
  tone,
  Icon,
  title,
  kicker,
  className,
  children,
}: {
  tone: CalloutTone;
  Icon: LucideIcon;
  title?: string;
  kicker?: string | null;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex items-start gap-3 rounded-lg border px-4 py-3", SEVERITY_TONE_CLASS[tone].banner, className)}>
      <Icon aria-hidden="true" className={cn("mt-0.5 h-4 w-4 shrink-0", SEVERITY_TONE_CLASS[tone].text)} />
      <div className="min-w-0 flex-1">
        {title || kicker ? (
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {title ? (
              <span className={cn("text-sm font-semibold", tone === "danger" ? SEVERITY_TONE_CLASS.danger.text : "text-foreground")}>{title}</span>
            ) : null}
            {kicker ? <span className={cn("text-2xs font-medium", SEVERITY_TONE_CLASS[tone].text)}>{kicker}</span> : null}
          </p>
        ) : null}
        {children}
      </div>
    </div>
  );
}

function NoticeBody({ notice, dateLine }: { notice: CoinNotice; dateLine?: ReactNode }) {
  return (
    <>
      {dateLine}
      <p className="mt-1 text-pretty text-sm leading-relaxed text-foreground/80">{formatMessageWithLinks(notice.message)}</p>
      {notice.asOf ? <p className="mt-1.5 text-2xs text-muted-foreground">Updated {formatNoticeDate(notice.asOf)}</p> : null}
    </>
  );
}

/**
 * The one renderer for curated coin notices (danger, warning, info). Each
 * notice is a flat callout in its type's tone, with its kind's kicker
 * ("Paused now", "Deadline"; a standing caveat has none) and "Action may be
 * needed" only on a stopped operation or a deadline the reader's clock puts
 * ahead. A deadline names its date and countdown, `asOf` dates the text, and
 * resolved `history` is a calm folded record, never an alarm, as is a spent
 * deadline ("Deadline passed <date>") once that clock is known. `archive`
 * mutes every notice of a frozen coin to its record. Callers place the stacks
 * (see `placeCoinNotices`).
 */
export function NoticeStack({
  notices,
  archive = false,
  className,
}: {
  notices: readonly CoinNotice[];
  archive?: boolean;
  className?: string;
}) {
  const nowMs = useUtcDayNowMs();
  if (notices.length === 0) return null;
  const nowSec = nowMs === null ? null : nowMs / 1000;
  return (
    <div className={cn("space-y-2", className)} data-notice-stack>
      {notices.map((notice) => {
        const key = `${notice.type}-${notice.title}`;
        const deadline = notice.kind === "deadline" ? notice.deadline : undefined;
        const days = deadline ? daysUntilIsoDate(deadline, nowSec) : null;
        // A deadline past its grace window is a past event; telling needs the reader's clock.
        const spent = nowSec !== null && isSpentDeadline(notice, nowSec);
        if (notice.kind === "history" || spent) {
          const label = deadline && spent ? `Deadline passed ${formatNoticeDate(deadline)}` : COIN_NOTICE_KIND_LABELS.history;
          return (
            <div key={key} className={cn("rounded-lg border px-4", SEVERITY_TONE_CLASS.neutral.banner)} data-notice-kind="history">
              <ModuleDisclosure label={`${label}: ${notice.title}`}>
                <div className="pb-2">
                  <NoticeBody notice={notice} />
                </div>
              </ModuleDisclosure>
            </div>
          );
        }
        const kindLabel = notice.kind ? COIN_NOTICE_KIND_LABELS[notice.kind] : null;
        // Holders are asked to act on a stopped operation, or on a deadline only once it is known to be ahead.
        const actionable = !archive && (notice.kind === "paused" || (days !== null && days >= 0));
        return (
          <NoticeCallout
            key={key}
            tone={archive ? "neutral" : TYPE_TONES[notice.type]}
            Icon={(notice.kind && KIND_ICONS[notice.kind]) ?? TYPE_ICONS[notice.type]}
            title={notice.title}
            kicker={actionable ? `${kindLabel} · Action may be needed` : kindLabel}
          >
            <NoticeBody notice={notice} dateLine={deadline ? <DeadlineLine deadline={deadline} days={days} /> : null} />
          </NoticeCallout>
        );
      })}
    </div>
  );
}

/** The site chrome's notice (the paused live-data toast) shares the renderer. */
export { NoticeStack as CoinNotices };

/**
 * A dossier's notices by place, in the coin-state precedence
 * (`shared/lib/coin-state.ts`): current danger notices and paused operations
 * lead above the figures; deadlines, standing caveats and info sit under them,
 * then past events: resolved history, and deadlines the reader's clock
 * (`nowSec`) finds spent. Until that clock is known a deadline keeps its
 * type's place, so a live alarm never arrives late. A non-danger `depeg`
 * notice drops while the live depeg outlook supersedes it.
 */
export function placeCoinNotices(
  notices: readonly CoinNotice[] | null | undefined,
  { liveDepeg = false, nowSec = null }: { liveDepeg?: boolean; nowSec?: number | null } = {},
): { critical: CoinNotice[]; paused: CoinNotice[]; rest: CoinNotice[] } {
  const past = (notice: CoinNotice) => notice.kind === "history" || (nowSec !== null && isSpentDeadline(notice, nowSec));
  const current = (notices ?? []).filter((notice) => !past(notice) && !(liveDepeg && notice.kind === "depeg" && notice.type !== "danger"));
  return {
    critical: current.filter((notice) => notice.type === "danger"),
    paused: current.filter((notice) => notice.type !== "danger" && notice.kind === "paused"),
    rest: [
      ...current.filter((notice) => notice.type !== "danger" && notice.kind !== "paused"),
      ...(notices ?? []).filter(past),
    ],
  };
}

/**
 * What the alert can say about the Depeg Duration Resolver: its book is still
 * loading, the resolver's own word for a break it has not forecast ("Forecast
 * not locked yet"), the book could not be read, or (null) nothing to point to.
 */
export type ActiveDepegForecast = { read: "pending" } | { read: "state"; label: string } | { read: "unavailable" } | null;

function describeDepegForecast(forecast: NonNullable<ActiveDepegForecast>): { kicker: string; message: string } {
  if (forecast.read === "pending") {
    return { kicker: "Loading forecast", message: "Reading the Depeg Duration Resolver's published forecast." };
  }
  if (forecast.read === "unavailable") {
    return { kicker: "Forecast unavailable", message: "The Depeg Duration Resolver could not be read." };
  }
  return { kicker: forecast.label, message: "The Depeg Duration Resolver has not published a forecast for this break." };
}

/**
 * The plain active-depeg alert: the live deviation (known synchronously) and
 * what the resolver has published. It stands in for the first-fold outlook
 * while its chunk or book loads (holding the panel's footprint) and when no
 * forecast is locked, and links to the full resolver card.
 */
export function ActiveDepegAlert({
  symbol,
  deviationBps,
  forecast,
}: {
  symbol: string;
  deviationBps: number | null;
  forecast: ActiveDepegForecast;
}) {
  const copy = forecast ? describeDepegForecast(forecast) : null;
  const title = deviationBps != null && Number.isFinite(deviationBps) && deviationBps !== 0
    ? `${symbol} is trading ${formatDeviationBps(deviationBps)} ${deviationBps < 0 ? "below" : "above"} its peg`
    : `${symbol} is trading off its peg`;
  return (
    <NoticeCallout
      tone="caution"
      Icon={AlertTriangle}
      title={title}
      kicker={copy?.kicker}
      className={forecast?.read === "pending" ? "min-h-44 sm:min-h-36" : undefined}
    >
      <div data-active-depeg-alert={forecast?.read ?? "none"}>
        <p className="mt-1 text-pretty text-sm leading-relaxed text-foreground/80">{copy?.message ?? "A depeg is in progress."}</p>
        {copy ? (
          // The full resolver card's wrapper in the Risk zone.
          <a
            href="#depeg-resolver"
            className="pharos-focus-ring mt-1.5 inline-flex items-center gap-1 rounded-sm text-sm font-medium text-foreground underline-offset-2 hover:underline"
          >
            See the resolver evidence
            <ArrowDown aria-hidden="true" className="h-3.5 w-3.5" />
          </a>
        ) : null}
      </div>
    </NoticeCallout>
  );
}
