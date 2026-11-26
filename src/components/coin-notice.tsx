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
import { daysUntilIsoDate, isSpentDeadline, noticeAppliesToScope } from "@shared/lib/coin-state";
import { formatDeviationBps, formatShortDate } from "@shared/lib/format";
import { CHAIN_META } from "@shared/types/chain-identity";
import type { CoinNotice, StablecoinLink } from "@shared/types/stablecoin-meta-primitives";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { useUtcDayNowMs } from "@/hooks/use-utc-day-clock";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";

type CalloutTone = "danger" | "caution" | "info" | "neutral";

const TYPE_TONES = { danger: "danger", warning: "caution", info: "info" } as const satisfies Record<CoinNotice["type"], CalloutTone>;
const TYPE_ICONS: Record<CoinNotice["type"], LucideIcon> = { danger: OctagonAlert, warning: AlertTriangle, info: Info };
const KIND_ICONS: Partial<Record<NonNullable<CoinNotice["kind"]>, LucideIcon>> = { paused: PauseCircle, deadline: CalendarClock };

const URL_REGEX = /https?:\/\/[^\s]+/g;
const URL_TRAILING_PUNCTUATION: ReadonlySet<string> = new Set([".", ",", ";", ":", "!", "?"]);

/**
 * A matched URL without the sentence around it: trailing punctuation and any
 * closing parenthesis the URL did not open stay prose, so
 * `(see https://x.org/a_(b)).` links `https://x.org/a_(b)`.
 */
function trimUrlMatch(raw: string): string {
  let unmatchedClose = 0;
  for (const char of raw) {
    if (char === "(") unmatchedClose -= 1;
    else if (char === ")") unmatchedClose += 1;
  }
  let end = raw.length;
  while (end > 0) {
    const char = raw[end - 1]!;
    if (URL_TRAILING_PUNCTUATION.has(char)) {
      end -= 1;
    } else if (char === ")" && unmatchedClose > 0) {
      unmatchedClose -= 1;
      end -= 1;
    } else {
      break;
    }
  }
  return raw.slice(0, end);
}

/** Notice prose with each URL folded into a "More details" link. */
function formatMessageWithLinks(message: string): ReactNode {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const [index, match] of Array.from(message.matchAll(URL_REGEX)).entries()) {
    const start = match.index ?? cursor;
    const url = trimUrlMatch(match[0]);
    if (start > cursor) nodes.push(message.slice(cursor, start));
    nodes.push(
      <a
        key={`${url}-${index}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="pharos-focus-ring inline-flex items-center gap-0.5 rounded-sm font-medium text-foreground underline underline-offset-2"
      >
        More details
        <ExternalLink aria-hidden="true" className="h-3 w-3" />
      </a>,
    );
    cursor = start + url.length;
  }
  if (cursor < message.length) nodes.push(message.slice(cursor));
  return nodes;
}

function formatNoticeDate(isoDate: string): string {
  return formatShortDate(new Date(`${isoDate}T00:00:00Z`), { utc: true });
}

/** A notice date in UTC and, once the reader's clock is known, how far off it is (`days`): "Jan 12, 2027 · in 47 days". */
export function formatNoticeDeadline(deadline: string, days: number | null): string {
  const date = formatNoticeDate(deadline);
  return days === null
    ? date
    : days < 0
      ? `Passed ${date}`
      : `${date} · ${days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`}`;
}

/**
 * The date holders must act by and, once the reader's clock is known, how far
 * off it is (`days`). A paused operation's date is when it closes ("Closes
 * Jan 31, 2027 · in 66 days"), and once passed when it closed ("Closed Jan 1, 2026").
 */
function DeadlineLine({ deadline, days, paused = false }: { deadline: string; days: number | null; paused?: boolean }) {
  const label = !paused
    ? formatNoticeDeadline(deadline, days)
    : days === null
      ? `Closes ${formatNoticeDate(deadline)}`
      : days < 0
        ? `Closed ${formatNoticeDate(deadline)}`
        : `Closes ${formatNoticeDeadline(deadline, days)}`;
  return <p className="mt-1 text-xs font-medium text-foreground" data-notice-deadline={deadline}>{label}</p>;
}

function chainName(chainId: string): string {
  return Object.hasOwn(CHAIN_META, chainId) ? CHAIN_META[chainId]!.name : chainId;
}

const CHAIN_SCOPE_PILL_CLASS = "rounded-full border border-border/70 bg-muted/60 px-2 py-0.5 text-2xs font-medium text-muted-foreground";
const CHAIN_SCOPE_VISIBLE = 2;

/** A chain-scoped notice's neutral scope pills: "Noble only", or two chain names and "+N". Never severity-tinted. */
function ChainScopePills({ chains }: { chains: readonly string[] | undefined }) {
  if (!chains?.length) return null;
  const names = chains.map(chainName);
  if (names.length === 1) {
    return <span className={CHAIN_SCOPE_PILL_CLASS} data-notice-chains={chains.join(" ")}>{names[0]} only</span>;
  }
  const hidden = names.slice(CHAIN_SCOPE_VISIBLE);
  return (
    <span className="inline-flex flex-wrap items-baseline gap-1" data-notice-chains={chains.join(" ")}>
      {names.slice(0, CHAIN_SCOPE_VISIBLE).map((name) => <span key={name} className={CHAIN_SCOPE_PILL_CLASS}>{name}</span>)}
      {hidden.length > 0 ? (
        <span className={CHAIN_SCOPE_PILL_CLASS} title={hidden.join(", ")}>
          +{hidden.length}
          <span className="sr-only">: {hidden.join(", ")}</span>
        </span>
      ) : null}
    </span>
  );
}

/** The one flat notice callout: hairline border, severity tint, leading icon, title, scope pills and kicker, then the body. */
function NoticeCallout({
  tone,
  Icon,
  title,
  scope,
  kicker,
  className,
  children,
}: {
  tone: CalloutTone;
  Icon: LucideIcon;
  title?: string;
  scope?: ReactNode;
  kicker?: string | null;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex items-start gap-3 rounded-lg border px-4 py-3", SEVERITY_TONE_CLASS[tone].banner, className)}>
      <Icon aria-hidden="true" className={cn("mt-0.5 h-4 w-4 shrink-0", SEVERITY_TONE_CLASS[tone].text)} />
      <div className="min-w-0 flex-1">
        {title || scope || kicker ? (
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {title ? (
              <span className={cn("text-sm font-semibold", tone === "danger" ? SEVERITY_TONE_CLASS.danger.text : "text-foreground")}>{title}</span>
            ) : null}
            {scope}
            {kicker ? <span className={cn("text-2xs font-medium", SEVERITY_TONE_CLASS[tone].text)}>{kicker}</span> : null}
          </p>
        ) : null}
        {children}
      </div>
    </div>
  );
}

const INLINE_SOURCE_LIMIT = 2;

function NoticeSourceLink({ source }: { source: StablecoinLink }) {
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      className="pharos-focus-ring inline-flex items-center gap-0.5 rounded-sm text-foreground underline underline-offset-2"
    >
      {source.label}
      <ExternalLink aria-hidden="true" className="h-3 w-3" />
    </a>
  );
}

/**
 * When the notice was last confirmed and what it rests on: one or two sources
 * sit beside the date (below it under `sm`); three or more fold into
 * "Sources (N)" so the callout stays short.
 */
function NoticeFooter({ notice }: { notice: CoinNotice }) {
  const sources = notice.sources ?? [];
  if (!notice.asOf && sources.length === 0) return null;
  const updated = notice.asOf ? <span className="text-2xs">Updated {formatNoticeDate(notice.asOf)}</span> : null;
  if (sources.length > INLINE_SOURCE_LIMIT) {
    return (
      <div className="mt-1.5 text-muted-foreground" data-notice-footer>
        {updated ? <p>{updated}</p> : null}
        <ModuleDisclosure label="Sources" count={sources.length} summaryClassName="text-xs min-h-11 lg:min-h-7">
          <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1.5 text-xs">
            {sources.map((source, index) => <li key={`${source.url}-${index}`}><NoticeSourceLink source={source} /></li>)}
          </ul>
        </ModuleDisclosure>
      </div>
    );
  }
  return (
    <div className="mt-1.5 flex flex-col gap-y-0.5 text-muted-foreground sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-3" data-notice-footer>
      {updated}
      {sources.length > 0 ? (
        <span className="inline-flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-xs">
          <span>{sources.length === 1 ? "Source:" : "Sources:"}</span>
          {sources.map((source, index) => <NoticeSourceLink key={`${source.url}-${index}`} source={source} />)}
        </span>
      ) : null}
    </div>
  );
}

function NoticeBody({ notice, dateLine }: { notice: CoinNotice; dateLine?: ReactNode }) {
  return (
    <>
      {dateLine}
      <p className="mt-1 text-pretty text-sm leading-relaxed text-foreground/80">{formatMessageWithLinks(notice.message)}</p>
      <NoticeFooter notice={notice} />
    </>
  );
}

/** Stable, collision-free keys: the notice's identity fields, with an ordinal only for exact duplicates. */
function noticeKeys(notices: readonly CoinNotice[]): string[] {
  const seen = new Map<string, number>();
  return notices.map((notice) => {
    const base = [notice.type, notice.kind ?? "", notice.deadline ?? "", notice.chains?.join(",") ?? "", notice.title].join("|");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}#${count}`;
  });
}

/**
 * The one renderer for curated coin notices (danger, warning, info). Each
 * notice is a flat callout in its type's tone, with its kind's kicker
 * ("Paused now", "Deadline"; a standing caveat has none) and "Action may be
 * needed" only on a stopped operation or a deadline the reader's clock puts
 * ahead. A deadline (or a paused operation's closing date) names its date and
 * countdown, a chain-scoped notice carries neutral scope pills, the footer
 * dates the text and lists its sources, and resolved `history` is a calm
 * folded record, never an alarm, as is a spent deadline ("Deadline passed
 * <date>") once that clock is known. `archive`
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
  const keys = noticeKeys(notices);
  return (
    <div className={cn("space-y-2", className)} data-notice-stack>
      {notices.map((notice, index) => {
        const key = keys[index]!;
        const deadline = notice.kind === "deadline" || notice.kind === "paused" ? notice.deadline : undefined;
        const days = deadline ? daysUntilIsoDate(deadline, nowSec) : null;
        // A deadline past its grace window is a past event; telling needs the reader's clock. A paused notice never retires by date.
        const spent = nowSec !== null && isSpentDeadline(notice, nowSec);
        if (notice.kind === "history" || spent) {
          const label = deadline && spent ? `Deadline passed ${formatNoticeDate(deadline)}` : COIN_NOTICE_KIND_LABELS.history;
          return (
            <div key={key} className={cn("rounded-lg border px-4", SEVERITY_TONE_CLASS.neutral.banner)} data-notice-kind="history">
              <ModuleDisclosure label={`${label}: ${notice.title}`}>
                <div className="pb-2">
                  {notice.chains?.length ? <p className="mt-1"><ChainScopePills chains={notice.chains} /></p> : null}
                  <NoticeBody notice={notice} />
                </div>
              </ModuleDisclosure>
            </div>
          );
        }
        const kindLabel = notice.kind ? COIN_NOTICE_KIND_LABELS[notice.kind] : null;
        // Holders are asked to act on a stopped operation, or on a deadline only once it is known to be ahead.
        const actionable = !archive && (notice.kind === "paused" || (notice.kind === "deadline" && days !== null && days >= 0));
        return (
          <NoticeCallout
            key={key}
            tone={archive ? "neutral" : TYPE_TONES[notice.type]}
            Icon={(notice.kind && KIND_ICONS[notice.kind]) ?? TYPE_ICONS[notice.type]}
            title={notice.title}
            scope={notice.chains?.length ? <ChainScopePills chains={notice.chains} /> : undefined}
            kicker={actionable ? `${kindLabel} · Action may be needed` : kindLabel}
          >
            <NoticeBody notice={notice} dateLine={deadline ? <DeadlineLine deadline={deadline} days={days} paused={notice.kind === "paused"} /> : null} />
          </NoticeCallout>
        );
      })}
    </div>
  );
}

/** The site chrome's notice (the paused live-data toast) shares the renderer. */
export { NoticeStack as CoinNotices };

const REST_TYPE_RANK = { danger: 0, warning: 1, info: 2 } as const satisfies Record<CoinNotice["type"], number>;

/**
 * A dossier's notices by place, in the coin-state precedence
 * (`shared/lib/coin-state.ts`): current asset-wide danger notices and paused
 * operations lead above the figures; under them come deadlines (earliest
 * first), standing warnings, then info, each otherwise in authored order, then
 * past events: resolved history, and deadlines the reader's clock (`nowSec`)
 * finds spent. Until that clock is known a deadline keeps its type's place,
 * so a live alarm never arrives late. A non-danger `depeg` notice drops while
 * the live depeg outlook supersedes it. A chain-scoped notice never leads.
 */
export function placeCoinNotices(
  notices: readonly CoinNotice[] | null | undefined,
  { liveDepeg = false, nowSec = null }: { liveDepeg?: boolean; nowSec?: number | null } = {},
): { critical: CoinNotice[]; paused: CoinNotice[]; rest: CoinNotice[] } {
  const past = (notice: CoinNotice) => notice.kind === "history" || (nowSec !== null && isSpentDeadline(notice, nowSec));
  const current = (notices ?? []).filter((notice) => !past(notice) && !(liveDepeg && notice.kind === "depeg" && notice.type !== "danger"));
  const critical = current.filter((notice) => notice.type === "danger" && noticeAppliesToScope(notice, null));
  const paused = current.filter((notice) => notice.type !== "danger" && notice.kind === "paused" && noticeAppliesToScope(notice, null));
  const placed = new Set([...critical, ...paused]);
  const remaining = current.filter((notice) => !placed.has(notice));
  // Array sorts are stable, so equal dates and types keep authored order.
  const deadlines = remaining
    .filter((notice) => notice.kind === "deadline" && notice.deadline !== undefined)
    .sort((a, b) => (a.deadline! < b.deadline! ? -1 : a.deadline! > b.deadline! ? 1 : 0));
  const standing = remaining
    .filter((notice) => !(notice.kind === "deadline" && notice.deadline !== undefined))
    .sort((a, b) => REST_TYPE_RANK[a.type] - REST_TYPE_RANK[b.type]);
  return { critical, paused, rest: [...deadlines, ...standing, ...(notices ?? []).filter(past)] };
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
